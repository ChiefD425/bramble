// The retention sweep: hourly on the Node server, a cron trigger on the hosted one. Idempotent,
// and ordered as docs/mailbox-service.md ("Retention") and the plan describe. Rows go before bodies,
// so a crash leaves orphans for the next pass, never an early deletion.

import { and, eq, gte, inArray, isNotNull, lt, lte, notExists, sql } from "drizzle-orm";
import type { AppDeps } from "./app.ts";
import { blobKey, messageKey } from "./bodies.ts";
import { deleteMailbox } from "./cleanup.ts";
import {
	blobDeliveries,
	blobs,
	deliveries,
	expiryMarkers,
	mailboxes,
	members,
	messages,
	sweepState,
} from "./schema.ts";
import { IN_LIST } from "./sql.ts";
import { DAY_MS, dayOf } from "./time.ts";

/** A body younger than this may belong to a post whose row is not written yet. */
export const ORPHAN_GRACE_MS = 3_600_000;

/** D1 queries each expiry step may make in one run, so a backlog in one can't starve the others; a
 * step's unused share carries on to the next. With the orphan pass's own, under the 1,000 a Worker
 * invocation may make. R2 calls aren't counted: each follows a counted delete or lists a page, far
 * inside the 10,000 subrequests an invocation has. */
export const STEP_QUERIES = { messages: 240, blobs: 120, markers: 1, mailboxes: 120, strays: 119 };
export type SweepStep = keyof typeof STEP_QUERIES;
export const SWEEP_QUERIES = Object.values(STEP_QUERIES).reduce((a, b) => a + b, 0);
export const ORPHAN_QUERIES = 300;
/** Bodies one run's orphan pass lists, from where the last one stopped. */
export const ORPHAN_KEYS_PER_RUN = 10_000;
const ORPHAN_CURSOR = "orphans";

export interface SweepReport {
	messages: number;
	blobs: number;
	markers: number;
	mailboxes: number;
	orphans: number;
	/** A budget ran out: the next run carries on. */
	more: boolean;
}

/** The budgets, which tests shrink. */
export interface SweepOptions {
	steps?: Partial<Record<SweepStep, number>>;
	orphanQueries?: number;
	batchSize?: number;
	orphanKeys?: number;
}

const KEY = /^(m|b)\/([^/]+)\/([^/]+)$/;

function byMailbox<T extends { mailboxId: string }>(rows: T[]): Map<string, T[]> {
	const out = new Map<string, T[]>();
	for (const row of rows) out.set(row.mailboxId, [...(out.get(row.mailboxId) ?? []), row]);
	return out;
}

export async function sweep(deps: AppDeps, opts: SweepOptions = {}): Promise<SweepReport> {
	const { db, bodies } = deps;
	const now = deps.now();
	const cutoff = now - deps.config.retentionMaxDays * DAY_MS;
	const batchSize = Math.min(opts.batchSize ?? IN_LIST, IN_LIST);
	const orphanKeys = opts.orphanKeys ?? ORPHAN_KEYS_PER_RUN;
	const report: SweepReport = {
		messages: 0,
		blobs: 0,
		markers: 0,
		mailboxes: 0,
		orphans: 0,
		more: false,
	};
	/** `take(n)` before a step that makes n queries; false once they don't fit, and the run says so. */
	const budget = (left: number) => (n: number) => {
		if (n > left) {
			report.more = true;
			return false;
		}
		left -= n;
		return true;
	};
	let stepLeft = 0;
	/** Open a step: its share joins whatever the steps before it left. */
	const begin = (step: SweepStep) => {
		stepLeft += opts.steps?.[step] ?? STEP_QUERIES[step];
	};
	const take = (n: number) => {
		if (n > stepLeft) {
			report.more = true;
			return false;
		}
		stepLeft -= n;
		return true;
	};
	const takeOrphan = budget(opts.orphanQueries ?? ORPHAN_QUERIES);

	/** A marker per recipient and sender that missed these messages, added to any already there.
	 * Two statements however many pairs, so a batch's cost is known before it starts. */
	async function addMarkers(mailboxId: string, ids: string[]) {
		const list = sql.join(
			ids.map((id) => sql`${id}`),
			sql`, `,
		);
		await db.run(sql`
			with missed as (
				select d.member as member, m.sender as sender, count(*) as n
				from deliveries d join messages m on m.mailbox_id = d.mailbox_id and m.id = d.message_id
				where d.mailbox_id = ${mailboxId} and d.message_id in (${list})
				group by d.member, m.sender
			)
			update expiry_markers set "count" = expiry_markers."count" + missed.n, expired_at = ${now}
			from missed
			where expiry_markers.mailbox_id = ${mailboxId}
				and expiry_markers.member = missed.member and expiry_markers.sender = missed.sender`);
		await db.run(sql`
			insert into expiry_markers (mailbox_id, member, sender, "count", expired_at)
			select d.mailbox_id, d.member, m.sender, count(*), ${now}
			from deliveries d join messages m on m.mailbox_id = d.mailbox_id and m.id = d.message_id
			where d.mailbox_id = ${mailboxId} and d.message_id in (${list})
				and not exists (
					select 1 from expiry_markers e
					where e.mailbox_id = d.mailbox_id and e.member = d.member and e.sender = m.sender
				)
			group by d.member, m.sender`);
	}

	async function deleteMessages(mailboxId: string, ids: string[]): Promise<number> {
		const gone = await db
			.delete(messages)
			.where(and(eq(messages.mailboxId, mailboxId), inArray(messages.id, ids)))
			.returning({ id: messages.id });
		await bodies.deleteMany(gone.map(({ id }) => messageKey(mailboxId, id)));
		return gone.length;
	}

	async function deleteBlobs(mailboxId: string, hashes: string[]): Promise<number> {
		const gone = await db
			.delete(blobs)
			.where(and(eq(blobs.mailboxId, mailboxId), inArray(blobs.hash, hashes)))
			.returning({ hash: blobs.hash });
		await bodies.deleteMany(gone.map(({ hash }) => blobKey(mailboxId, hash)));
		return gone.length;
	}

	// 1. Expired messages: a marker per (recipient, sender) that missed one, then the messages.
	begin("messages");
	expiring: for (;;) {
		if (!take(1)) break;
		const expired = await db
			.select({ mailboxId: messages.mailboxId, id: messages.id })
			.from(messages)
			.where(lte(messages.expiresAt, now))
			.limit(batchSize);
		if (expired.length === 0) break;
		for (const [mailboxId, rows] of byMailbox(expired)) {
			if (!take(3)) break expiring;
			const ids = rows.map((r) => r.id);
			await addMarkers(mailboxId, ids);
			report.messages += await deleteMessages(mailboxId, ids);
		}
	}

	// 2. Expired blobs. No marker: a returning device wants what its manifest names.
	begin("blobs");
	expiringBlobs: for (;;) {
		if (!take(1)) break;
		const expired = await db
			.select({ mailboxId: blobs.mailboxId, hash: blobs.hash })
			.from(blobs)
			.where(lte(blobs.expiresAt, now))
			.limit(batchSize);
		if (expired.length === 0) break;
		for (const [mailboxId, rows] of byMailbox(expired)) {
			if (!take(1)) break expiringBlobs;
			report.blobs += await deleteBlobs(
				mailboxId,
				rows.map((r) => r.hash),
			);
		}
	}

	// 3. Markers older than the ceiling.
	begin("markers");
	if (take(1)) {
		const oldMarkers = await db
			.delete(expiryMarkers)
			.where(lt(expiryMarkers.expiredAt, cutoff))
			.returning({ id: expiryMarkers.id });
		report.markers += oldMarkers.length;
	}

	// 4. Mailboxes no member has checked in to for the ceiling (a never-checked member counts from
	// the mailbox's creation). The foreign keys cascade every row; the bodies follow.
	begin("mailboxes");
	abandoning: for (;;) {
		if (!take(1)) break;
		const abandoned = await db
			.select({ id: mailboxes.id })
			.from(mailboxes)
			.where(
				and(
					lt(mailboxes.createdAt, cutoff),
					notExists(
						db
							.select({ one: sql`1` })
							.from(members)
							.where(
								and(
									eq(members.mailboxId, mailboxes.id),
									isNotNull(members.lastCheckedDay),
									gte(members.lastCheckedDay, dayOf(cutoff)),
								),
							),
					),
				),
			)
			.limit(batchSize);
		if (abandoned.length === 0) break;
		for (const { id } of abandoned) {
			if (!take(3)) break abandoning;
			await deleteMailbox(deps, id);
			report.mailboxes++;
		}
	}

	// 5. Leftovers: rows with no deliveries, old enough not to be a post still being written.
	begin("strays");
	const settled = now - ORPHAN_GRACE_MS;
	strayMessages: for (;;) {
		if (!take(1)) break;
		const stray = await db
			.select({ mailboxId: messages.mailboxId, id: messages.id })
			.from(messages)
			.where(
				and(
					lt(messages.createdAt, settled),
					notExists(
						db
							.select({ one: sql`1` })
							.from(deliveries)
							.where(
								and(
									eq(deliveries.mailboxId, messages.mailboxId),
									eq(deliveries.messageId, messages.id),
								),
							),
					),
				),
			)
			.limit(batchSize);
		if (stray.length === 0) break;
		for (const [mailboxId, rows] of byMailbox(stray)) {
			if (!take(1)) break strayMessages;
			report.messages += await deleteMessages(
				mailboxId,
				rows.map((r) => r.id),
			);
		}
	}
	strayBlobs: for (;;) {
		if (!take(1)) break;
		const stray = await db
			.select({ mailboxId: blobs.mailboxId, hash: blobs.hash })
			.from(blobs)
			.where(
				and(
					lt(blobs.createdAt, settled),
					notExists(
						db
							.select({ one: sql`1` })
							.from(blobDeliveries)
							.where(
								and(
									eq(blobDeliveries.mailboxId, blobs.mailboxId),
									eq(blobDeliveries.hash, blobs.hash),
								),
							),
					),
				),
			)
			.limit(batchSize);
		if (stray.length === 0) break;
		for (const [mailboxId, rows] of byMailbox(stray)) {
			if (!take(1)) break strayBlobs;
			report.blobs += await deleteBlobs(
				mailboxId,
				rows.map((r) => r.hash),
			);
		}
	}

	// 6. Orphan bodies: no row, and old enough not to be a post still being written. Asked of D1 a
	// mailbox's run of keys at a time (stores list in key order), on a budget of its own so an
	// expiry backlog can't starve it. A run lists at most `orphanKeys` from where the last one
	// stopped, and records its place after each run of keys it settles, so a run cut short carries
	// on from there; the pass wraps to the start once a run reaches the end.
	if (!takeOrphan(1)) return report;
	const position = await db
		.select({ value: sweepState.value })
		.from(sweepState)
		.where(eq(sweepState.name, ORPHAN_CURSOR))
		.get();
	type Run = { kind: string; mailboxId: string; entries: { key: string; name: string }[] };
	let run: Run | null = null;
	let doomed: string[] = [];
	let saved = position?.value;
	async function settle(batch: Run) {
		const names = batch.entries.map((e) => e.name);
		const held =
			batch.kind === "m"
				? await db
						.select({ name: messages.id })
						.from(messages)
						.where(and(eq(messages.mailboxId, batch.mailboxId), inArray(messages.id, names)))
				: await db
						.select({ name: blobs.hash })
						.from(blobs)
						.where(and(eq(blobs.mailboxId, batch.mailboxId), inArray(blobs.hash, names)));
		const owned = new Set(held.map((r) => r.name));
		for (const { key, name } of batch.entries) if (!owned.has(name)) doomed.push(key);
	}
	/** Settle the pending run, delete what it found, and record `place` as where the next run
	 * starts (undefined: the beginning). False, with nothing done, when the budget can't cover it. */
	async function keepPlace(place: string | undefined): Promise<boolean> {
		if (!takeOrphan((run ? 1 : 0) + (place === saved ? 0 : 1))) return false;
		if (run) await settle(run);
		run = null;
		if (doomed.length > 0) {
			await bodies.deleteMany(doomed);
			report.orphans += doomed.length;
			doomed = [];
		}
		if (place === saved) return true;
		if (place === undefined) {
			await db.delete(sweepState).where(eq(sweepState.name, ORPHAN_CURSOR));
		} else {
			await db
				.insert(sweepState)
				.values({ name: ORPHAN_CURSOR, value: place })
				.onConflictDoUpdate({ target: sweepState.name, set: { value: place } });
		}
		saved = place;
		return true;
	}
	let listed = 0;
	let last = position?.value;
	let ended = true;
	for await (const { key, modifiedAt } of bodies.keys(position?.value)) {
		if (listed >= orphanKeys) {
			ended = false;
			break;
		}
		listed++;
		if (modifiedAt <= settled) {
			const parsed = KEY.exec(key);
			if (!parsed) {
				doomed.push(key);
			} else {
				const [, kind = "", mailboxId = "", name = ""] = parsed;
				if (
					run &&
					(run.kind !== kind || run.mailboxId !== mailboxId || run.entries.length >= IN_LIST) &&
					!(await keepPlace(last))
				) {
					return report;
				}
				run ??= { kind, mailboxId, entries: [] };
				run.entries.push({ key, name });
			}
		}
		last = key;
	}
	if (!ended) report.more = true;
	await keepPlace(ended ? undefined : last);

	return report;
}
