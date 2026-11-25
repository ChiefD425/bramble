/// <reference types="chrome" />
// The mailbox engine's ports on the extension (docs/mailbox-service.md). The
// background holds only the vault id: sealing, opening, signing and verifying run in the crypto
// host, merging goes through the background's own merge path, and attachments move through
// hostHttp, which runs a transfer in the host so a long upload outlives the service worker.

import { fetchTransport } from "@core/adapters/http";
import {
	createMailboxVaultPort,
	type MailboxCryptoPort,
	type MailboxEngine,
	type MailboxServer,
	type MailboxVaultPort,
	mailboxApi,
	mailboxStateKey,
	mailboxSync,
	metaStateStore,
} from "@core/sync/mailbox";
import { encodeRoster } from "@core/sync/roster";
import { idbBlobStore } from "../files/idb";
import { extensionStorage } from "../storage";
import { getStoredGroup, getStoredSigningKey, type SigningKeypair } from "../sync/sync-config";
import { hostBlobMover } from "./host-http";
import { sendToOffscreen } from "./offscreen-client";
import { makeVaultSyncPort, queueApply, readLocalState, refusedFor, syncApplyRoster } from "./sync";

/** A host call's answer, or its error as an Error carrying the host's message. */
async function host<T>(message: {
	type: string;
	vaultId?: string;
	payload: Record<string, unknown>;
}): Promise<T> {
	const res = await sendToOffscreen(message);
	if (!res.ok) throw new Error(res.error ?? `${message.type} failed`);
	return res.data as T;
}

export function mailboxCryptoPort(vaultId: string, signing: SigningKeypair): MailboxCryptoPort {
	return {
		mailboxId: (groupKeyB64) =>
			host({ type: "CRYPTO_MAILBOX_ID", vaultId, payload: { groupKeyB64 } }),
		mailboxSeal: (groupKeyB64, aad, plaintext) =>
			host({ type: "CRYPTO_MAILBOX_SEAL", vaultId, payload: { groupKeyB64, aad, plaintext } }),
		mailboxOpen: (groupKeyB64, aad, sealedB64) =>
			host({ type: "CRYPTO_MAILBOX_OPEN", vaultId, payload: { groupKeyB64, aad, sealedB64 } }),
		sign: (message) =>
			host({ type: "SYNC_ROSTER_SIGN", payload: { secretB64: signing.secretKey, message } }),
		verify: async (publicB64, message, sigB64) => {
			// Only the host's answer is a verdict. A host that cannot answer rejects, so the round
			// retries rather than quarantining a good message as forged.
			const valid = await host<boolean>({
				type: "SYNC_SIG_VERIFY",
				payload: { publicB64, message, sigB64 },
			});
			return valid === true;
		},
	};
}

/** Which group and roster key an engine speaks for; null when the vault has no group or key. An
 * engine built for one identity must never run for another. */
export async function mailboxIdentity(vaultId: string): Promise<string | null> {
	const ctx = { vaultId };
	const [group, signing] = await Promise.all([getStoredGroup(ctx), getStoredSigningKey(ctx)]);
	return group && signing ? `${group.groupKey}|${signing.publicKey}` : null;
}

/** The vault as the mailbox reads and merges it. Its merges queue behind P2P's. */
export function mailboxVaultPort(vaultId: string, current: () => boolean): MailboxVaultPort {
	const ctx = { vaultId };
	// Never an empty roster: reconciling against one would remove every other member.
	const rosterNow = async () => {
		const group = await getStoredGroup(ctx);
		if (!group) throw new Error("no sync group for this vault");
		return group.roster;
	};
	const vault = createMailboxVaultPort({
		sync: makeVaultSyncPort(ctx),
		rejected: refusedFor(vaultId),
		readEntries: async () => (await readLocalState(ctx)).payload,
		readRoster: rosterNow,
		// Through the P2P path's own writer, so the devices list refreshes the same way.
		writeRoster: (roster) => syncApplyRoster(vaultId, encodeRoster(roster)),
		verifyRoster: async (rosterJson) =>
			host<string | null>({
				type: "SYNC_ROSTER_VERIFY",
				payload: { rosterJson, localJson: encodeRoster(await rosterNow()) },
			}),
		quarantine: {
			readQuarantine: (id) => extensionStorage.readQuarantine?.(id) ?? Promise.resolve(null),
			writeQuarantine: (json, id) =>
				extensionStorage.writeQuarantine?.(json, id) ?? Promise.resolve(),
		},
		vaultId,
		current,
	});
	return { ...vault, apply: (remote) => queueApply(vaultId, () => vault.apply(remote)) };
}

/** null: this vault cannot use a mailbox yet (no sync group, or no signing key). */
export async function buildMailboxEngine(
	vaultId: string,
	server: MailboxServer,
	current: () => boolean,
): Promise<MailboxEngine | null> {
	const ctx = { vaultId };
	const [group, signing] = await Promise.all([getStoredGroup(ctx), getStoredSigningKey(ctx)]);
	if (!group || !signing) return null;
	const keys = mailboxCryptoPort(vaultId, signing);
	const mailboxId = await keys.mailboxId(group.groupKey);
	const api = mailboxApi({
		http: fetchTransport,
		server,
		signer: { sigKey: signing.publicKey, sign: keys.sign },
		mailboxId,
	});
	const store = idbBlobStore(vaultId);
	const random = (n: number) => crypto.getRandomValues(new Uint8Array(n));
	const sync = mailboxSync({
		api,
		crypto: keys,
		vault: mailboxVaultPort(vaultId, current),
		blobs: { store, mover: hostBlobMover(vaultId, store) },
		groupKeyB64: group.groupKey,
		sigKey: signing.publicKey,
		state: metaStateStore(extensionStorage, mailboxStateKey(vaultId, mailboxId), random),
		random,
	});
	return { sync, api };
}
