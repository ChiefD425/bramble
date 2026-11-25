// The desktop app's mailbox (docs/mailbox-service.md): core's in-process wiring,
// bound to the app's own pieces. Its tick is the shell's, the one the backup schedule runs on:
// closing the window only hides it, and a hidden webview's timers are throttled. The window
// coming back (opened from the tray) asks for a round, as a resume does on mobile.

import { can } from "@core/flags";
import type { BlobStore } from "@core/index";
import { createInProcessMailbox, type MailboxBlobMover } from "@core/sync/mailbox";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { desktopCrypto } from "../adapters/crypto";
import { desktopFiles } from "../adapters/files";
import { desktopHttp } from "../adapters/http";
import { desktopStorage, onVaultWritten } from "../adapters/storage";
import { onVaultStateChange } from "../adapters/vault-session";
import { TICK_EVENT } from "../backup";
import { desktopBlobMover } from "./blob-mover";
import { signRoster, syncSigningPublicKey } from "./keys";
import {
	activeVaultId,
	mailboxVaultDeps,
	queueApply,
	refusedFor,
	rosterVerify,
	storedGroup,
} from "./roster";

function mailboxBlobs(vaultId: string): { store: BlobStore; mover: MailboxBlobMover } {
	const store = desktopFiles.forVault(vaultId).blobs;
	return { store, mover: desktopBlobMover(vaultId, store) };
}

const desktopMailbox = createInProcessMailbox({
	storage: desktopStorage,
	crypto: desktopCrypto,
	http: desktopHttp,
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
		const stop = listen(TICK_EVENT, cb);
		return () => void stop.then((off) => off());
	},
	onWake: (cb) => {
		const stop = getCurrentWindow().onFocusChanged(({ payload: focused }) => {
			if (focused) cb();
		});
		return () => void stop.then((off) => off());
	},
	hosted: can("mailboxHosted", "desktop"),
});

export const mailboxDriver = desktopMailbox.driver;
export const initMailbox = desktopMailbox.init;
export const mailboxVaultSwitching = desktopMailbox.vaultSwitching;
