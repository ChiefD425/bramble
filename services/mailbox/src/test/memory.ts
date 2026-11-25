// Test-only: the in-memory server on a fake clock. Kept apart from harness.ts, which imports
// vitest, so serve.ts can run it under plain Node for client tests in other packages.

import {
	type AccountStatusResponse,
	parseAccountNumber,
	sha256Hex,
} from "@vault/core/src/sync/mailbox/protocol.ts";
import { type AppDeps, createApp, type Db, type Entitlement } from "../core/app.ts";
import { HttpError } from "../core/auth.ts";
import { type BodyStore, HashMismatchError } from "../core/bodies.ts";
import { selfHostedEntitlement } from "../core/entitlement.ts";
import { accounts as accountRows } from "../core/schema.ts";
import { openDb } from "../node/db.ts";

async function collect(body: ReadableStream<Uint8Array> | Uint8Array): Promise<Uint8Array> {
	if (body instanceof Uint8Array) return body;
	return new Uint8Array(await new Response(body).arrayBuffer());
}

/** `now` stamps modifiedAt; the harness passes its fake clock so orphan ages line up with the server's. */
export function memoryBodies(now: () => number = Date.now): BodyStore {
	const store = new Map<string, { bytes: Uint8Array; modifiedAt: number }>();
	return {
		async put(key, body, opts) {
			const bytes = await collect(body);
			if (opts?.sha256 && (await sha256Hex(bytes)) !== opts.sha256) throw new HashMismatchError();
			store.set(key, { bytes, modifiedAt: now() });
		},
		async get(key) {
			const hit = store.get(key);
			if (!hit) return null;
			return {
				body: new Response(hit.bytes as Uint8Array<ArrayBuffer>).body!,
				size: hit.bytes.length,
			};
		},
		async delete(key) {
			store.delete(key);
		},
		async deleteMany(keys) {
			for (const key of keys) store.delete(key);
		},
		async *keys(startAfter) {
			const sorted = [...store.keys()].sort();
			for (const key of sorted) {
				const held = store.get(key);
				if (held && (startAfter === undefined || key > startAfter))
					yield { key, modifiedAt: held.modifiedAt };
			}
		},
	};
}

export interface ServerOpts {
	quotaBytes?: number;
	token?: string;
	retentionMaxDays?: number;
	canPost?: boolean;
	/** Wraps the in-memory body store, e.g. with gatedBodies. */
	wrapBodies?: (inner: BodyStore) => BodyStore;
	/** Replaces parts of the self-hosted entitlement, as the hosted one would. */
	entitlement?: Partial<Entitlement>;
	limit?: (key: string) => Promise<boolean>;
	limitAddress?: (address: string) => Promise<boolean>;
	/** Hosted, as the Worker is: these accounts by their 25 digits, each `acct_<digits>`. */
	accounts?: Record<string, AccountStatusResponse>;
}

/** A hosted service's accounts, faked: admission and status by number, nothing else. */
function fakeAccounts(db: Db, known: Record<string, AccountStatusResponse>) {
	const digitsOf = (header: string | undefined) => {
		const digits = header ? parseAccountNumber(header)?.replace(/ /g, "") : undefined;
		return digits && known[digits] ? digits : null;
	};
	return {
		admit: async (header: string | undefined) => {
			if (!header) throw new HttpError(402, "account_required");
			const digits = digitsOf(header);
			if (!digits) throw new HttpError(403, "account_unknown");
			const status = known[digits] as AccountStatusResponse;
			// The row a mailbox's account id refers to, made when the account is first used.
			await db
				.insert(accountRows)
				.values({
					id: `acct_${digits}`,
					keyHash: `test-${digits}`,
					paidThrough: status.paidThrough,
					frozen: status.frozen,
					createdAt: 0,
				})
				.onConflictDoNothing();
			return `acct_${digits}`;
		},
		status: async (number: string) => {
			const digits = digitsOf(number);
			return digits ? (known[digits] ?? null) : null;
		},
	};
}

export function makeServer(opts: ServerOpts = {}) {
	const clock = { now: 1_800_000_000_000 };
	const { db } = openDb(":memory:");
	const selfHosted = selfHostedEntitlement(db, opts.quotaBytes ?? null);
	const hosted = opts.accounts ? fakeAccounts(db, opts.accounts) : null;
	const deps: AppDeps = {
		db,
		bodies: (opts.wrapBodies ?? ((b) => b))(memoryBodies(() => clock.now)),
		entitlement: {
			...selfHosted,
			// Read per call: serve.ts flips it from a test route.
			canPost: async () => opts.canPost ?? true,
			...(hosted ? { admit: hosted.admit } : {}),
			...opts.entitlement,
		},
		now: () => clock.now,
		config: {
			retentionMaxDays: opts.retentionMaxDays ?? 365,
			token: opts.token ?? null,
		},
		...(opts.limit ? { limit: opts.limit } : {}),
		...(opts.limitAddress ? { limitAddress: opts.limitAddress } : {}),
		...(hosted ? { accounts: { status: hosted.status } } : {}),
	};
	return { app: createApp(deps), deps, clock };
}

export type TestServer = ReturnType<typeof makeServer>;
