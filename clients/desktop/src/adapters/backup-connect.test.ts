import type { BackupTargetConfig } from "@core/backup/config";
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
	calls: [] as { cmd: string; args: unknown }[],
	connected: { stored: true } as { stored: boolean; refreshToken?: string },
	meta: new Map<string, unknown>(),
}));

vi.mock("@tauri-apps/api/core", () => ({
	invoke: async (cmd: string, args: unknown) => {
		h.calls.push({ cmd, args });
		if (cmd === "backup_oauth_connect") return h.connected;
		throw new Error(`unexpected ${cmd}`);
	},
}));
vi.mock("./storage", () => ({
	desktopStorage: {
		getMeta: async (k: string) => h.meta.get(k),
		setMeta: async (k: string, v: unknown) => void h.meta.set(k, v),
	},
}));
vi.mock("./crypto", () => ({
	desktopCrypto: {
		encryptWithVek: async (plaintext: string) => ({ iv: "IV", ciphertext: `sealed:${plaintext}` }),
	},
}));

const { connectBackupOAuth } = await import("./backup-connect");
const KEY = "backup.targets:v1";
const targets = () => (h.meta.get(KEY) ?? []) as BackupTargetConfig[];

beforeEach(() => {
	h.calls = [];
	h.connected = { stored: true };
	h.meta = new Map();
});

describe("connectBackupOAuth (desktop)", () => {
	it("signs in through the shell and stores an OS-held target", async () => {
		await connectBackupOAuth("gdrive", { vaultId: "v1" });
		const [t] = targets();
		expect(t).toMatchObject({ providerId: "gdrive", provider: "gdrive", creds: { wrap: "os" } });
		expect(h.calls[0]).toEqual({
			cmd: "backup_oauth_connect",
			args: { vaultId: "v1", targetId: t!.id, provider: "gdrive" },
		});
	});

	it("with no keychain, keeps the refresh token sealed under the vault key", async () => {
		h.connected = { stored: false, refreshToken: "RT" };
		await connectBackupOAuth("dropbox", { vaultId: "v1" });
		expect(targets()[0]!.creds).toEqual({ iv: "IV", ciphertext: 'sealed:{"refreshToken":"RT"}' });
	});

	it("reconnect keeps the target id and clears its error", async () => {
		h.meta.set(KEY, [
			{ id: "t9", providerId: "gdrive", provider: "gdrive", creds: { wrap: "os" }, lastError: "x" },
		]);
		await connectBackupOAuth("gdrive", { vaultId: "v1", targetId: "t9" });
		expect(targets()).toHaveLength(1);
		expect(targets()[0]).toMatchObject({ id: "t9", lastError: undefined });
		expect((h.calls[0]!.args as { targetId: string }).targetId).toBe("t9");
	});

	it("needs a vault", async () => {
		await expect(connectBackupOAuth("gdrive", {})).rejects.toThrow(/Unlock/);
		expect(h.calls).toHaveLength(0);
	});
});
