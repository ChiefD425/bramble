import { createExecutionContext } from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import {
	AccountStatusResponseSchema,
	formatAccountNumber,
} from "@vault/core/src/sync/mailbox/protocol.ts";
import { describe, expect, expectTypeOf, it } from "vitest";
import { ROW_BYTES } from "../core/messages.ts";
import { inbox, newMailboxId, postMessage } from "../test/device.ts";
import {
	accountKey,
	accountStatus,
	credit,
	deleteAccount,
	freeze,
	openAccount,
	resolveAccount,
} from "./accounts.ts";
import { accountEntitlement } from "./entitlement.ts";
import { r2Bodies } from "./r2-bodies.ts";
import { Accounts, type AccountsRpc } from "./rpc.ts";
import { account, db, device, failing, pair, withAccount } from "./test-accounts.ts";

// Accounts on the hosted mailbox (docs/mailbox-service.md, "Accounts and payments"): a bearer
// number stored only as a keyed hash, paid time that gates posting but never collecting, and a
// quota across every mailbox on the account.

const DAY = 86_400_000;
const key = () => accountKey(env.ACCOUNT_KEY);

describe("account numbers", () => {
	it("are 25 digits in groups of 5, and only their keyed hash is stored", async () => {
		const { number } = await openAccount(db(), await key(), Date.now());
		expect(number).toMatch(/^\d{5}( \d{5}){4}$/);
		const rows = await env.DB.prepare("select * from accounts").all();
		expect(JSON.stringify(rows.results)).not.toContain(number.replaceAll(" ", ""));
		expect(formatAccountNumber("1234567890123456789012345")).toBe("12345 67890 12345 67890 12345");
	});

	it("resolve however they are spaced, and a wrong one doesn't", async () => {
		const { number, accountId } = await openAccount(db(), await key(), Date.now());
		const digits = number.replaceAll(" ", "");
		expect(await resolveAccount(db(), await key(), number)).toBe(accountId);
		expect(await resolveAccount(db(), await key(), digits)).toBe(accountId);
		expect(await resolveAccount(db(), await key(), digits.replace(/(.{5})/g, "$1-"))).toBe(
			accountId,
		);
		const wrong = `${digits.slice(0, -1)}${(Number(digits.at(-1)) + 1) % 10}`;
		expect(await resolveAccount(db(), await key(), wrong)).toBeNull();
		expect(await resolveAccount(db(), await key(), "not a number")).toBeNull();
	});
});

describe("creating a hosted mailbox", () => {
	it("needs an account: none is account_required, an unknown one account_unknown", async () => {
		const a = await device();
		const none = await a.request("POST", `/v1/mailboxes/${newMailboxId()}`, {
			members: [a.sigKey],
		});
		expect(none.status).toBe(402);
		expect(await none.json()).toEqual({ error: "account_required" });
		const unknown = await a.request(
			"POST",
			`/v1/mailboxes/${newMailboxId()}`,
			{ members: [a.sigKey] },
			withAccount("00000 00000 00000 00000 00001"),
		);
		expect(unknown.status).toBe(403);
		expect(await unknown.json()).toEqual({ error: "account_unknown" });
	});
});

describe("paid time", () => {
	it("a new account collects but cannot post until credited, and stops at paid_through", async () => {
		const { number, accountId } = await account(0);
		const { a, b, id } = await pair(number);
		expect((await postMessage(a, id)).res.status).toBe(402);
		expect((await inbox(b, id)).messages).toEqual([]);
		await credit(db(), accountId, 30, `op1:${accountId}`, Date.now());
		expect((await postMessage(a, id)).res.status).toBe(200);
		await env.DB.prepare("update accounts set paid_through = ? where id = ?")
			.bind(Date.now() - 1, accountId)
			.run();
		expect((await postMessage(a, id)).res.status).toBe(402);
		expect((await inbox(b, id)).messages).toHaveLength(1);
	});

	it("a frozen account collects but cannot post", async () => {
		const { number, accountId } = await account(30);
		const { a, b, id } = await pair(number);
		await freeze(db(), accountId, true);
		expect((await postMessage(a, id)).res.status).toBe(402);
		expect((await b.request("GET", `/v1/mailboxes/${id}/inbox`)).status).toBe(200);
		await freeze(db(), accountId, false);
		expect((await postMessage(a, id)).res.status).toBe(200);
	});

	it("credit stacks from paid_through, and a refund removes time but never past now", async () => {
		const now = Date.now();
		const { accountId } = await openAccount(db(), await key(), now);
		expect((await credit(db(), accountId, 30, `op2:${accountId}`, now)).paidThrough).toBe(
			now + 30 * DAY,
		);
		expect((await credit(db(), accountId, 30, `op3:${accountId}`, now)).paidThrough).toBe(
			now + 60 * DAY,
		);
		expect((await credit(db(), accountId, -30, `op4:${accountId}`, now)).paidThrough).toBe(
			now + 30 * DAY,
		);
		expect((await credit(db(), accountId, -90, `op5:${accountId}`, now)).paidThrough).toBe(now);
	});

	it("two credits at once both count", async () => {
		const now = Date.now();
		const { accountId } = await openAccount(db(), await key(), now);
		await Promise.all([
			credit(db(), accountId, 30, `op6:${accountId}`, now),
			credit(db(), accountId, 30, `op7:${accountId}`, now),
		]);
		expect((await accountStatus(db(), accountId, 1)).paidThrough).toBe(now + 60 * DAY);
	});

	it("a credit with the same op applies once", async () => {
		const now = Date.now();
		const { accountId } = await openAccount(db(), await key(), now);
		const first = await credit(db(), accountId, 30, `p1:${accountId}`, now);
		const again = await credit(db(), accountId, 30, `p1:${accountId}`, now);
		expect(first).toEqual({ paidThrough: now + 30 * DAY, applied: true });
		expect(again).toEqual({ paidThrough: now + 30 * DAY, applied: false });
	});

	it("credits with different ops both apply", async () => {
		const now = Date.now();
		const { accountId } = await openAccount(db(), await key(), now);
		await credit(db(), accountId, 30, `p1:${accountId}`, now);
		expect((await credit(db(), accountId, 30, `p2:${accountId}`, now)).paidThrough).toBe(
			now + 60 * DAY,
		);
	});

	it("credit takes whole days only", async () => {
		const { accountId } = await openAccount(db(), await key(), Date.now());
		await expect(credit(db(), accountId, 1.5, `op8:${accountId}`, Date.now())).rejects.toThrow();
		await expect(
			credit(db(), accountId, Number.NaN, `op9:${accountId}`, Date.now()),
		).rejects.toThrow();
	});
});

describe("quota", () => {
	it("counts every mailbox on the account", async () => {
		const { number, accountId } = await account(30);
		const one = await pair(number);
		const two = await pair(number);
		await postMessage(one.a, one.id, { bytes: new Uint8Array(30) });
		await postMessage(two.a, two.id, { bytes: new Uint8Array(40) });
		const entitlement = accountEntitlement(
			db(),
			key,
			{ quotaBytes: 100, maxMailboxes: 20 },
			Date.now,
		);
		const used = 70 + 2 * ROW_BYTES;
		expect(await entitlement.usage(one.id)).toEqual({ usedBytes: used, quotaBytes: 100 });
		expect((await accountStatus(db(), accountId, 100)).usedBytes).toBe(used);
	});

	it("an account's usage counts every row", async () => {
		const { number, accountId } = await account(30);
		const one = await pair(number);
		const two = await pair(number);
		await postMessage(one.a, one.id, { bytes: new Uint8Array(30) });
		const hashes = ["a".repeat(64), "b".repeat(64)];
		expect((await two.b.request("PUT", `/v1/mailboxes/${two.id}/wants`, { hashes })).status).toBe(
			204,
		);
		expect((await accountStatus(db(), accountId, 1)).usedBytes).toBe(30 + 3 * ROW_BYTES);
	});

	it("a mailbox moved to another account counts against it from then on", async () => {
		const from = await account(30);
		const to = await account(30);
		const { a, id } = await pair(from.number);
		await postMessage(a, id, { bytes: new Uint8Array(30) });
		const moved = await a.request(
			"PUT",
			`/v1/mailboxes/${id}/account`,
			undefined,
			withAccount(to.number),
		);
		expect(moved.status).toBe(204);
		expect((await accountStatus(db(), from.accountId, 100)).usedBytes).toBe(0);
		expect((await accountStatus(db(), to.accountId, 100)).usedBytes).toBe(30 + ROW_BYTES);
	});
});

describe("account status", () => {
	it("answers for the number in the header, and never takes one from the URL", async () => {
		const { number } = await account(30);
		const res = await exports.default.fetch(
			new Request("https://mailbox.test/v1/accounts/status", withAccount(number)),
		);
		expect(res.status).toBe(200);
		const status = AccountStatusResponseSchema.parse(await res.json());
		expect(status.frozen).toBe(false);
		expect(status.paidThrough).toBeGreaterThan(Date.now());
		expect(status.quotaBytes).toBe(1_000_000_000);
		const inUrl = await exports.default.fetch(
			new Request(`https://mailbox.test/v1/accounts/status?account=${encodeURIComponent(number)}`),
		);
		expect(inUrl.status).toBe(402);
	});
});

describe("deleting an account", () => {
	const bodiesOf = async (mailbox: string) =>
		(await env.BODIES.list({ prefix: `m/${mailbox}/` })).objects.length;
	const rowsOf = async (table: string, mailbox: string) =>
		(
			await env.DB.prepare(`select count(*) as n from ${table} where mailbox_id = ?`)
				.bind(mailbox)
				.first<{ n: number }>()
		)?.n;

	it("removes it, every mailbox on it, what they hold and their stored bodies", async () => {
		const { number, accountId } = await account();
		const { a, id } = await pair(number);
		await postMessage(a, id);
		expect(await bodiesOf(id)).toBe(1);

		await deleteAccount(db(), r2Bodies(env.BODIES), accountId);

		expect(await resolveAccount(db(), await key(), number)).toBeNull();
		expect(await rowsOf("messages", id)).toBe(0);
		expect(await bodiesOf(id)).toBe(0);
		expect(
			await env.DB.prepare("select id from mailboxes where id = ?").bind(id).first(),
		).toBeNull();
		expect(
			await env.DB.prepare("select op from account_credits where account_id = ?")
				.bind(accountId)
				.first(),
		).toBeNull();
	});

	it("leaves another account's mailbox alone", async () => {
		const gone = await account();
		const kept = await account();
		const { a, id } = await pair(kept.number);
		await postMessage(a, id);

		await deleteAccount(db(), r2Bodies(env.BODIES), gone.accountId);

		expect(await resolveAccount(db(), await key(), kept.number)).toBe(kept.accountId);
		expect(await rowsOf("messages", id)).toBe(1);
		expect(await bodiesOf(id)).toBe(1);
	});

	it("twice is not an error, so a retry after a failure is safe", async () => {
		const { accountId } = await account();
		await deleteAccount(db(), r2Bodies(env.BODIES), accountId);
		await expect(deleteAccount(db(), r2Bodies(env.BODIES), accountId)).resolves.toBeUndefined();
	});

	it("a device on a deleted account is told so, not left guessing", async () => {
		const { number, accountId } = await account();
		await deleteAccount(db(), r2Bodies(env.BODIES), accountId);
		const res = await exports.default.fetch(
			new Request("https://mailbox.test/v1/accounts/status", withAccount(number)),
		);
		expect(res.status).toBe(403);
		expect(await res.json()).toEqual({ error: "account_unknown" });
	});
});

describe("the RPC billing uses", () => {
	it("keeps the shape billing is written against", () => {
		expectTypeOf<Pick<Accounts, keyof AccountsRpc>>().toEqualTypeOf<AccountsRpc>();
	});

	it("opens, resolves, credits, freezes and removes", async () => {
		const rpc = new Accounts(createExecutionContext(), env);
		const { number, accountId } = await rpc.open();
		expect(await rpc.resolve(number)).toBe(accountId);
		expect((await rpc.credit(accountId, 30, "op-rpc")).paidThrough).toBeGreaterThan(Date.now());
		await rpc.freeze(accountId, true);
		expect((await accountStatus(db(), accountId, 1)).frozen).toBe(true);
		await rpc.remove(accountId);
		expect(await rpc.resolve(number)).toBeNull();
	});

	it("an error crossing it carries the database's message, never the query and its values", async () => {
		const rpc = new Accounts(createExecutionContext(), { ...env, DB: failing() });
		const err = await rpc.credit("acct_secret_id", 30, "op-secret").catch((e: unknown) => e);
		expect(err).toBeInstanceOf(Error);
		expect((err as Error).message).toContain("the database is unreachable");
		expect((err as Error).message).not.toContain("acct_secret_id");
		expect((err as Error).message).not.toContain("Failed query");
	});
});
