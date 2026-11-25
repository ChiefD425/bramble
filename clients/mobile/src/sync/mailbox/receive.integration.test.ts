import { randomBytes } from "node:crypto";
import { sealMessage, signedText } from "@core/sync/mailbox/envelope";
import { encodePlaintext, type MailboxPlaintext } from "@core/sync/mailbox/plaintext";
import { sha256Hex } from "@core/sync/mailbox/protocol";
import { drainInbox } from "@core/sync/mailbox/receive";
import { revokeDevice } from "@core/sync/roster";
import { base64ToBytes } from "@core/util/bytes";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { addLogin, names, type TestDevice, testGroup } from "./test-device";
import { startTestMailbox, type TestMailbox } from "./test-server";

let box: TestMailbox;
beforeAll(async () => {
	box = await startTestMailbox();
});
afterAll(() => box.close());

async function pair(opts?: Parameters<typeof testGroup>[2]) {
	const [a, b] = (await testGroup(box, ["a", "b"], opts)) as [TestDevice, TestDevice];
	await a.ctx.api.create({ members: [a.sigKey, b.sigKey] });
	await b.ctx.api.activate(true);
	return { a, b };
}

const newId = () => randomBytes(16).toString("base64url");

async function postBody(from: TestDevice, body: Uint8Array, messageId = newId()) {
	await from.ctx.api.post(messageId, body);
	return messageId;
}

async function post(from: TestDevice, plaintext: MailboxPlaintext | string) {
	const messageId = newId();
	const body = await sealMessage(from.ctx.crypto, {
		groupKeyB64: from.ctx.groupKeyB64,
		mailboxId: from.ctx.api.mailboxId,
		messageId,
		sender: from.sigKey,
		plaintext: typeof plaintext === "string" ? plaintext : encodePlaintext(plaintext),
	});
	return postBody(from, body, messageId);
}

/** Signed by `from`, with sealed bytes the seal never made. */
async function postSealed(from: TestDevice, sealed: Uint8Array) {
	const messageId = newId();
	const text = signedText({
		mailboxId: from.ctx.api.mailboxId,
		messageId,
		sealedSha256: await sha256Hex(sealed),
	});
	const sig = base64ToBytes(await from.ctx.crypto.sign(text));
	return postBody(from, new Uint8Array([...sig, ...sealed]), messageId);
}

const delta = async (from: TestDevice, seq: number): Promise<MailboxPlaintext> => ({
	v: 1,
	kind: "delta",
	epoch: from.state.epoch,
	seq,
	entries: await from.vault.mutations.readEntriesPayload(),
	roster: from.roster.current,
});

const pending = async (d: TestDevice) => (await d.ctx.api.inbox()).messages.map((m) => m.id);
const junk = (version: number) =>
	new Uint8Array([version, ...new TextEncoder().encode("sealed bytes the core never made")]);

describe("collecting the inbox", () => {
	it("merges a delta and acknowledges it", async () => {
		const { a, b } = await pair();
		await addLogin(a, "Passport");
		await post(a, await delta(a, 1));
		expect(await drainInbox(b.ctx, b.state)).toMatchObject({ merged: 1, held: 0 });
		expect(await names(b)).toEqual(["Passport"]);
		expect(await pending(b)).toEqual([]);
		expect(b.state.senders[a.sigKey]).toEqual({ epoch: a.state.epoch, through: 1, above: [] });
	});

	it("holds a message whose merge set something aside, and merges it once time passes", async () => {
		const { a, b } = await pair({ now: () => Date.now() + 3_600_000 });
		await addLogin(a, "Passport");
		const id = await post(a, await delta(a, 1));
		expect(await drainInbox(b.ctx, b.state)).toMatchObject({ merged: 0, held: 1 });
		expect(await names(b)).toEqual([]);
		expect(await pending(b)).toEqual([id]);
		vi.useFakeTimers({ toFake: ["Date"] });
		try {
			vi.setSystemTime(Date.now() + 2 * 3_600_000);
			expect(await drainInbox(b.ctx, b.state)).toMatchObject({ merged: 1, held: 0 });
		} finally {
			vi.useRealTimers();
		}
		expect(await names(b)).toEqual(["Passport"]);
		expect(await pending(b)).toEqual([]);
	});

	it("quarantines a message that does not open, acknowledges it, and marks a gap", async () => {
		const { a, b } = await pair();
		const id = await postSealed(a, junk(1));
		await drainInbox(b.ctx, b.state);
		expect(await b.quarantined()).toEqual([
			expect.objectContaining({ messageId: id, sender: a.sigKey, reason: "unopenable" }),
		]);
		expect(await pending(b)).toEqual([]);
		expect(b.state.gaps).toEqual([a.sigKey]);
	});

	it("quarantines a revoked sender's message without merging it, and ignores its snapshot request", async () => {
		const { a, b } = await pair();
		b.roster.current = revokeDevice(b.roster.current, "a", { wall: 2, counter: 0, node: "b" });
		await addLogin(a, "Passport");
		const id = await post(a, await delta(a, 1));
		await post(a, { v: 1, kind: "snapshot_request", of: null });
		await drainInbox(b.ctx, b.state);
		expect(await names(b)).toEqual([]);
		expect(await b.quarantined()).toEqual([
			expect.objectContaining({ messageId: id, reason: "revoked_sender" }),
		]);
		expect(b.state.toAnswer).toEqual({});
		expect(await pending(b)).toEqual([]);
	});

	it("quarantines refused entries and merges the rest", async () => {
		const { a, b } = await pair();
		await addLogin(a, "Passport");
		const message = await delta(a, 1);
		if (message.kind !== "delta") throw new Error("unreachable");
		const foreign = {
			...message.entries.entries[0]!,
			id: "foreign",
			ciphertext: "x:another vault",
		};
		message.entries.entries.push(foreign);
		await post(a, message);
		await drainInbox(b.ctx, b.state);
		expect(await names(b)).toEqual(["Passport"]);
		expect(await b.quarantined()).toEqual([expect.objectContaining({ id: "foreign" })]);
		expect(await pending(b)).toEqual([]);
	});

	it("stops without acknowledging when the merge does not run", async () => {
		const { a, b } = await pair();
		await addLogin(a, "Passport");
		const id = await post(a, await delta(a, 1));
		b.current.value = false;
		expect(await drainInbox(b.ctx, b.state)).toMatchObject({ interrupted: true, merged: 0 });
		expect(await pending(b)).toEqual([id]);
		expect(await b.quarantined()).toEqual([]);
	});

	it("stops without acknowledging when opening fails for a local reason", async () => {
		const { a, b } = await pair();
		const id = await post(a, await delta(a, 1));
		b.ctx.crypto = {
			...b.ctx.crypto,
			mailboxOpen: async () => {
				throw new Error("vault is locked");
			},
		};
		expect(await drainInbox(b.ctx, b.state)).toMatchObject({ interrupted: true });
		expect(await pending(b)).toEqual([id]);
		expect(await b.quarantined()).toEqual([]);
	});

	it("stops without quarantining when the vault was switched before a refusal", async () => {
		const { a, b } = await pair();
		const id = await postSealed(a, junk(1));
		b.current.value = false;
		expect(await drainInbox(b.ctx, b.state)).toMatchObject({ interrupted: true });
		expect(await b.quarantined()).toEqual([]);
		expect(await pending(b)).toEqual([id]);
	});

	it("holds a body from a newer version", async () => {
		const { a, b } = await pair();
		const id = await postSealed(a, junk(2));
		expect(await drainInbox(b.ctx, b.state)).toMatchObject({ held: 1 });
		expect(await pending(b)).toEqual([id]);
		expect(await b.quarantined()).toEqual([]);
	});

	it("records the sequence and finds a skipped number", async () => {
		const { a, b } = await pair();
		await addLogin(a, "One");
		await post(a, await delta(a, 1));
		const lost = await post(a, await delta(a, 2));
		await post(a, await delta(a, 3));
		await b.ctx.api.ack({ messages: [lost] });
		await drainInbox(b.ctx, b.state);
		expect(b.state.senders[a.sigKey]).toEqual({ epoch: a.state.epoch, through: 1, above: [3] });
		expect(b.state.gaps).toEqual([a.sigKey]);
	});

	// Last: it moves the shared server's clock a year on.
	it("counts an expiry marker as a gap and acknowledges it", async () => {
		const { a, b } = await pair();
		await post(a, await delta(a, 1));
		// A checks in partway, or the sweep deletes the whole mailbox as abandoned.
		await box.advance(200 * 86_400_000);
		await a.ctx.api.inbox();
		await box.advance(166 * 86_400_000);
		await box.sweep();
		await drainInbox(b.ctx, b.state);
		expect(b.state.gaps).toEqual([a.sigKey]);
		expect((await b.ctx.api.inbox()).markers).toEqual([]);
	});
});
