// How the mailbox engine reads and merges the vault. Merging goes through applyRemotePayload, the
// same path P2P uses; what it refuses is quarantined here, and a merge that cannot run (the vault
// locked or switched) answers null so the engine retries rather than acknowledging.

import {
	appendQuarantine,
	type QuarantinedMessage,
	type QuarantineStore,
} from "../../vault/quarantine";
import type { EncryptedEntry } from "../../vault-format";
import { applyRemotePayload, type VaultSyncPort } from "../apply-remote";
import type { EntriesPayload } from "../entries-payload";
import { decodeRoster, encodeRoster, mergeRemoteRoster, type RosterPayload } from "../roster";

export interface MailboxEnvelope {
	entries: EntriesPayload;
	roster: RosterPayload;
}

export interface MailboxApplied {
	setAside: boolean;
	refused: EncryptedEntry[];
}

export interface MailboxVaultPort {
	readLocal(): Promise<MailboxEnvelope>;
	/** The roster after merging `remote`'s verified entries, not written. */
	previewRoster(remote: RosterPayload): Promise<RosterPayload>;
	/**
	 * Merge, quarantining refused entries; resolve once written. `null`: the merge did not run
	 * (locked, or another vault is active): retry later, never acknowledge.
	 */
	apply(remote: MailboxEnvelope): Promise<MailboxApplied | null>;
	quarantine(add: { messages: Omit<QuarantinedMessage, "quarantinedAt">[] }): Promise<void>;
	/** False once the vault this port was built for is no longer the one unlocked. */
	current(): boolean;
}

export function createMailboxVaultPort(deps: {
	sync: VaultSyncPort;
	rejected: Set<string>;
	readEntries(): Promise<EntriesPayload>;
	readRoster(): Promise<RosterPayload>;
	writeRoster(roster: RosterPayload): Promise<void>;
	/** verifyRosterEnvelope bound to this host's roster_verify; null when unparsable. */
	verifyRoster(rosterJson: string): Promise<string | null>;
	quarantine: QuarantineStore;
	vaultId: string;
	/** False once the vault this port was built for is no longer the one unlocked. */
	current?(): boolean;
}): MailboxVaultPort {
	const current = () => deps.current?.() ?? true;
	const store = { storage: deps.quarantine, vaultId: deps.vaultId };
	const verified = async (remote: RosterPayload) => {
		const json = await deps.verifyRoster(encodeRoster(remote));
		return json === null ? null : decodeRoster(json);
	};

	return {
		readLocal: async () => ({ entries: await deps.readEntries(), roster: await deps.readRoster() }),
		async previewRoster(remote) {
			const local = await deps.readRoster();
			const ok = await verified(remote);
			return ok ? mergeRemoteRoster(local, ok) : local;
		},
		async apply(remote) {
			if (!current()) return null;
			const ok = await verified(remote.roster);
			if (ok) {
				const local = await deps.readRoster();
				const merged = mergeRemoteRoster(local, ok);
				if (encodeRoster(merged) !== encodeRoster(local)) await deps.writeRoster(merged);
			}
			const result = await applyRemotePayload(deps.sync, remote.entries, {
				rejected: deps.rejected,
			});
			if (result.refused.length > 0) await appendQuarantine(store, { entries: result.refused });
			// Switched mid-merge: an idempotent merge repeats next sync rather than being acknowledged.
			if (!current()) return null;
			return { setAside: result.setAside, refused: result.refused };
		},
		quarantine: (add) => appendQuarantine(store, add),
		current,
	};
}
