/** @vitest-environment happy-dom */
import { i18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { SshAgentAdapter, SshAgentStatus } from "../../../../adapters/ssh-agent";
import { type Platform, PlatformProvider } from "../../../../context/PlatformContext";
import { SshAgentSection } from "./SshAgentSection";

const h = vi.hoisted(() => ({ calls: [] as string[] }));

vi.mock("../../../../hooks/useVault", async (importOriginal) => ({
	...(await importOriginal<typeof import("../../../../hooks/useVault")>()),
	useVaultActions: () => ({
		refreshAutofillIndex: async () => {
			h.calls.push("refresh");
		},
	}),
}));

afterEach(() => {
	cleanup();
	h.calls = [];
});

beforeAll(() => {
	i18n.load("en", {});
	i18n.activate("en");
});

const OFF: SshAgentStatus = {
	enabled: false,
	askEachUse: false,
	onlyTheirHosts: false,
	setup: "not-added",
	canAddLine: true,
	includeLine: "Include ~/.ssh/bramble/config",
	unusable: [],
	leftOut: [],
};
const ON: SshAgentStatus = { ...OFF, enabled: true };

function adapter(start: SshAgentStatus, after: Partial<SshAgentStatus> = {}) {
	let current = start;
	return {
		status: vi.fn(async () => current),
		set: vi.fn(async (patch: Partial<SshAgentStatus>) => {
			h.calls.push(`set ${JSON.stringify(patch)}`);
			current = { ...current, ...patch, ...after };
			return current;
		}),
		addIncludeLine: vi.fn(async () => {
			current = { ...current, setup: "set-up" as const };
			return current;
		}),
		onRequest: () => () => {},
		onDone: () => () => {},
		answer: async () => {},
	} satisfies SshAgentAdapter;
}

function mount(sshAgent?: SshAgentAdapter) {
	const copy = vi.fn(async () => {});
	const platform = { sshAgent, clipboard: { copy } } as unknown as Platform;
	render(
		<I18nProvider i18n={i18n}>
			<PlatformProvider platform={platform}>
				<SshAgentSection />
			</PlatformProvider>
		</I18nProvider>,
	);
	return { copy };
}

describe("SshAgentSection", () => {
	it("renders nothing without an adapter", () => {
		mount();
		expect(screen.queryByText("SSH agent")).toBeNull();
	});

	it("switching on enables the agent, then sends the open vault's keys", async () => {
		mount(adapter(OFF));
		fireEvent.click(await screen.findByRole("button", { name: "Toggle SSH agent" }));
		await waitFor(() => expect(h.calls).toEqual(['set {"enabled":true}', "refresh"]));
	});

	it("switching off disables it", async () => {
		const a = adapter(ON);
		mount(a);
		fireEvent.click(await screen.findByRole("button", { name: "Toggle SSH agent" }));
		await waitFor(() => expect(a.set).toHaveBeenCalledWith({ enabled: false }));
		expect(h.calls).not.toContain("refresh");
	});

	it("shows the setup line for each state and copies it", async () => {
		for (const [setup, title] of [
			["not-added", "Add this line to the top of ~/.ssh/config"],
			["not-first", "Move this line to the top of ~/.ssh/config"],
			["set-up", "Added to ~/.ssh/config"],
		] as const) {
			const { copy } = mount(adapter({ ...ON, setup }));
			expect(await screen.findByText(title)).toBeTruthy();
			fireEvent.click(screen.getByRole("button", { name: "Copy SSH config line" }));
			await waitFor(() => expect(copy).toHaveBeenCalledWith("Include ~/.ssh/bramble/config"));
			cleanup();
		}
	});

	it("Add it for me only when it can", async () => {
		const a = adapter(ON);
		mount(a);
		fireEvent.click(await screen.findByRole("button", { name: "Add it for me" }));
		expect(await screen.findByText("Added to ~/.ssh/config")).toBeTruthy();
		expect(a.addIncludeLine).toHaveBeenCalled();
		expect(screen.queryByRole("button", { name: "Add it for me" })).toBeNull();
		cleanup();
		mount(adapter({ ...ON, canAddLine: false }));
		await screen.findByText("Add this line to the top of ~/.ssh/config");
		expect(screen.queryByRole("button", { name: "Add it for me" })).toBeNull();
	});

	it("the two options call set", async () => {
		const a = adapter(ON);
		mount(a);
		fireEvent.click(await screen.findByRole("button", { name: "Ask before each use" }));
		await waitFor(() => expect(a.set).toHaveBeenCalledWith({ askEachUse: true }));
		await act(async () => {
			fireEvent.click(screen.getByRole("button", { name: "Offer keys only to their hosts" }));
		});
		await waitFor(() => expect(a.set).toHaveBeenCalledWith({ onlyTheirHosts: true }));
	});

	it("names keys it can't use, hosts it left out, and the fix", async () => {
		mount(
			adapter({
				...ON,
				unusable: [{ entryId: "1", name: "Old box", reason: "encrypted-pem" }],
				leftOut: [{ entryId: "2", name: "Deploy", host: "my server" }],
			}),
		);
		expect(
			await screen.findByText("Can't use Old box: it's in an old encrypted format"),
		).toBeTruthy();
		expect(screen.getByText("Left out my server on Deploy: not a host name")).toBeTruthy();
		expect(
			screen.getByText("Re-save a key in OpenSSH format with ssh-keygen -p -f <file>."),
		).toBeTruthy();
	});

	it("says when the path is too long", async () => {
		mount(adapter({ ...ON, error: "path-too-long" }));
		expect(
			await screen.findByText("Your home folder's path is too long for the agent's socket."),
		).toBeTruthy();
	});
});
