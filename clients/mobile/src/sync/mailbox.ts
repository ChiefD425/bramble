// The mobile app's mailbox (docs/mailbox-service.md): core's in-process wiring,
// bound to the app's own pieces. Mobile has no background scheduler, so the tick is a timer that
// runs while the app is open, and a resume asks for a round.

import { App } from "@capacitor/app";
import { Capacitor } from "@capacitor/core";
import { can } from "@core/flags";
import type { BlobStore } from "@core/index";
import { createInProcessMailbox, type MailboxBlobMover, storeBlobMover } from "@core/sync/mailbox";
import { mobileCrypto } from "../adapters/crypto";
import { mobileFiles } from "../adapters/files";
import { mobileHttp } from "../adapters/http";
import { mobileStorage, onVaultWritten } from "../adapters/storage";
import { mobileTarget } from "../adapters/target";
import { onVaultStateChange } from "../adapters/vault-session";
import { nativeBlobMover } from "./blob-mover";
import {
	activeVaultId,
	mailboxVaultDeps,
	queueApply,
	refusedFor,
	rosterVerify,
	signRoster,
	storedGroup,
	syncSigningPublicKey,
} from "./sync-manager";

const TICK_MS = 5 * 60_000;

/** A vault's blob store and its mover: native on a device, through fetch in the web build. */
export function mailboxBlobs(vaultId: string): { store: BlobStore; mover: MailboxBlobMover } {
	const store = mobileFiles.forVault(vaultId).blobs;
	return {
		store,
		mover: Capacitor.isNativePlatform()
			? nativeBlobMover(vaultId, store)
			: storeBlobMover(mobileHttp, store),
	};
}

const mobileMailbox = createInProcessMailbox({
	storage: mobileStorage,
	crypto: mobileCrypto,
	http: mobileHttp,
	sigKey: syncSigningPublicKey,
	sign: signRoster,
	verify: rosterVerify,
	group: storedGroup,
	vaultDeps: mailboxVaultDeps,
	refusedFor,
	queueApply,
	blobs: mailboxBlobs,
	activeVaultId,
	onVaultStateChange,
	onVaultWritten,
	onTick: (cb) => {
		const id = setInterval(cb, TICK_MS);
		return () => clearInterval(id);
	},
	onWake: (cb) => {
		const listener = App.addListener("resume", cb);
		return () => void listener.then((handle) => handle.remove());
	},
	hosted: can("mailboxHosted", mobileTarget),
});

export const mailboxDriver = mobileMailbox.driver;
export const initMailbox = mobileMailbox.init;
export const mailboxVaultSwitching = mobileMailbox.vaultSwitching;
