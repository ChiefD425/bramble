/**
 * The desktop app's SSH agent: its settings and status, and the requests it brings the window
 * forward for. Desktop only, and absent everywhere else, where the Settings section and the
 * request cards simply don't render. See docs/ssh-agent.md.
 */

/** Why a key can't be used, as the desktop names it. */
export type SshKeyProblem =
	| "encrypted-pem"
	| "security-key"
	| "dsa"
	| "wrong-passphrase"
	| "unsupported"
	| "unreadable";

export interface SshAgentStatus {
	enabled: boolean;
	askEachUse: boolean;
	onlyTheirHosts: boolean;
	/** Where `~/.ssh/config` includes Bramble's config: first, lower down, or not at all. */
	setup: "set-up" | "not-added" | "not-first";
	/** Bramble may add the line itself: false for a symlinked or read-only config. */
	canAddLine: boolean;
	includeLine: string;
	error?: "path-too-long" | "bind-failed";
	unusable: { entryId: string; name: string; reason: SshKeyProblem }[];
	leftOut: { entryId: string; name: string; host: string }[];
}

/** A question the agent needs the user for. */
export interface SshAgentRequest {
	id: string;
	vaultId?: string;
	vaultName?: string;
	keyName?: string;
	/** The calling program's name: a label, never proof of anything. */
	caller: string;
	purpose?: "sign-in" | "git" | "message";
	/** The server, for a request forwarded with `ssh -A`. */
	server?: string;
	mode: "unlock" | "switch" | "confirm" | "allow-server";
}

export interface SshAgentAdapter {
	status(): Promise<SshAgentStatus>;
	set(
		patch: Partial<Pick<SshAgentStatus, "enabled" | "askEachUse" | "onlyTheirHosts">>,
	): Promise<SshAgentStatus>;
	addIncludeLine(): Promise<SshAgentStatus>;
	onRequest(callback: (request: SshAgentRequest) => void): () => void;
	onDone(callback: (id: string) => void): () => void;
	answer(id: string, approve: boolean): Promise<void>;
}
