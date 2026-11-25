// The mailbox for clients that run it in their own process, mobile and desktop: core's driver and
// engine over the app's own pieces, for the unlocked active vault. Rounds run on unlock, after a
// write to that vault or a change to its group or this device's opt-out, on the platform's tick
// while the mailbox is on, on a wake (mobile's resume), and on "Sync now". See
// docs/mailbox-service.md, "Clients".

import type { CryptoAdapter } from "../../adapters/crypto";
import type { HttpTransport } from "../../adapters/http";
import type { StorageAdapter } from "../../adapters/storage";
import type { BlobStore } from "../../vault/blob-store";
import { findVault, parseRegistry, VAULT_REGISTRY_KEY } from "../../vault/vault-registry";
import type { VaultSyncPort } from "../apply-remote";
import type { EntriesPayload } from "../entries-payload";
import type { RosterPayload } from "../roster";
import { syncKeyFor } from "../sync-keys";
import { type MailboxBlobMover, type MailboxServer, mailboxApi } from "./api";
import {
	MAILBOX_OFF_PREF_KEY,
	mailboxStateKey,
	mailboxStatusKey,
	readMailboxSettings,
} from "./config";
import { createMailboxDriver, type MailboxDriver, type MailboxEngine } from "./driver";
import type { MailboxCryptoPort } from "./envelope";
import { metaStateStore } from "./state";
import { mailboxSync } from "./sync";
import { createMailboxVaultPort } from "./vault-port";

const GROUP_KEY = "sync.group";

export interface InProcessMailboxPlatform {
	storage: StorageAdapter;
	crypto: CryptoAdapter;
	http: HttpTransport;
	/** This device's roster key, which signs its requests and messages. */
	sigKey(): Promise<string>;
	sign(canonical: string): Promise<string>;
	verify(sigKey: string, message: string, sigB64: string): Promise<boolean>;
	group(vaultId: string): Promise<{ groupKey: string } | undefined>;
	/** The vault as P2P reads and merges it, pinned to `vaultId`. */
	vaultDeps(vaultId: string): {
		sync: VaultSyncPort;
		readEntries(): Promise<EntriesPayload>;
		readRoster(): Promise<RosterPayload>;
		writeRoster(roster: RosterPayload): Promise<void>;
		verifyRoster(rosterJson: string): Promise<string | null>;
	};
	refusedFor(vaultId: string): Set<string>;
	/** P2P's merge queue: one VEK for the process, so one merge at a time. */
	queueApply<T>(apply: () => Promise<T>): Promise<T>;
	blobs(vaultId: string): { store: BlobStore; mover: MailboxBlobMover };
	activeVaultId(): Promise<string | undefined>;
	onVaultStateChange(cb: (locked: boolean) => void): () => void;
	onVaultWritten(cb: (vaultId: string) => void): () => void;
	/** A periodic cue; it asks for a round only while the mailbox is on. */
	onTick(cb: () => void): () => void;
	/** Cues that always ask for a round (mobile: resume). */
	onWake?(cb: () => void): () => void;
	/** Whether Bramble's hosted mailbox is on for this target. */
	hosted: boolean;
}

export interface InProcessMailbox {
	driver: MailboxDriver;
	/** Follow the unlocked active vault and its cues. Call once; returns the unsubscribe. */
	init(): () => void;
	/** The app is moving to `next` (or none): stop before the process-global key can move, as
	 * P2P does. Re-reporting the vault already followed changes nothing. */
	vaultSwitching(next: string | null): void;
}

const KEY_HOME = "mailbox.keyVault";

/** The vault this device's one signing key is active for, kept in device meta. A claim held by a
 * vault no longer on the device is free, so deleting a vault never strands the mailbox. */
export function deviceKeyHome(storage: Pick<StorageAdapter, "getMeta" | "setMeta" | "removeMeta">) {
	return {
		async claim(vaultId: string): Promise<boolean> {
			const held = await storage.getMeta<string>(KEY_HOME);
			if (held === vaultId) return true;
			if (held) {
				const registry = parseRegistry(await storage.getMeta(VAULT_REGISTRY_KEY));
				if (findVault(registry, held)) return false;
			}
			await storage.setMeta(KEY_HOME, vaultId);
			return true;
		},
		async release(vaultId: string): Promise<void> {
			if ((await storage.getMeta<string>(KEY_HOME)) === vaultId) await storage.removeMeta(KEY_HOME);
		},
	};
}

export function createInProcessMailbox(platform: InProcessMailboxPlatform): InProcessMailbox {
	/** Which group and roster key an engine speaks for; null outside a group. */
	async function identity(vaultId: string): Promise<string | null> {
		const group = await platform.group(vaultId);
		return group?.groupKey ? `${group.groupKey}|${await platform.sigKey()}` : null;
	}

	function cryptoPort(): MailboxCryptoPort {
		const { mailboxId, mailboxSeal, mailboxOpen } = platform.crypto;
		if (!mailboxId || !mailboxSeal || !mailboxOpen) {
			throw new Error("this build has no mailbox crypto");
		}
		return {
			mailboxId: (groupKeyB64) => mailboxId(groupKeyB64),
			mailboxSeal: (groupKeyB64, aad, plaintext) => mailboxSeal(groupKeyB64, aad, plaintext),
			mailboxOpen: (groupKeyB64, aad, sealedB64) => mailboxOpen(groupKeyB64, aad, sealedB64),
			sign: platform.sign,
			verify: platform.verify,
		};
	}

	/** null: this vault cannot use a mailbox yet (no sync group). */
	async function build(
		vaultId: string,
		server: MailboxServer,
		current: () => boolean,
	): Promise<MailboxEngine | null> {
		const group = await platform.group(vaultId);
		if (!group?.groupKey) return null;
		const crypto = cryptoPort();
		const sigKey = await platform.sigKey();
		const mailboxId = await crypto.mailboxId(group.groupKey);
		const api = mailboxApi({
			http: platform.http,
			server,
			signer: { sigKey, sign: platform.sign },
			mailboxId,
		});
		const random = (n: number) => globalThis.crypto.getRandomValues(new Uint8Array(n));
		const { storage } = platform;
		const vault = createMailboxVaultPort({
			...platform.vaultDeps(vaultId),
			rejected: platform.refusedFor(vaultId),
			quarantine: {
				readQuarantine: (id) => storage.readQuarantine?.(id) ?? Promise.resolve(null),
				writeQuarantine: (json, id) => storage.writeQuarantine?.(json, id) ?? Promise.resolve(),
			},
			vaultId,
			current,
		});
		const sync = mailboxSync({
			api,
			crypto,
			// Its merges queue behind P2P's.
			vault: { ...vault, apply: (remote) => platform.queueApply(() => vault.apply(remote)) },
			blobs: platform.blobs(vaultId),
			groupKeyB64: group.groupKey,
			sigKey,
			state: metaStateStore(storage, mailboxStateKey(vaultId, mailboxId), random),
			random,
		});
		return { sync, api };
	}

	/** Set while the driver wants periodic rounds; the platform's tick supplies the period. */
	let armed = false;
	const driver = createMailboxDriver({
		build,
		identity,
		readSettings: async (vaultId) =>
			readMailboxSettings((await platform.vaultDeps(vaultId).readEntries()).settings),
		offHere: async (vaultId) =>
			(await platform.storage.getMeta<boolean>(syncKeyFor(MAILBOX_OFF_PREF_KEY, vaultId))) === true,
		writeStatus: (vaultId, record) => platform.storage.setMeta(mailboxStatusKey(vaultId), record),
		alarms: {
			create: () => {
				armed = true;
			},
			clear: () => {
				armed = false;
			},
		},
		// Each native request keeps the app alive for itself.
		keepAlive: (run) => run(),
		now: Date.now,
		hosted: platform.hosted,
		keyHome: deviceKeyHome(platform.storage),
	});

	return {
		driver,
		vaultSwitching(next) {
			if (!next || !driver.current(next)) driver.retarget(null);
		},
		init() {
			let watching: (() => void)[] = [];
			const unwatch = () => {
				for (const off of watching) off();
				watching = [];
			};
			const follow = (vaultId: string | null) => {
				unwatch();
				driver.retarget(vaultId);
				if (!vaultId) return;
				const changed = () => driver.changed();
				watching = [GROUP_KEY, MAILBOX_OFF_PREF_KEY].map(
					(key) =>
						platform.storage.subscribeMeta?.(syncKeyFor(key, vaultId), changed) ?? (() => {}),
				);
			};
			// Cues landing together are one round: the others share the quiet window, and the tick's
			// round takes in a change still waiting for it.
			const offs = [
				platform.onVaultStateChange((locked) => {
					if (locked) follow(null);
					else void platform.activeVaultId().then((id) => follow(id ?? null));
				}),
				platform.onVaultWritten((vaultId) => {
					if (driver.current(vaultId)) driver.changed();
				}),
				// A round at once, not through the quiet window's timer: a hidden window throttles
				// timers, which is why desktop ticks from the shell at all.
				platform.onTick(() => {
					if (armed) void driver.alarm();
				}),
				platform.onWake?.(() => driver.changed()) ?? (() => {}),
			];
			return () => {
				for (const off of offs) off();
				unwatch();
			};
		},
	};
}
