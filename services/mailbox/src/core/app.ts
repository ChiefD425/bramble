// The mailbox server as one Hono app, the same on Node and Workers; storage and payment differences
// arrive through AppDeps. See docs/mailbox-service.md.

import {
	type AccountStatusResponse,
	type ErrorResponse,
	HEADERS,
} from "@vault/core/src/sync/mailbox/protocol.ts";
import type { BaseSQLiteDatabase } from "drizzle-orm/sqlite-core";
import { type Context, Hono, type Next } from "hono";
import { cors } from "hono/cors";
import { HttpError, signedRequest, tokenGate } from "./auth.ts";
import { blobRoutes } from "./blobs.ts";
import type { BodyStore } from "./bodies.ts";
import { rootMessage } from "./errors.ts";
import { isMember, mailboxRoutes } from "./mailboxes.ts";
import { messageRoutes } from "./messages.ts";
import type * as schema from "./schema.ts";

// better-sqlite3 (sync) and D1 (async) both fit; every call is awaited.
export type Db = BaseSQLiteDatabase<any, any, typeof schema>;

/** What the hosted service decides and a self-hosted one answers plainly (see entitlement.ts). */
export interface Entitlement {
	/** Whether a mailbox may take new posts and uploads. Collecting is never gated. */
	canPost(mailboxId: string): Promise<boolean>;
	/** What a post to this mailbox counts against, and what that already holds. */
	usage(mailboxId: string): Promise<{ usedBytes: number; quotaBytes: number | null }>;
	/** A mailbox is being created, or moved (`mailboxId`), with the account header if one was
	 * sent: the account it belongs to, or null for none. Throws HttpError to refuse it. A mailbox
	 * being moved never counts against the account it moves to. */
	admit(account: string | undefined, mailboxId?: string): Promise<string | null>;
	/** Whether the account now holds more mailboxes than it may. Asked again after a create or a
	 * move is written, since requests in flight together all pass `admit`'s count. */
	overMailboxCap?(accountId: string): Promise<boolean>;
}

export interface AppDeps {
	db: Db;
	bodies: BodyStore;
	entitlement: Entitlement;
	now: () => number;
	config: { retentionMaxDays: number; token: string | null };
	/** false: refuse with 429 rate_limited. Absent on the self-hosted server. */
	limit?(key: string): Promise<boolean>;
	/** Hosted only. false: refuse a request carrying an account number from this address with 429,
	 * before any account is looked up. */
	limitAddress?(address: string): Promise<boolean>;
	/** Hosted only: an account's status by its number, or null for none. */
	accounts?: { status(number: string): Promise<AccountStatusResponse | null> };
}

export type Env = { Variables: { sigKey: string; contentSha256: string } };

export function createApp(deps: AppDeps) {
	const app = new Hono<Env>();
	app.onError((err, c) => {
		if (err instanceof HttpError) {
			const body: ErrorResponse = { error: err.code };
			if (err.serverTime !== undefined) body.serverTime = err.serverTime;
			return c.json(body, err.status);
		}
		// The message alone, never the request: no path, header or key reaches a log.
		console.error(`mailbox error: ${rootMessage(err)}`);
		return c.body(null, 500);
	});
	app.notFound((c) => c.json({ error: "not_found" } satisfies ErrorResponse, 404));
	app.get("/health", (c) => c.text("ok"));
	// Browser clients (the mobile app's web build): requests carry a signature, never cookies, so
	// any origin may ask. First, so a preflight never meets the signature check.
	app.use(
		"/v1/*",
		cors({
			origin: "*",
			allowMethods: ["GET", "POST", "PUT", "PATCH"],
			allowHeaders: [...Object.values(HEADERS), "content-type"],
			maxAge: 600,
		}),
	);
	const { limitAddress } = deps;
	if (limitAddress) {
		// Guessing account numbers costs a lookup each, so it is limited before one, by address.
		app.use("/v1/*", async (c, next) => {
			const address = c.req.header("cf-connecting-ip") ?? "";
			if (c.req.header(HEADERS.account) && !(await limitAddress(address))) {
				throw new HttpError(429, "rate_limited");
			}
			await next();
		});
	}
	const tokens = tokenGate(deps.config.token);
	const signed = signedRequest(deps.now);
	app.use("/v1/*", async (c, next) => {
		// Account routes carry the account number in a signature's place.
		if (c.req.path.startsWith("/v1/accounts/")) return next();
		await tokens(c, () => signed(c, next).then(() => {}));
	});
	// After the signature: members spend their mailbox's tokens, and anyone else (a removed device
	// included) a bucket of their own, so they can't use up the group's.
	const { limit } = deps;
	if (limit) {
		const limited = async (c: Context<Env>, next: Next) => {
			const id = c.req.param("id") ?? "";
			const bucket = (await isMember(deps.db, id, c.var.sigKey)) ? "mailbox" : "outsider";
			if (!(await limit(`${bucket}:${id}`))) throw new HttpError(429, "rate_limited");
			await next();
		};
		app.use("/v1/mailboxes/:id/*", limited);
		app.use("/v1/mailboxes/:id", limited);
	}
	const { accounts } = deps;
	if (accounts) {
		// The number in a header, never the URL, so it cannot land in a log line.
		app.get("/v1/accounts/status", async (c) => {
			const number = c.req.header(HEADERS.account);
			if (!number) throw new HttpError(402, "account_required");
			const status = await accounts.status(number);
			if (!status) throw new HttpError(403, "account_unknown");
			return c.json(status);
		});
	}
	app.route("/v1/mailboxes", mailboxRoutes(deps));
	app.route("/v1/mailboxes", messageRoutes(deps));
	app.route("/v1/mailboxes", blobRoutes(deps));
	return app;
}
