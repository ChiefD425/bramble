// The app's SSH agent, as the window sees it: settings and status through commands, and the
// requests Rust brings the window forward for as events. See docs/ssh-agent.md.

import type { SshAgentAdapter, SshAgentRequest, SshAgentStatus } from "@core/adapters/ssh-agent";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

/** Listen to `event` until the returned function is called, even if that is before `listen`
 * resolves. */
function subscribe<T>(event: string, callback: (payload: T) => void): () => void {
	let stop: (() => void) | null = null;
	let gone = false;
	void listen<T>(event, (e) => callback(e.payload)).then((un) => {
		if (gone) un();
		else stop = un;
	});
	return () => {
		gone = true;
		stop?.();
	};
}

export const desktopSshAgent: SshAgentAdapter = {
	status: () => invoke<SshAgentStatus>("ssh_agent_status"),
	set: (patch) =>
		invoke<SshAgentStatus>("ssh_agent_set", {
			enabled: patch.enabled,
			askEachUse: patch.askEachUse,
		}),
	addIncludeLine: () => invoke<SshAgentStatus>("ssh_agent_add_include"),
	onRequest: (callback) => subscribe<SshAgentRequest>("ssh-agent://request", callback),
	onDone: (callback) => subscribe<{ id: string }>("ssh-agent://done", (p) => callback(p.id)),
	answer: (id, approve) => invoke<void>("ssh_agent_answer", { requestId: id, approve }),
	pending: () => invoke<SshAgentRequest[]>("ssh_agent_pending"),
};
