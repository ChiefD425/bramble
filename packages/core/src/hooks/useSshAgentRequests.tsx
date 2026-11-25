import { createContext, type ReactNode, useCallback, useContext, useEffect, useState } from "react";
import type { SshAgentRequest } from "../adapters/ssh-agent";
import { usePlatform } from "../context/PlatformContext";

interface SshAgentRequests {
	/** The request on screen: the oldest one not yet answered or finished. */
	current: SshAgentRequest | null;
	answer(approve: boolean): Promise<void>;
}

const Context = createContext<SshAgentRequests>({ current: null, answer: async () => {} });

/** One queue of the agent's requests for the whole window, so the cards and the unlock screen's
 * line see the same one, whichever mounted first. See docs/ssh-agent.md. */
export function SshAgentRequestsProvider({ children }: { children: ReactNode }) {
	const { sshAgent } = usePlatform();
	const [queue, setQueue] = useState<SshAgentRequest[]>([]);

	useEffect(() => {
		if (!sshAgent) return;
		const stopRequests = sshAgent.onRequest((r) =>
			setQueue((q) => [...q.filter((x) => x.id !== r.id), r]),
		);
		const stopDone = sshAgent.onDone((id) => setQueue((q) => q.filter((x) => x.id !== id)));
		return () => {
			stopRequests();
			stopDone();
		};
	}, [sshAgent]);

	const current = queue[0] ?? null;
	const answer = useCallback(
		async (approve: boolean) => {
			if (!sshAgent || !current) return;
			setQueue((q) => q.filter((x) => x.id !== current.id));
			await sshAgent.answer(current.id, approve);
		},
		[sshAgent, current],
	);

	return <Context.Provider value={{ current, answer }}>{children}</Context.Provider>;
}

export function useSshAgentRequests(): SshAgentRequests {
	return useContext(Context);
}
