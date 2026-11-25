import {
	createExecutionContext,
	createScheduledController,
	waitOnExecutionContext,
} from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../core/app.ts";
import { activate, createMailbox, deviceWith, newMailboxId } from "../test/device.ts";
import { workerDeps } from "./deps.ts";
import worker from "./index.ts";
import { account, failing, withAccount } from "./test-accounts.ts";

// How often the hosted mailbox may be asked, and what it says when something breaks: limits per
// mailbox and per account come from the Rate Limiting bindings, and an unexpected error is logged
// as its message alone, never with the request.

/** A limiter that refuses every key in `blocked`. */
function limiter(blocked: Set<string>, asked: string[]): RateLimit {
	return {
		async limit({ key }) {
			asked.push(key);
			return { success: !blocked.has(key) };
		},
	};
}

/** The Worker's app over `e`, with devices that send to it. */
function hosted(e: Env) {
	const app = createApp(workerDeps(e));
	const device = () =>
		deviceWith(Date.now, (path, init) =>
			app.fetch(new Request(`https://mailbox.test${path}`, init)),
		);
	return { app, device };
}

afterEach(() => vi.restoreAllMocks());

/** env.DB that, once armed, holds every count over mailboxes until `expected` wait together, so
 * concurrent requests all count before any of them writes. */
function gatedCounts(expected: number): { DB: D1Database; arm(): void } {
	let armed = false;
	let waiting = 0;
	let open = () => {};
	const allIn = new Promise<void>((resolve) => {
		open = resolve;
	});
	const hold = () => {
		if (!armed) return Promise.resolve();
		if (++waiting === expected) open();
		return allIn;
	};
	const wrap = (stmt: D1PreparedStatement): D1PreparedStatement =>
		new Proxy(stmt, {
			get(s, p) {
				const value = Reflect.get(s, p);
				if (p === "bind") {
					return (...args: unknown[]) =>
						wrap((value as (...a: unknown[]) => D1PreparedStatement).apply(s, args));
				}
				if (p === "first" || p === "all" || p === "raw") {
					return async (...args: unknown[]) => {
						await hold();
						return (value as (...a: unknown[]) => unknown).apply(s, args);
					};
				}
				return typeof value === "function" ? value.bind(s) : value;
			},
		});
	const DB = new Proxy(env.DB, {
		get(target, prop) {
			const value = Reflect.get(target, prop);
			if (prop !== "prepare") return typeof value === "function" ? value.bind(target) : value;
			return (query: string) => {
				const statement = target.prepare(query);
				return query.includes("count(") && query.includes("mailboxes")
					? wrap(statement)
					: statement;
			};
		},
	});
	return {
		DB,
		arm: () => {
			armed = true;
		},
	};
}

describe("rate limits", () => {
	it("a mailbox past its limit gets 429 rate_limited, and another mailbox does not", async () => {
		const blocked = new Set<string>();
		const asked: string[] = [];
		const { device } = hosted({ ...env, MAILBOX_LIMIT: limiter(blocked, asked) });
		const [a, b] = [await device(), await device()];
		const { number } = await account();
		const one = await createMailbox(a, [b], newMailboxId(), withAccount(number));
		const two = await createMailbox(a, [b], newMailboxId(), withAccount(number));
		await activate(one, b);
		blocked.add(`mailbox:${one}`);
		const refused = await b.request("GET", `/v1/mailboxes/${one}/inbox`);
		expect(refused.status).toBe(429);
		expect(await refused.json()).toEqual({ error: "rate_limited" });
		expect((await a.request("GET", `/v1/mailboxes/${two}/members`)).status).toBe(200);
		expect(asked).toContain(`mailbox:${two}`);
	});

	it("account status is limited per account, by its id rather than its number", async () => {
		const blocked = new Set<string>();
		const asked: string[] = [];
		const { app } = hosted({ ...env, ACCOUNT_LIMIT: limiter(blocked, asked) });
		const mine = await account();
		const other = await account();
		blocked.add(mine.accountId);
		const status = (number: string) =>
			app.fetch(new Request("https://mailbox.test/v1/accounts/status", withAccount(number)));
		expect((await status(mine.number)).status).toBe(429);
		expect((await status(other.number)).status).toBe(200);
		expect(asked.some((key) => key.includes(mine.number.replaceAll(" ", "")))).toBe(false);
	});
});

describe("one account's reach", () => {
	it("an account holds at most ACCOUNT_MAX_MAILBOXES mailboxes", async () => {
		const { device } = hosted({ ...env, ACCOUNT_MAX_MAILBOXES: "2" });
		const a = await device();
		const { number } = await account();
		const create = () =>
			a.request(
				"POST",
				`/v1/mailboxes/${newMailboxId()}`,
				{ members: [a.sigKey] },
				withAccount(number),
			);
		expect((await create()).status).toBe(200);
		expect((await create()).status).toBe(200);
		const third = await create();
		expect(third.status).toBe(507);
		expect(await third.json()).toEqual({ error: "quota_exceeded" });
	});

	it("concurrent creates can't pass the mailbox cap", async () => {
		const gate = gatedCounts(12);
		const { device } = hosted({ ...env, DB: gate.DB, ACCOUNT_MAX_MAILBOXES: "2" });
		const a = await device();
		const { number, accountId } = await account();
		gate.arm();
		const answers = await Promise.all(
			Array.from({ length: 12 }, () =>
				a.request(
					"POST",
					`/v1/mailboxes/${newMailboxId()}`,
					{ members: [a.sigKey] },
					withAccount(number),
				),
			),
		);
		const held = await env.DB.prepare("select count(*) as n from mailboxes where account_id = ?")
			.bind(accountId)
			.first<{ n: number }>();
		expect(held?.n).toBeLessThanOrEqual(2);
		expect(answers.filter((r) => r.status !== 200).every((r) => r.status === 507)).toBe(true);
	});

	it("concurrent attaches can't pass the mailbox cap", async () => {
		const gate = gatedCounts(12);
		const { device } = hosted({ ...env, DB: gate.DB, ACCOUNT_MAX_MAILBOXES: "2" });
		const a = await device();
		const ids: string[] = [];
		for (let i = 0; i < 12; i++) {
			const { number } = await account();
			ids.push(await createMailbox(a, [], newMailboxId(), withAccount(number)));
		}
		const to = await account();
		gate.arm();
		const answers = await Promise.all(
			ids.map((id) =>
				a.request("PUT", `/v1/mailboxes/${id}/account`, undefined, withAccount(to.number)),
			),
		);
		const held = await env.DB.prepare("select count(*) as n from mailboxes where account_id = ?")
			.bind(to.accountId)
			.first<{ n: number }>();
		expect(held?.n).toBeLessThanOrEqual(2);
		expect(answers.filter((r) => r.status !== 204).every((r) => r.status === 507)).toBe(true);
	});

	it("a mailbox already on a full account attaches to it again", async () => {
		// Every device that joins a group re-attaches its mailbox once: on an account at its cap,
		// counting the mailbox against itself would refuse each of them, for good.
		const { device } = hosted({ ...env, ACCOUNT_MAX_MAILBOXES: "2" });
		const a = await device();
		const { number } = await account();
		const ids = [newMailboxId(), newMailboxId()];
		for (const id of ids) {
			const res = await a.request(
				"POST",
				`/v1/mailboxes/${id}`,
				{ members: [a.sigKey] },
				withAccount(number),
			);
			expect(res.status).toBe(200);
		}
		const again = await a.request(
			"PUT",
			`/v1/mailboxes/${ids[0]}/account`,
			undefined,
			withAccount(number),
		);
		expect(again.status).toBe(204);
		// Moving a third mailbox onto the full account is still refused.
		const other = await account();
		const third = newMailboxId();
		await a.request(
			"POST",
			`/v1/mailboxes/${third}`,
			{ members: [a.sigKey] },
			withAccount(other.number),
		);
		const moved = await a.request(
			"PUT",
			`/v1/mailboxes/${third}/account`,
			undefined,
			withAccount(number),
		);
		expect(moved.status).toBe(507);
	});

	it("admitting a mailbox to an account is limited per account", async () => {
		const blocked = new Set<string>();
		const { device } = hosted({ ...env, ACCOUNT_LIMIT: limiter(blocked, []) });
		const a = await device();
		const { number, accountId } = await account();
		blocked.add(accountId);
		const res = await a.request(
			"POST",
			`/v1/mailboxes/${newMailboxId()}`,
			{ members: [a.sigKey] },
			withAccount(number),
		);
		expect(res.status).toBe(429);
	});
});

describe("errors", () => {
	it("an unexpected error answers 500 and logs its message without the request", async () => {
		const logged: string[] = [];
		vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
			logged.push(args.map(String).join(" "));
		});
		const { device } = hosted({ ...env, DB: failing() });
		const a = await device();
		const id = newMailboxId();
		const res = await a.request("GET", `/v1/mailboxes/${id}/inbox`);
		expect(res.status).toBe(500);
		expect(logged.join("\n")).toContain("the database is unreachable");
		for (const leak of [id, a.sigKey, "/v1/mailboxes"])
			expect(logged.join("\n")).not.toContain(leak);
	});

	it("a failed sweep logs the database's message, never the query", async () => {
		const logged: string[] = [];
		vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
			logged.push(args.map(String).join(" "));
		});
		const ctx = createExecutionContext();
		worker.scheduled(createScheduledController(), { ...env, DB: failing() }, ctx);
		await waitOnExecutionContext(ctx);
		expect(logged.join("\n")).toContain("the database is unreachable");
		expect(logged.join("\n")).not.toContain("Failed query");
	});

	it("the address limit is keyed by a hash, never the address", async () => {
		const asked: string[] = [];
		const { app } = hosted({ ...env, ACCOUNT_LIMIT: limiter(new Set(), asked) });
		const { number } = await account();
		const headers = { "x-bramble-account": number, "cf-connecting-ip": "203.0.113.9" };
		await app.fetch(new Request("https://mailbox.test/v1/accounts/status", { headers }));
		expect(asked.some((key) => key.startsWith("address:"))).toBe(true);
		expect(asked.some((key) => key.includes("203.0.113.9"))).toBe(false);
	});
});
