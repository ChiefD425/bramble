import type { BlobStore } from "@core/index";
import { beforeEach, describe, expect, it, vi } from "vitest";

// The desktop mover's webview half: a download is one shell command that lands and checks the
// blob itself, and an upload streams the blob through the shell in raw chunks.

const h = vi.hoisted(() => ({
	calls: [] as { cmd: string; args: unknown }[],
	download: async (): Promise<number> => 200,
}));

vi.mock("@tauri-apps/api/core", () => ({
	invoke: async (cmd: string, args: unknown) => {
		h.calls.push({ cmd, args });
		if (cmd === "files_download_blob") return h.download();
		if (cmd === "http_stream_open") return 3;
		if (cmd === "stream_finish") {
			return { status: 200, body: [...new TextEncoder().encode('{"stored":true,"recipients":1}')] };
		}
		return undefined;
	},
}));

const { desktopBlobMover } = await import("./blob-mover");

const VAULT = "vault-a";
const HASH = "c".repeat(64);
const GET = { method: "GET" as const, url: "https://mailbox.example/v1/b", headers: { k: "v" } };
const store = {
	size: async () => 3,
	read: async () => new Uint8Array([1, 2, 3]),
} as unknown as BlobStore;

beforeEach(() => {
	h.calls.length = 0;
	h.download = async () => 200;
});

describe("desktopBlobMover", () => {
	it("lands a download in the shell, which checks it, and reads it as stored", async () => {
		expect(await desktopBlobMover(VAULT, store).download(HASH, GET)).toBe("stored");
		expect(h.calls).toEqual([
			{ cmd: "files_download_blob", args: { vaultId: VAULT, hash: HASH, ...GET } },
		]);
	});

	it("a 404 is missing", async () => {
		h.download = async () => 404;
		expect(await desktopBlobMover(VAULT, store).download(HASH, GET)).toBe("missing");
	});

	it("any other answer is an error", async () => {
		h.download = async () => 403;
		await expect(desktopBlobMover(VAULT, store).download(HASH, GET)).rejects.toMatchObject({
			status: 403,
		});
	});

	it("a blob the shell refused to keep is an error", async () => {
		h.download = async () => {
			throw "the downloaded blob does not match its hash";
		};
		await expect(desktopBlobMover(VAULT, store).download(HASH, GET)).rejects.toBe(
			"the downloaded blob does not match its hash",
		);
	});

	it("streams an upload through the shell, never as a whole body", async () => {
		expect(await desktopBlobMover(VAULT, store).upload(HASH, { ...GET, method: "PUT" })).toEqual({
			stored: true,
			recipients: 1,
		});
		expect(h.calls.map((c) => c.cmd)).toEqual([
			"http_stream_open",
			"stream_write",
			"stream_finish",
		]);
	});
});
