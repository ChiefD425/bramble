import { beforeEach, describe, expect, it, vi } from "vitest";

// The vault-written cue the mailbox listens for: fired once the shell has the bytes, never for a
// write that failed.

const h = vi.hoisted(() => ({ fail: false, written: [] as string[] }));

vi.mock("@tauri-apps/api/core", () => ({
	invoke: async (command: string, args: { vaultId?: string }) => {
		if (command !== "storage_write_vault") return null;
		if (h.fail) throw new Error("disk full");
		h.written.push(args.vaultId ?? "");
	},
}));

const { desktopStorage, onVaultWritten } = await import("./storage");

beforeEach(() => {
	h.fail = false;
	h.written.length = 0;
});

describe("onVaultWritten", () => {
	it("tells listeners which vault was written, once the shell has it", async () => {
		const seen: string[] = [];
		const off = onVaultWritten((id) => seen.push(`${id}:${h.written.includes(id)}`));
		await desktopStorage.writeVaultBlob(new Uint8Array([1]), "a");
		expect(seen).toEqual(["a:true"]);
		off();
		await desktopStorage.writeVaultBlob(new Uint8Array([2]), "a");
		expect(seen).toHaveLength(1);
	});

	it("tells no one about a write that failed", async () => {
		const seen: string[] = [];
		onVaultWritten((id) => seen.push(id));
		h.fail = true;
		await expect(desktopStorage.writeVaultBlob(new Uint8Array([1]), "a")).rejects.toThrow();
		expect(seen).toEqual([]);
	});
});
