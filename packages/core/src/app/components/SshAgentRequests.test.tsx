/** @vitest-environment happy-dom */
import { i18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { SshAgentAdapter, SshAgentRequest } from "../../adapters/ssh-agent";
import { type Platform, PlatformProvider } from "../../context/PlatformContext";
import { SshAgentRequestsProvider } from "../../hooks/useSshAgentRequests";
import { requestLine, SshAgentRequestLine, SshAgentRequests } from "./SshAgentRequests";

const h = vi.hoisted(() => ({
	isLocked: true,
	activeId: "P" as string | undefined,
	calls: [] as string[],
}));

vi.mock("../../hooks/useVault", () => ({
	useVault: () => ({ isLocked: h.isLocked }),
	useVaultActions: () => ({
		lock: async () => {
			h.calls.push("lock");
		},
	}),
}));
vi.mock("../../hooks/useVaultRegistry", () => ({
	useVaultRegistry: () => ({
		activeId: h.activeId,
		vaults: [
			{ id: "P", label: "Personal", createdAt: 1 },
			{ id: "W", label: "Work", createdAt: 2 },
		],
		selectVault: (id: string) => h.calls.push(`select ${id}`),
	}),
}));

afterEach(cleanup);
beforeAll(() => {
	i18n.load("en", {});
	i18n.activate("en");
});
beforeEach(() => {
	h.isLocked = true;
	h.activeId = "P";
	h.calls = [];
});

function fakeAgent(waiting: SshAgentRequest[] = []) {
	let onRequest: ((r: SshAgentRequest) => void) | null = null;
	let onDone: ((id: string) => void) | null = null;
	const answers: [string, boolean][] = [];
	const adapter = {
		status: async () => {
			throw new Error("unused");
		},
		set: async () => {
			throw new Error("unused");
		},
		addIncludeLine: async () => {
			throw new Error("unused");
		},
		onRequest: (cb: (r: SshAgentRequest) => void) => {
			onRequest = cb;
			return () => {};
		},
		onDone: (cb: (id: string) => void) => {
			onDone = cb;
			return () => {};
		},
		answer: async (id: string, approve: boolean) => {
			answers.push([id, approve]);
		},
		pending: async () => waiting,
	} satisfies SshAgentAdapter;
	return {
		adapter,
		answers,
		ask: (r: Partial<SshAgentRequest>) =>
			act(() => onRequest?.({ id: "r1", caller: "ssh", mode: "unlock", ...r })),
		done: (id: string) => act(() => onDone?.(id)),
	};
}

function tree(sshAgent?: SshAgentAdapter) {
	return (
		<I18nProvider i18n={i18n}>
			<PlatformProvider platform={{ sshAgent } as unknown as Platform}>
				<SshAgentRequestsProvider>
					<SshAgentRequests />
					<SshAgentRequestLine />
				</SshAgentRequestsProvider>
			</PlatformProvider>
		</I18nProvider>
	);
}

function mount(sshAgent?: SshAgentAdapter) {
	return render(tree(sshAgent));
}

const deploy = { keyName: "Deploy", purpose: "git" as const };

describe("SSH agent requests", () => {
	it("selects the requested vault while locked", async () => {
		const agent = fakeAgent();
		mount(agent.adapter);
		await agent.ask({ ...deploy, vaultId: "W", vaultName: "Work" });
		await waitFor(() => expect(h.calls).toEqual(["select W"]));
	});

	it("shows the line on that vault's unlock screen only", async () => {
		const agent = fakeAgent();
		mount(agent.adapter);
		await agent.ask({ ...deploy, vaultId: "P", vaultName: "Personal" });
		expect(screen.getByText("ssh wants to sign a git commit with Deploy")).toBeTruthy();
		cleanup();
		h.activeId = "W";
		const other = fakeAgent();
		mount(other.adapter);
		await other.ask({ ...deploy, vaultId: "P", vaultName: "Personal", id: "r2" });
		expect(screen.queryByText("ssh wants to sign a git commit with Deploy")).toBeNull();
	});

	it("a request with no vault shows on any unlock screen", async () => {
		const agent = fakeAgent();
		mount(agent.adapter);
		await agent.ask({ server: "bastion" });
		expect(screen.getByText("bastion wants to use your SSH keys")).toBeTruthy();
		fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
		await waitFor(() => expect(agent.answers).toEqual([["r1", false]]));
		expect(screen.queryByText("bastion wants to use your SSH keys")).toBeNull();
	});

	it("the switch card locks, then opens the key's vault", async () => {
		h.isLocked = false;
		const agent = fakeAgent();
		mount(agent.adapter);
		await agent.ask({ ...deploy, mode: "switch", vaultId: "W", vaultName: "Work" });
		expect(screen.getByText("Open Work?")).toBeTruthy();
		expect(screen.getByText("ssh wants to use Deploy from Work. Personal will lock.")).toBeTruthy();
		fireEvent.click(screen.getByRole("button", { name: "Open Work" }));
		await waitFor(() => expect(h.calls).toEqual(["lock", "select W"]));
		expect(agent.answers).toEqual([]);
	});

	it("Cancel answers no and leaves the open vault open", async () => {
		h.isLocked = false;
		const agent = fakeAgent();
		mount(agent.adapter);
		await agent.ask({ ...deploy, mode: "switch", vaultId: "W", vaultName: "Work" });
		fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
		await waitFor(() => expect(agent.answers).toEqual([["r1", false]]));
		expect(h.calls).toEqual([]);
		expect(screen.queryByText("Open Work?")).toBeNull();
	});

	it("the confirm card's Allow answers yes", async () => {
		h.isLocked = false;
		const agent = fakeAgent();
		mount(agent.adapter);
		await agent.ask({ keyName: "Deploy", purpose: "sign-in", mode: "confirm", vaultId: "P" });
		expect(screen.getByText("Allow this use of Deploy?")).toBeTruthy();
		expect(screen.getByText("ssh wants to sign in to a server with Deploy")).toBeTruthy();
		fireEvent.click(screen.getByRole("button", { name: "Allow" }));
		await waitFor(() => expect(agent.answers).toEqual([["r1", true]]));
	});

	it("the server card names the server", async () => {
		h.isLocked = false;
		const agent = fakeAgent();
		mount(agent.adapter);
		await agent.ask({ mode: "allow-server", server: "bastion.example" });
		expect(screen.getByText("Let bastion.example use your SSH keys?")).toBeTruthy();
		fireEvent.click(screen.getByRole("button", { name: "Deny" }));
		await waitFor(() => expect(agent.answers).toEqual([["r1", false]]));
	});

	it("a done request disappears", async () => {
		h.isLocked = false;
		const agent = fakeAgent();
		mount(agent.adapter);
		await agent.ask({ keyName: "Deploy", mode: "confirm", vaultId: "P" });
		expect(screen.getByText("Allow this use of Deploy?")).toBeTruthy();
		await agent.done("r1");
		expect(screen.queryByText("Allow this use of Deploy?")).toBeNull();
	});

	it("picks up requests asked before the window opened", async () => {
		const agent = fakeAgent([
			{ id: "r0", caller: "ssh", mode: "unlock", vaultId: "P", keyName: "Deploy", purpose: "git" },
		]);
		mount(agent.adapter);
		expect(await screen.findByText("ssh wants to sign a git commit with Deploy")).toBeTruthy();
	});

	it("picking another vault while locked isn't undone", async () => {
		const agent = fakeAgent();
		const { rerender } = mount(agent.adapter);
		await agent.ask({ ...deploy, vaultId: "W", vaultName: "Work" });
		await waitFor(() => expect(h.calls).toEqual(["select W"]));
		h.activeId = "W";
		rerender(tree(agent.adapter));
		h.activeId = "P";
		rerender(tree(agent.adapter));
		await act(async () => {});
		expect(h.calls).toEqual(["select W"]);
	});

	it("renders nothing without an adapter", () => {
		mount();
		expect(document.body.textContent).toBe("");
	});

	it("words each kind of request", () => {
		const r = (over: Partial<SshAgentRequest>) =>
			requestLine({ id: "x", caller: "git", mode: "unlock", keyName: "Deploy", ...over });
		expect(r({ purpose: "git" })).toBe("git wants to sign a git commit with Deploy");
		expect(r({ purpose: "message" })).toBe("git wants to sign a message with Deploy");
		expect(r({ purpose: "sign-in" })).toBe("git wants to sign in to a server with Deploy");
		expect(r({ keyName: undefined, server: "bastion" })).toBe("bastion wants to use your SSH keys");
		expect(r({ server: "bastion" })).toBe("bastion wants to use Deploy");
	});
});
