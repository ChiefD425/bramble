import { TRANSFER_INTERRUPTED } from "@core/adapters/http";
import type { BlobStore } from "@core/index";
import { beforeEach, describe, expect, it, vi } from "vitest";

// The native mover's JS half: the bytes stay on the native side both ways, and nothing the
// native side wrote is adopted unless it hashes to the address it was asked for.

const native = vi.hoisted(() => ({ send: vi.fn(), sendFile: vi.fn(), download: vi.fn() }));
vi.mock("@capacitor/core", () => ({
	registerPlugin: () => native,
	Capacitor: { isNativePlatform: () => true },
}));
vi.mock("@capacitor/filesystem", () => ({
	Directory: { Data: "DATA", Cache: "CACHE" },
	Filesystem: {
		getUri: async ({ path }: { path: string }) => ({ uri: `file:///data/${path}` }),
	},
}));

const { nativeBlobMover } = await import("./blob-mover");

const VAULT = "vault-a";
const HASH = "c".repeat(64);
const GET = { method: "GET" as const, url: "https://mailbox.example/v1/b", headers: { k: "v" } };
const PUT = { ...GET, method: "PUT" as const };

function fakeStore() {
	const calls: string[] = [];
	const store = {
		reserveStagingPath: vi.fn(async (token: string) => {
			calls.push(`reserve:${token}`);
			return `/data/blobs/${VAULT}/.staging-${token}`;
		}),
		adoptStagingPath: vi.fn(async (token: string, hash: string) => {
			calls.push(`adopt:${token}:${hash}`);
		}),
		discardStagingPath: vi.fn(async (token: string) => {
			calls.push(`discard:${token}`);
		}),
		size: vi.fn(async () => 5),
		read: vi.fn(),
	};
	return { store: store as unknown as BlobStore, spies: store, calls };
}

beforeEach(() => {
	native.send.mockReset();
	native.sendFile.mockReset();
	native.download.mockReset();
});

describe("nativeBlobMover", () => {
	it("downloads straight into staging and adopts a matching hash", async () => {
		const { store, spies, calls } = fakeStore();
		native.download.mockResolvedValue({ status: 200, sha256: HASH });
		expect(await nativeBlobMover(VAULT, store).download(HASH, GET)).toBe("stored");
		const token = spies.reserveStagingPath.mock.calls[0]?.[0];
		expect(native.download).toHaveBeenCalledWith({
			...GET,
			path: `/data/blobs/${VAULT}/.staging-${token}`,
		});
		expect(calls).toEqual([`reserve:${token}`, `adopt:${token}:${HASH}`]);
		expect(native.send).not.toHaveBeenCalled();
	});

	it("never adopts a body whose hash does not match", async () => {
		const { store, spies, calls } = fakeStore();
		native.download.mockResolvedValue({ status: 200, sha256: "d".repeat(64) });
		await expect(nativeBlobMover(VAULT, store).download(HASH, GET)).rejects.toThrow(
			"the downloaded blob does not match its hash",
		);
		const token = spies.reserveStagingPath.mock.calls[0]?.[0];
		expect(spies.adoptStagingPath).not.toHaveBeenCalled();
		expect(calls).toContain(`discard:${token}`);
	});

	it("a 404 is missing and leaves nothing staged", async () => {
		const { store, spies, calls } = fakeStore();
		native.download.mockResolvedValue({ status: 404, sha256: "e".repeat(64) });
		expect(await nativeBlobMover(VAULT, store).download(HASH, GET)).toBe("missing");
		const token = spies.reserveStagingPath.mock.calls[0]?.[0];
		expect(spies.adoptStagingPath).not.toHaveBeenCalled();
		expect(calls).toContain(`discard:${token}`);
	});

	it("any other answer is an error, and leaves nothing staged", async () => {
		const { store, spies } = fakeStore();
		native.download.mockResolvedValue({ status: 403, sha256: HASH });
		await expect(nativeBlobMover(VAULT, store).download(HASH, GET)).rejects.toMatchObject({
			status: 403,
		});
		expect(spies.adoptStagingPath).not.toHaveBeenCalled();
		expect(spies.discardStagingPath).toHaveBeenCalled();
	});

	it("a download the OS stopped leaves nothing staged and reads as interrupted", async () => {
		const { store, spies } = fakeStore();
		native.download.mockRejectedValue(Object.assign(new Error("closed"), { code: "interrupted" }));
		await expect(nativeBlobMover(VAULT, store).download(HASH, GET)).rejects.toThrow(
			TRANSFER_INTERRUPTED,
		);
		expect(spies.discardStagingPath).toHaveBeenCalled();
	});

	it("a retried download reuses its staging file, so an interrupted one never piles up", async () => {
		const { store, spies } = fakeStore();
		native.download.mockRejectedValueOnce(
			Object.assign(new Error("closed"), { code: "interrupted" }),
		);
		native.download.mockResolvedValueOnce({ status: 200, sha256: HASH });
		const mover = nativeBlobMover(VAULT, store);
		await expect(mover.download(HASH, GET)).rejects.toThrow(TRANSFER_INTERRUPTED);
		expect(await mover.download(HASH, GET)).toBe("stored");
		const [first, second] = spies.reserveStagingPath.mock.calls.map(([token]) => token);
		expect(second).toBe(first);
	});

	it("uploads from the blob's own file, never through the bridge", async () => {
		const { store, spies } = fakeStore();
		native.sendFile.mockResolvedValue({
			status: 200,
			body: btoa(JSON.stringify({ stored: true, recipients: 2 })),
		});
		expect(await nativeBlobMover(VAULT, store).upload(HASH, PUT)).toEqual({
			stored: true,
			recipients: 2,
		});
		expect(native.sendFile).toHaveBeenCalledWith({
			...PUT,
			path: `/data/blobs/${VAULT}/${HASH}`,
		});
		expect(native.send).not.toHaveBeenCalled();
		expect(spies.read).not.toHaveBeenCalled();
	});
});
