// Projects decrypted entries into the SSH keys a platform's agent may use. Only the desktop takes
// them (AutofillAdapter.setSshKeys); everywhere else they stay in the vault's own state. See
// docs/ssh-agent.md.

import type { Entry, SshKeyEntry } from "../hooks/useVault";

/** One SSH key as the desktop agent receives it. */
export interface SshKeyForAgent {
	id: string;
	name: string;
	privateKey: string;
	passphrase?: string;
	hosts: string[];
}

/** Live SSH keys with a private key the agent may use, the one used last first, then by name. */
export function toSshKeys(entries: Entry[]): SshKeyForAgent[] {
	return entries
		.filter(
			(e): e is SshKeyEntry =>
				e.type === "ssh-key" &&
				e.archivedAt === undefined &&
				e.privateKey.length > 0 &&
				e.agentDisabled !== true,
		)
		.sort(
			(a, b) =>
				(b.lastUsedAt ?? Number.NEGATIVE_INFINITY) - (a.lastUsedAt ?? Number.NEGATIVE_INFINITY) ||
				a.name.localeCompare(b.name),
		)
		.map((e) => ({
			id: e.id,
			name: e.name,
			privateKey: e.privateKey,
			...(e.passphrase ? { passphrase: e.passphrase } : {}),
			hosts: Array.isArray(e.hosts) ? e.hosts.filter((h) => typeof h === "string") : [],
		}));
}
