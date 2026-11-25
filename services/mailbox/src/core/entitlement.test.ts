import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import {
	activate,
	inbox,
	makeDevice,
	makeServer,
	newMailboxId,
	postMessage,
} from "../test/harness.ts";
import { HttpError } from "./auth.ts";
import { ROW_BYTES } from "./messages.ts";
import { accounts, mailboxes } from "./schema.ts";

// What the hosted service decides through Entitlement: whether a mailbox may be created and for
// which account, what its posts count against, and how often it may be asked. The self-hosted
// server answers yes, its own bytes against QUOTA_BYTES, and has no limiter.

/** A mailbox with its owner and one other active member, so a post is kept for someone. */
async function created(server: ReturnType<typeof makeServer>, account?: string) {
	const owner = await makeDevice(server);
	const peer = await makeDevice(server);
	const id = newMailboxId();
	const res = await owner.request(
		"POST",
		`/v1/mailboxes/${id}`,
		{ members: [owner.sigKey, peer.sigKey] },
		account ? { headers: { "x-bramble-account": account } } : {},
	);
	if (res.status === 200) await activate(id, peer);
	return { owner, id, res };
}

describe("entitlement", () => {
	it("a mailbox the entitlement refuses is not created", async () => {
		const server = makeServer({
			entitlement: {
				admit: async () => {
					throw new HttpError(402, "account_required");
				},
			},
		});
		const { id, res } = await created(server);
		expect(res.status).toBe(402);
		expect(await res.json()).toEqual({ error: "account_required" });
		expect(await server.deps.db.select().from(mailboxes).where(eq(mailboxes.id, id))).toEqual([]);
	});

	it("a new mailbox records the account the entitlement admits, from the header", async () => {
		const seen: (string | undefined)[] = [];
		const server = makeServer({
			entitlement: {
				admit: async (account) => {
					seen.push(account);
					return "acct-1";
				},
			},
		});
		await server.deps.db
			.insert(accounts)
			.values({ id: "acct-1", keyHash: "h", paidThrough: 0, frozen: false, createdAt: 0 });
		const { id, res } = await created(server, "12345 67890");
		expect(res.status).toBe(200);
		expect(seen).toEqual(["12345 67890"]);
		const row = await server.deps.db.select().from(mailboxes).where(eq(mailboxes.id, id)).get();
		expect(row?.accountId).toBe("acct-1");
	});

	it("a post counts against the quota the entitlement reports", async () => {
		const server = makeServer({
			entitlement: { usage: async () => ({ usedBytes: 10, quotaBytes: 20 + ROW_BYTES }) },
		});
		const { owner, id } = await created(server);
		expect((await postMessage(owner, id, { bytes: new Uint8Array(15) })).res.status).toBe(507);
		expect((await postMessage(owner, id, { bytes: new Uint8Array(5) })).res.status).toBe(200);
	});

	it("the inbox reports the entitlement's usage", async () => {
		const server = makeServer({
			entitlement: { usage: async () => ({ usedBytes: 10, quotaBytes: 20 }) },
		});
		const { owner, id } = await created(server);
		const box = await inbox(owner, id);
		expect([box.usedBytes, box.quotaBytes]).toEqual([10, 20]);
	});

	it("a request the limiter refuses is 429 rate_limited, keyed by mailbox", async () => {
		let blocked = "";
		const server = makeServer({ limit: async (key) => key !== `mailbox:${blocked}` });
		const a = await created(server);
		const b = await created(server);
		blocked = a.id;
		const refused = await a.owner.request("GET", `/v1/mailboxes/${a.id}/inbox`);
		expect(refused.status).toBe(429);
		expect(await refused.json()).toEqual({ error: "rate_limited" });
		expect((await b.owner.request("GET", `/v1/mailboxes/${b.id}/inbox`)).status).toBe(200);
	});

	it("a removed device's requests don't spend the members' rate limit", async () => {
		const spent = new Map<string, number>();
		const server = makeServer({
			limit: async (key) => {
				spent.set(key, (spent.get(key) ?? 0) + 1);
				return (spent.get(key) ?? 0) <= 5;
			},
		});
		const { owner, id } = await created(server);
		const outsider = await makeDevice(server);
		const answers: number[] = [];
		for (let i = 0; i < 6; i++) {
			answers.push((await outsider.request("GET", `/v1/mailboxes/${id}/inbox`)).status);
		}
		expect(answers).not.toContain(200);
		expect(answers.at(-1)).toBe(429);
		expect((await owner.request("GET", `/v1/mailboxes/${id}/inbox`)).status).toBe(200);
	});

	it("an address over its limit is refused before any account lookup", async () => {
		const server = makeServer({ accounts: {}, limitAddress: async () => false });
		const number = "12345 67890 12345 67890 12345";
		const headers = { "x-bramble-account": number, "cf-connecting-ip": "203.0.113.9" };
		const status = await server.app.request("/v1/accounts/status", { headers });
		expect(status.status).toBe(429);
		const owner = await makeDevice(server);
		const create = await owner.request(
			"POST",
			`/v1/mailboxes/${newMailboxId()}`,
			{ members: [owner.sigKey] },
			{ headers },
		);
		expect(create.status).toBe(429);
	});

	it("a self-hosted server has no accounts: attaching is not_found, and there is no status", async () => {
		const server = makeServer();
		const { owner, id } = await created(server);
		const attach = await owner.request("PUT", `/v1/mailboxes/${id}/account`, undefined, {
			headers: { "x-bramble-account": "12345 67890 12345 67890 12345" },
		});
		expect(attach.status).toBe(404);
		const status = await server.app.request("/v1/accounts/status", {
			headers: { "x-bramble-account": "12345 67890 12345 67890 12345" },
		});
		expect(status.status).toBe(404);
	});

	it("the self-hosted entitlement counts the mailbox's own bytes against QUOTA_BYTES", async () => {
		const server = makeServer({ quotaBytes: 20 + ROW_BYTES });
		const { owner, id } = await created(server);
		expect((await postMessage(owner, id, { bytes: new Uint8Array(15) })).res.status).toBe(200);
		expect((await postMessage(owner, id, { bytes: new Uint8Array(15) })).res.status).toBe(507);
		const box = await inbox(owner, id);
		expect([box.usedBytes, box.quotaBytes]).toEqual([15 + ROW_BYTES, 20 + ROW_BYTES]);
	});
});
