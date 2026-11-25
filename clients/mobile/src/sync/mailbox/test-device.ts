// Test-only: devices of one vault syncing through a test mailbox. Each has its own in-memory vault
// with real entry and file mutations, its own blob store, a real Ed25519 roster key and the fake
// reversible seal. Only the mailbox joins them.

import { randomBytes } from "node:crypto";
import { fetchTransport } from "@core/adapters/http";
import type { Entry, EntryData } from "@core/hooks/useVault";
import { createVaultSyncPort } from "@core/sync/apply-remote";
import { type MailboxSigner, mailboxApi, storeBlobMover } from "@core/sync/mailbox/api";
import type { MailboxContext } from "@core/sync/mailbox/context";
import { type MailboxCryptoPort, openMessage } from "@core/sync/mailbox/envelope";
import { decodePlaintext } from "@core/sync/mailbox/plaintext";
import { sha256Hex } from "@core/sync/mailbox/protocol";
import { freshState, type MailboxState } from "@core/sync/mailbox/state";
import { createMailboxVaultPort } from "@core/sync/mailbox/vault-port";
import type { RosterPayload } from "@core/sync/roster";
import { ed25519Signer, fakeMailboxCrypto } from "@core/test/mailbox-fakes";
import { memoryBlobStore } from "@core/test/memory-blob-store";
import type { BlobStore } from "@core/vault/blob-store";
import { type VaultEntries, vaultEntriesFromPayload } from "@core/vault/entry-mutations";
import { harness } from "@core/vault/entry-mutations.harness";
import {
	createFileMutations,
	type FileMutations,
	type FileSealer,
} from "@core/vault/file-mutations";
import type { QuarantineRecord } from "@core/vault/quarantine";
import type { TestMailbox } from "./test-server";

export interface TestDevice {
	name: string;
	sigKey: string;
	signer: MailboxSigner;
	ctx: MailboxContext;
	state: MailboxState;
	vault: ReturnType<typeof harness> & { files: FileMutations };
	blobs: BlobStore;
	roster: { current: RosterPayload };
	/** Flip to simulate a lock or a vault switch. */
	current: { value: boolean };
	entries(): Promise<VaultEntries>;
	quarantined(): Promise<QuarantineRecord[]>;
}

/** Stores the source bytes as the blob, so a record's hash names bytes this device holds. */
function storingSealer(blobs: BlobStore): FileSealer {
	return {
		async seal(source) {
			if (source.kind !== "bytes") throw new Error("the test sealer takes bytes");
			const hash = await sha256Hex(source.bytes);
			await blobs.put(hash, source.bytes);
			return {
				hash,
				size: source.bytes.length,
				wrappedFek: "wf",
				fekIv: "fi",
				noncePrefix: "np",
				metaBlob: `mb-${hash.slice(0, 8)}`,
				metaIv: "mi",
			};
		},
		resealMeta: async () => ({ metaBlob: "mb2", metaIv: "mi2" }),
		describe: async () => ({ name: "f", mime: "application/pdf", plaintextSize: 1 }),
	};
}

/** The core's keys instead of the fakes: a real mailbox id, roster keys and seal. */
export interface GroupKeys {
	mailboxId: string;
	groupKeyB64: string;
	signers: MailboxSigner[];
	crypto(signer: MailboxSigner): MailboxCryptoPort;
}

export async function testGroup(
	box: TestMailbox,
	names: string[],
	opts: {
		now?: () => number;
		limits?: MailboxContext["limits"];
		keys?: GroupKeys;
		/** The hosted account number every device starts with. */
		account?: string;
	} = {},
): Promise<TestDevice[]> {
	const mailboxId = opts.keys?.mailboxId ?? randomBytes(32).toString("base64url");
	const groupKeyB64 = opts.keys?.groupKeyB64 ?? randomBytes(32).toString("base64");
	const signers = opts.keys?.signers ?? (await Promise.all(names.map(() => ed25519Signer())));
	const roster: RosterPayload = {
		devices: names.map((name, i) => ({
			id: name,
			publicKey: `pk-${name}`,
			label: name,
			addedAt: 1,
			hlc: { wall: 1, counter: 0, node: name },
			sigKey: signers[i]?.sigKey,
		})),
		revoked: [],
	};
	const random = (n: number) => new Uint8Array(randomBytes(n));

	return names.map((name, i) => {
		const signer = signers[i] as (typeof signers)[number];
		const h = harness(opts.now ?? Date.now, name);
		const blobs = memoryBlobStore().store;
		const files = createFileMutations({
			sealer: storingSealer(blobs),
			persist: h.mutations.persist,
			clock: async () => h.clock,
		});
		const own = { current: structuredClone(roster) };
		const current = { value: true };
		let quarantine: string | null = null;
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
			readRoster: async () => own.current,
			writeRoster: async (next) => {
				own.current = next;
			},
			verifyRoster: async (json) => json,
			quarantine: {
				readQuarantine: async () => quarantine,
				writeQuarantine: async (json: string) => {
					quarantine = json;
				},
			},
			vaultId: "v",
			current: () => current.value,
		});
		const ctx: MailboxContext = {
			api: mailboxApi({
				http: fetchTransport,
				server: { url: box.url, ...(opts.account ? { account: opts.account } : {}) },
				signer,
				mailboxId,
			}),
			crypto: opts.keys ? opts.keys.crypto(signer) : fakeMailboxCrypto(mailboxId, signer),
			vault,
			blobs: { store: blobs, mover: storeBlobMover(fetchTransport, blobs) },
			groupKeyB64,
			sigKey: signer.sigKey,
			// Late-bound, so tests that fake the clock move the engine's too.
			now: () => Date.now(),
			random,
			limits: opts.limits,
		};
		return {
			name,
			sigKey: signer.sigKey,
			signer,
			ctx,
			state: freshState(random),
			vault: { ...h, files },
			blobs,
			roster: own,
			current,
			entries: async () => {
				const payload = await h.mutations.readEntriesPayload();
				const decrypted = payload.entries.map(
					(e) => ({ id: e.id, ...JSON.parse(e.ciphertext.slice(3)) }) as Entry,
				);
				return vaultEntriesFromPayload(payload, decrypted);
			},
			quarantined: async () =>
				quarantine === null ? [] : (JSON.parse(quarantine) as QuarantineRecord[]),
		};
	});
}

/** The device's API rebuilt with another account number, or none, as a changed setting would. */
export function useAccount(d: TestDevice, box: TestMailbox, account?: string) {
	d.ctx = {
		...d.ctx,
		api: mailboxApi({
			http: fetchTransport,
			server: { url: box.url, ...(account ? { account } : {}) },
			signer: d.signer,
			mailboxId: d.ctx.api.mailboxId,
		}),
	};
}

export const login = (name: string): EntryData => ({
	type: "login",
	name,
	urls: [],
	username: "u",
	password: name,
});

/** Add a login; its id. */
export async function addLogin(d: TestDevice, name: string): Promise<string> {
	const before = new Set((await d.entries()).entries.map((e) => e.id));
	const next = await d.vault.mutations.add(await d.entries(), login(name));
	return next.entries.find((e) => !before.has(e.id))?.id as string;
}

/** Attach `bytes` to an entry; the blob's hash. */
export async function attachFile(d: TestDevice, entryId: string, bytes: Uint8Array) {
	await d.vault.files.attach(await d.entries(), {
		source: { kind: "bytes", bytes },
		name: "scan.pdf",
		mime: "application/pdf",
		entryId,
	});
	return sha256Hex(bytes);
}

/** This device's names for the entries it shows, sorted. */
export async function names(d: TestDevice): Promise<string[]> {
	return (await d.entries()).entries.map((e) => (e as unknown as { name: string }).name).sort();
}

/** The first device creates the mailbox listing everyone; every other device activates. */
export async function activeGroup(
	box: TestMailbox,
	deviceNames: string[],
	opts?: Parameters<typeof testGroup>[2],
): Promise<TestDevice[]> {
	const devices = await testGroup(box, deviceNames, opts);
	const [first, ...rest] = devices as [TestDevice, ...TestDevice[]];
	await first.ctx.api.create({ members: devices.map((d) => d.sigKey) });
	first.state.active = true;
	for (const d of rest) {
		await d.ctx.api.activate(true);
		d.state.active = true;
	}
	return devices;
}

/** The kinds of the messages waiting for `d`, sorted. */
export async function inboxKinds(d: TestDevice): Promise<string[]> {
	const kinds: string[] = [];
	for (const m of (await d.ctx.api.inbox()).messages) {
		const body = (await d.ctx.api.message(m.id)) as Uint8Array;
		const text = await openMessage(d.ctx.crypto, {
			groupKeyB64: d.ctx.groupKeyB64,
			mailboxId: d.ctx.api.mailboxId,
			messageId: m.id,
			sender: m.sender,
			body,
		});
		const decoded = decodePlaintext(text);
		kinds.push(decoded.ok ? decoded.message.kind : decoded.why);
	}
	return kinds.sort();
}
