import { beforeEach, describe, expect, it, vi } from "vitest";

const { invoke, handlers } = vi.hoisted(() => ({
	invoke: vi.fn(async (_cmd: string, _args?: unknown): Promise<unknown> => ({})),
	handlers: new Map<string, (e: { payload: unknown }) => void>(),
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("@tauri-apps/api/event", () => ({
	listen: async (event: string, handler: (e: { payload: unknown }) => void) => {
		handlers.set(event, handler);
		return () => handlers.delete(event);
	},
}));

const { desktopSshAgent } = await import("./ssh-agent");

beforeEach(() => {
	invoke.mockClear();
	handlers.clear();
});

describe("desktopSshAgent", () => {
	it("sends only the settings it was given", async () => {
		await desktopSshAgent.set({ askEachUse: true });
		expect(invoke).toHaveBeenCalledWith("ssh_agent_set", {
			enabled: undefined,
			askEachUse: true,
		});
	});

	it("answers a request by its id", async () => {
		await desktopSshAgent.answer("r1", false);
		expect(invoke).toHaveBeenCalledWith("ssh_agent_answer", { requestId: "r1", approve: false });
	});

	it("asks Rust for the requests already waiting", async () => {
		invoke.mockResolvedValueOnce([{ id: "r0", mode: "unlock" }]);
		expect(await desktopSshAgent.pending()).toEqual([{ id: "r0", mode: "unlock" }]);
		expect(invoke).toHaveBeenCalledWith("ssh_agent_pending");
	});

	it("passes requests and their end to the window", async () => {
		const seen: unknown[] = [];
		const stop = desktopSshAgent.onRequest((r) => seen.push(r));
		const stopDone = desktopSshAgent.onDone((id) => seen.push(`done ${id}`));
		await vi.waitFor(() => expect(handlers.size).toBe(2));
		handlers.get("ssh-agent://request")?.({ payload: { id: "r1", mode: "unlock" } });
		handlers.get("ssh-agent://done")?.({ payload: { id: "r1" } });
		expect(seen).toEqual([{ id: "r1", mode: "unlock" }, "done r1"]);
		stop();
		stopDone();
		expect(handlers.size).toBe(0);
	});
});
