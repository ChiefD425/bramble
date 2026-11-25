import { describe, expect, it, vi } from "vitest";
import { ed25519Signer, fakeMailboxCrypto } from "../../test/mailbox-fakes";
import { memoryBlobStore } from "../../test/memory-blob-store";
import { type MailboxApi, MailboxApiError } from "./api";
import type { MailboxContext } from "./context";
import { sealMessage } from "./envelope";
import { LIMITS } from "./limits";
import { type InboxResponse, MAX_MESSAGE_BYTES } from "./protocol";
import { drainInbox } from "./receive";
import { freshState } from "./state";
import type { MailboxVaultPort } from "./vault-port";

const MAILBOX = "M".repeat(43);
const ID = "I".repeat(22);
const random = (n: number) => crypto.getRandomValues(new Uint8Array(n));

const page = (over: Partial<InboxResponse>): InboxResponse => ({
	messages: [],
	blobs: [],
	wanted: [],
	wantedMore: false,
	markers: [],
	more: false,
	retentionDays: 365,
	usedBytes: 0,
	quotaBytes: null,
	serverTime: 0,
	...over,
});

const unused = () => {
	throw new Error("not expected in this test");
};

async function setup(api: Partial<MailboxApi>) {
	const sender = await ed25519Signer();
	const me = await ed25519Signer();
	const full = {
		mailboxId: MAILBOX,
		serverNow: () => 0,
		ack: vi.fn(async () => {}),
		...api,
	} as unknown as MailboxApi;
	const vault = {
		readLocal: unused,
		previewRoster: unused,
		apply: unused,
		quarantine: unused,
		current: () => true,
	};
	const ctx: MailboxContext = {
		api: full,
		crypto: fakeMailboxCrypto(MAILBOX, me),
		vault: vault as unknown as MailboxVaultPort,
		blobs: { store: memoryBlobStore().store, mover: { upload: unused, download: unused } },
		groupKeyB64: "G",
		sigKey: me.sigKey,
		now: Date.now,
		random,
	};
	const message = { id: ID, sender: sender.sigKey, size: 1, createdAt: 0 };
	const seal = (plaintext: string) =>
		sealMessage(fakeMailboxCrypto(MAILBOX, sender), {
			groupKeyB64: "G",
			mailboxId: MAILBOX,
			messageId: ID,
			sender: sender.sigKey,
			plaintext,
		});
	return { ctx, api: full, message, seal, state: freshState(random) };
}

describe("drainInbox", () => {
	it("ends the drain on a page that acknowledges nothing", async () => {
		const inbox = vi.fn();
		const s = await setup({ inbox });
		const body = await s.seal(JSON.stringify({ v: 2, kind: "delta" }));
		inbox.mockResolvedValue(page({ messages: [s.message], more: true }));
		(s.api as { message: unknown }).message = async () => body;
		const result = await drainInbox(s.ctx, s.state);
		expect(inbox).toHaveBeenCalledTimes(1);
		expect(s.api.ack).not.toHaveBeenCalled();
		expect(result).toMatchObject({ held: 1, merged: 0, interrupted: false });
	});

	it("acknowledges a body the server lost and asks its sender for a snapshot", async () => {
		const s = await setup({});
		Object.assign(s.api, {
			inbox: async () => page({ messages: [s.message] }),
			message: async () => null,
		});
		await drainInbox(s.ctx, s.state);
		expect(s.api.ack).toHaveBeenCalledWith({ messages: [ID], blobs: [], markers: [] });
		expect(s.state.gaps).toEqual([s.message.sender]);
	});

	it("a drain stops after drainPages pages", async () => {
		const s = await setup({});
		let calls = 0;
		Object.assign(s.api, {
			inbox: async () => {
				if (++calls > 100) throw new Error("the drain never stopped");
				const id = `${calls}`.padStart(22, "a");
				return page({ messages: [{ ...s.message, id }], more: true });
			},
			message: async () => null,
		});
		await drainInbox(s.ctx, s.state);
		expect(calls).toBe(LIMITS.drainPages);
	});

	it("a body over MAX_MESSAGE_BYTES is not opened", async () => {
		const s = await setup({});
		Object.assign(s.api, {
			inbox: async () => page({ messages: [s.message] }),
			message: async () => new Uint8Array(MAX_MESSAGE_BYTES + 1),
		});
		await drainInbox(s.ctx, s.state);
		expect(s.api.ack).toHaveBeenCalledWith({ messages: [ID], blobs: [], markers: [] });
		expect(s.state.gaps).toEqual([s.message.sender]);
	});

	it("treats a missing mailbox as deactivation, so the engine creates it again", async () => {
		const s = await setup({
			inbox: async () => {
				throw new MailboxApiError(404, "not_found");
			},
		});
		s.state.active = true;
		expect(await drainInbox(s.ctx, s.state)).toMatchObject({ deactivated: true });
		expect(s.state.active).toBe(false);
	});

	it("does not download a held message again before its retry time", async () => {
		const message = vi.fn();
		const s = await setup({ message });
		const body = await s.seal(JSON.stringify({ v: 2, kind: "delta" }));
		message.mockResolvedValue(body);
		Object.assign(s.api, { inbox: async () => page({ messages: [s.message] }) });
		expect(await drainInbox(s.ctx, s.state)).toMatchObject({ held: 1 });
		expect(await drainInbox(s.ctx, s.state)).toMatchObject({ held: 1 });
		expect(message).toHaveBeenCalledTimes(1);
	});
});

describe("answers to a gap", () => {
	const E = "e".repeat(22);
	const gone = btoa(String.fromCharCode(...new Uint8Array(32).fill(9)));

	async function answered(
		covers: { epoch: string; through: number } | undefined,
		uncoveredBefore?: number,
	) {
		const s = await setup({});
		s.state.senders[gone] = { epoch: E, through: 1, above: [3] };
		if (uncoveredBefore !== undefined) s.state.uncovered[gone] = uncoveredBefore;
		const roster = {
			devices: [
				{
					id: "answerer",
					publicKey: "pk",
					label: "answerer",
					addedAt: 1,
					hlc: { wall: 1, counter: 0, node: "answerer" },
					sigKey: s.message.sender,
				},
			],
			revoked: [],
		};
		Object.assign(s.ctx.vault, {
			previewRoster: async () => roster,
			apply: async () => ({ setAside: false, refused: [] }),
		});
		const body = await s.seal(
			JSON.stringify({
				v: 1,
				kind: "snapshot",
				epoch: "f".repeat(22),
				seq: 1,
				part: 1,
				parts: 1,
				answers: gone,
				...(covers ? { covers } : {}),
				entries: { entries: [], tombstones: [] },
				roster,
			}),
		);
		Object.assign(s.api, {
			inbox: async () => page({ messages: [s.message] }),
			message: async () => body,
		});
		await drainInbox(s.ctx, s.state);
		return s.state;
	}

	it("an answer heals a gap only as far as the answerer had the sender", async () => {
		const short = await answered({ epoch: E, through: 1 });
		expect(short.senders[gone]).toEqual({ epoch: E, through: 1, above: [3] });
		expect(short.uncovered[gone]).toBeTypeOf("number");
		const full = await answered({ epoch: E, through: 3 }, 1);
		expect(full.senders[gone]).toEqual({ epoch: E, through: 3, above: [] });
		expect(full.uncovered[gone]).toBeUndefined();
	});

	it("an answer without covers heals nothing", async () => {
		const state = await answered(undefined);
		expect(state.senders[gone]).toEqual({ epoch: E, through: 1, above: [3] });
	});
});
