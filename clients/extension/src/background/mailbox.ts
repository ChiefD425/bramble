/// <reference types="chrome" />
// The extension's mailbox driver, wired to the background (docs/mailbox-service.md).

import { can } from "@core/flags";
import {
	createMailboxDriver,
	MAILBOX_OFF_PREF_KEY,
	mailboxStatusKey,
	readMailboxSettings,
} from "@core/sync/mailbox";
import { api } from "../platform-api";
import { OPENED_VAULT_KEY } from "../session-keys";
import { resolveSyncVault } from "../sync/sync-config";
import { keepEventPageAlive } from "./event-page-keepalive";
import { buildMailboxEngine, mailboxIdentity } from "./mailbox-ports";
import { useOffscreenDoc } from "./offscreen-client";
import { extensionOnly, on } from "./router";
import { readLocalState } from "./sync";

export const mailboxDriver = createMailboxDriver({
	build: buildMailboxEngine,
	identity: mailboxIdentity,
	readSettings: async (vaultId) =>
		readMailboxSettings((await readLocalState({ vaultId })).payload.settings),
	offHere: async (vaultId) => {
		const key = `${MAILBOX_OFF_PREF_KEY}:${vaultId}`;
		return (await api.storage.local.get(key))[key] === true;
	},
	writeStatus: (vaultId, record) => api.storage.local.set({ [mailboxStatusKey(vaultId)]: record }),
	alarms: {
		create: (name, periodInMinutes) => void api.alarms.create(name, { periodInMinutes }),
		clear: (name) => void api.alarms.clear(name),
	},
	keepAlive: (run) => {
		keepEventPageAlive(!useOffscreenDoc);
		return run();
	},
	now: Date.now,
	// Only Chromium has the offscreen document; both are the extension family.
	hosted: can("mailboxHosted", useOffscreenDoc ? "chromium" : "firefox"),
});

/** Follow the vault the UI has opened, as P2P's start does: a vault syncs only once opened. */
export async function retargetMailboxToOpenVault(): Promise<void> {
	const ctx = await resolveSyncVault();
	const opened = (await api.storage.session.get(OPENED_VAULT_KEY))[OPENED_VAULT_KEY];
	mailboxDriver.retarget(ctx && opened === ctx.vaultId ? ctx.vaultId : null);
}

/** This device's per-vault opt-out, as usePrefs stores a "vault"-scoped pref. */
export const isMailboxOffKey = (key: string) => key.startsWith(`${MAILBOX_OFF_PREF_KEY}:`);

// The settings card's "Sync now", and each device's check-in for the devices list.
on(
	"MAILBOX_SYNC_NOW",
	extensionOnly(async () => ({ ok: true, data: await mailboxDriver.syncNow() })),
);
on(
	"MAILBOX_MEMBERS",
	extensionOnly(async () => ({ ok: true, data: await mailboxDriver.members() })),
);
