// A revoked device over the mailbox, through the real vault port and roster check: mobile's and
// desktop's binding (verifyRosterEnvelope over an Ed25519 verify, anchored at the local roster).

import { describe, expect, it, vi } from "vitest";
import { ed25519Signer, fakeMailboxCrypto, verifyEd25519 } from "../../test/mailbox-fakes";
import { memoryBlobStore } from "../../test/memory-blob-store";
import { harness } from "../../vault/entry-mutations.harness";
import type { QuarantineRecord } from "../../vault/quarantine";
import type { EncryptedEntry } from "../../vault-format";
import { createVaultSyncPort } from "../apply-remote";
import type { Hlc } from "../hlc";
import {
	activeSigKeys,
	canonicalRosterEntry,
	type RosterEntry,
	type RosterPayload,
	revokeDevice,
} from "../roster";
import { verifyRosterEnvelope } from "../transport/roster-sync";
import type { MailboxApi } from "./api";
import type { MailboxContext } from "./context";
import { sealMessage } from "./envelope";
import type { InboxResponse } from "./protocol";
import { drainInbox } from "./receive";
import { freshState } from "./state";
import { createMailboxVaultPort } from "./vault-port";

const MAILBOX = "M".repeat(43);
const ID = "I".repeat(22);
const random = (n: number) => crypto.getRandomValues(new Uint8Array(n));
const hlc = (wall: number, node: string): Hlc => ({ wall, counter: 0, node });
const env = (id: string, stamp: Hlc): EncryptedEntry => ({
	id,
	wrappedDek: "w",
	dekIv: "d",
	ciphertext: "ct:{}",
	iv: "i",
	hlc: stamp,
});

type Signer = Awaited<ReturnType<typeof ed25519Signer>>;

async function entry(id: string, signer: Signer, wall: number): Promise<RosterEntry> {
	const e: RosterEntry = {
		id,
		publicKey: `pk-${id}`,
		label: id,
		addedAt: wall,
		hlc: hlc(wall, id),
		sigKey: signer.sigKey,
	};
	return { ...e, sig: await signer.sign(canonicalRosterEntry(e)) };
}

/** Drain one message from `sender`, carrying `roster`, into a device whose roster starts as given. */
async function drainFrom(start: RosterPayload, me: Signer, sender: Signer, roster: RosterPayload) {
	const now = Date.now();
	let local = start;
	let quarantine: string | null = null;
	const h = harness();
	const vault = createMailboxVaultPort({
		sync: createVaultSyncPort({
			store: h.mutations,
			crypto: h.crypto,
			witnessRemote: async (stamps) => {
				for (const s of stamps) h.clock.witness(s);
			},
		}),
		rejected: new Set(),
		readEntries: () => h.mutations.readEntriesPayload(),
		readRoster: async () => local,
		writeRoster: async (next) => {
			local = next;
		},
		verifyRoster: (json: string) =>
			verifyRosterEnvelope({ wasm: { roster_verify: verifyEd25519 } } as never, json, local),
		quarantine: {
			readQuarantine: async () => quarantine,
			writeQuarantine: async (json: string) => {
				quarantine = json;
			},
		},
		vaultId: "v",
		current: () => true,
	});
	const api = {
		mailboxId: MAILBOX,
		serverNow: () => 0,
		ack: vi.fn(async () => {}),
		inbox: async (): Promise<InboxResponse> => ({
			messages: [{ id: ID, sender: sender.sigKey, size: 1, createdAt: 0 }],
			blobs: [],
			wanted: [],
			wantedMore: false,
			markers: [],
			more: false,
			retentionDays: 365,
			usedBytes: 0,
			quotaBytes: null,
			serverTime: 0,
		}),
		message: async () =>
			await sealMessage(fakeMailboxCrypto(MAILBOX, sender), {
				groupKeyB64: "G",
				mailboxId: MAILBOX,
				messageId: ID,
				sender: sender.sigKey,
				plaintext: JSON.stringify({
					v: 1,
					kind: "delta",
					epoch: "e".repeat(22),
					seq: 1,
					entries: { entries: [env("posted", hlc(now - 2000, "x"))], tombstones: [] },
					roster,
				}),
			}),
	} as unknown as MailboxApi;
	const ctx: MailboxContext = {
		api,
		crypto: fakeMailboxCrypto(MAILBOX, me),
		vault,
		blobs: {
			store: memoryBlobStore().store,
			mover: {
				upload: async () => ({ stored: true, recipients: 0 }),
				download: async () => "stored",
			},
		},
		groupKeyB64: "G",
		sigKey: me.sigKey,
		now: () => now,
		random,
	};
	const result = await drainInbox(ctx, freshState(random));
	return {
		result,
		stored: await h.mutations.readEntriesPayload(),
		roster: local,
		quarantined: quarantine === null ? [] : (JSON.parse(quarantine) as QuarantineRecord[]),
	};
}

describe("a revoked device over the mailbox", () => {
	it("can't post under a fresh roster id reusing its key", async () => {
		const me = await ed25519Signer();
		const gone = await ed25519Signer();
		const now = Date.now();
		const laptop = await entry("laptop", me, 1);
		const phone = await entry("phone", gone, 1);
		const start = revokeDevice(
			{ devices: [laptop, phone], revoked: [] },
			"phone",
			hlc(now - 60_000, "laptop"),
		);
		// Stamped after the revocation, as one planted in advance can be.
		const ghost = await entry("ghost", gone, now - 1000);
		const out = await drainFrom(start, me, gone, {
			devices: [laptop, ghost],
			revoked: start.revoked,
		});
		expect(out.result.merged).toBe(0);
		expect(out.stored.entries).toEqual([]);
		expect(out.quarantined).toEqual([
			expect.objectContaining({ reason: "revoked_sender", sender: gone.sigKey }),
		]);
		expect(activeSigKeys(out.roster)).not.toContain(gone.sigKey);
	});

	it("a newly added device's first post still merges", async () => {
		const me = await ed25519Signer();
		const fresh = await ed25519Signer();
		const laptop = await entry("laptop", me, 1);
		const tablet = await entry("tablet", fresh, Date.now() - 1000);
		const out = await drainFrom({ devices: [laptop], revoked: [] }, me, fresh, {
			devices: [laptop, tablet],
			revoked: [],
		});
		expect(out.result.merged).toBe(1);
		expect(out.stored.entries.map((e) => e.id)).toEqual(["posted"]);
	});
});
