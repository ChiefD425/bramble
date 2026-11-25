import {
	createExecutionContext,
	createScheduledController,
	waitOnExecutionContext,
} from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { ORPHAN_GRACE_MS, sweep } from "../core/sweep.ts";
import { postMessage } from "../test/device.ts";
import { workerDeps } from "./deps.ts";
import worker from "./index.ts";
import { pair } from "./test-accounts.ts";

// The retention sweep on the hosted mailbox: run by the cron, rows before bodies, and cheap in D1
// queries however many bodies R2 holds.

async function posted() {
	const { a, b, id } = await pair();
	const { msgId } = await postMessage(a, id);
	return { id, msgId, member: b.sigKey };
}

/** env, with D1 statements counted. */
function counted() {
	const calls = { n: 0 };
	const db = new Proxy(env.DB, {
		get(target, prop) {
			const value = Reflect.get(target, prop);
			if (prop === "prepare") calls.n++;
			return typeof value === "function" ? value.bind(target) : value;
		},
	});
	return { env: { ...env, DB: db }, calls };
}

describe("the hosted sweep", () => {
	it("runs on the cron: an expired message's row goes, then its body", async () => {
		const { id, msgId } = await posted();
		await env.DB.prepare("update messages set expires_at = 0 where mailbox_id = ?").bind(id).run();
		const ctx = createExecutionContext();
		await worker.scheduled(createScheduledController({ cron: "17 * * * *" }), env, ctx);
		await waitOnExecutionContext(ctx);
		const row = await env.DB.prepare("select id from messages where mailbox_id = ?")
			.bind(id)
			.first();
		expect(row).toBeNull();
		expect(await env.BODIES.head(`m/${id}/${msgId}`)).toBeNull();
	});

	it("a body with no row stays through its first hour, and goes after it", async () => {
		const orphan = `b/${crypto.randomUUID()}/${"a".repeat(64)}`;
		await env.BODIES.put(orphan, new Uint8Array(4));
		await sweep(workerDeps(env));
		expect(await env.BODIES.head(orphan)).not.toBeNull();
		await sweep(workerDeps(env, () => Date.now() + ORPHAN_GRACE_MS + 60_000));
		expect(await env.BODIES.head(orphan)).toBeNull();
	});

	it("checks bodies against rows a page at a time, not one query per body", async () => {
		const later = () => Date.now() + ORPHAN_GRACE_MS + 60_000;
		const { id, member } = await posted();
		const run = async (n: number) => {
			// Rows with a delivery each, so the sweep keeps them and only the orphan pass reads them.
			for (let i = 0; i < n; i++) {
				const msgId = crypto.randomUUID().replaceAll("-", "").slice(0, 22);
				await env.DB.prepare(
					"insert into messages (mailbox_id, id, sender, size, created_at, expires_at) values (?, ?, 'x', 1, ?, ?)",
				)
					.bind(id, msgId, Date.now(), Date.now() + 86_400_000)
					.run();
				await env.DB.prepare(
					"insert into deliveries (mailbox_id, message_id, member) values (?, ?, ?)",
				)
					.bind(id, msgId, member)
					.run();
				await env.BODIES.put(`m/${id}/${msgId}`, new Uint8Array(1));
			}
			const { env: e, calls } = counted();
			await sweep(workerDeps(e, later));
			return calls.n;
		};
		const few = await run(3);
		const many = await run(40);
		expect(many).toBe(few);
		// Every body read was owned, so none went.
		expect((await env.BODIES.list({ prefix: `m/${id}/` })).objects).toHaveLength(44);
	});

	it("a run's D1 queries stay within its budgets, and expiry can't use up the orphan pass's", async () => {
		const later = () => Date.now() + ORPHAN_GRACE_MS + 60_000;
		for (let i = 0; i < 4; i++) await posted();
		await env.DB.prepare("update messages set expires_at = 0").run();
		// Before every other key, so the orphan pass reaches it first.
		const orphan = `b/!orphan/${"a".repeat(64)}`;
		await env.BODIES.put(orphan, new Uint8Array(1));
		const budget = {
			steps: { messages: 4, blobs: 1, markers: 1, mailboxes: 2, strays: 2 },
			orphanQueries: 4,
		};
		const runs: { calls: number; more: boolean }[] = [];
		for (let i = 0; i < 10; i++) {
			const { env: e, calls } = counted();
			const { more } = await sweep(workerDeps(e, later), budget);
			runs.push({ calls: calls.n, more });
			if (i === 0) expect(await env.BODIES.head(orphan)).toBeNull();
			if (!more) break;
		}
		expect(runs[0]?.more).toBe(true);
		expect(runs.at(-1)?.more).toBe(false);
		for (const run of runs) expect(run.calls).toBeLessThanOrEqual(14);
		const left = await env.DB.prepare("select count(*) as n from messages").first<{ n: number }>();
		expect(left?.n).toBe(0);
	});
});
