import { beforeEach, describe, expect, it, vi } from "vitest";

const { peek, remove } = vi.hoisted(() => ({
	peek: vi.fn(),
	remove: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@capacitor/core", () => ({
	registerPlugin: () => ({ peekPendingLogins: peek, removePendingLogins: remove }),
}));

const decryptWithVek = vi.fn();
vi.mock("./adapters/crypto", () => ({ mobileCrypto: { decryptWithVek } }));

const { peekPendingLogins, removePendingLogins } = await import("./autofill-pending-logins");

let n = 0;
const enc = (payload: string) => ({ iv: `iv${++n}`, ciphertext: btoa(payload) });

beforeEach(() => {
	vi.clearAllMocks();
	n = 0;
	peek.mockResolvedValue({ pending: [] });
	decryptWithVek.mockImplementation(async (_iv: string, ct: string) => {
		const s = atob(ct);
		if (s.includes("vault A")) throw new Error("aead failure");
		return s;
	});
});

describe("peekPendingLogins", () => {
	it("resolves [] when nothing is queued", async () => {
		await expect(peekPendingLogins()).resolves.toEqual([]);
		expect(remove).not.toHaveBeenCalled();
	});

	it("decrypts each login and keys it by its record, leaving it queued", async () => {
		const login = {
			name: "example.com",
			url: "https://example.com",
			username: "me",
			password: "pw",
		};
		peek.mockResolvedValue({ pending: [enc(JSON.stringify(login))] });
		await expect(peekPendingLogins()).resolves.toEqual([{ key: "iv1", ...login }]);
		expect(remove).not.toHaveBeenCalled();
	});

	it("leaves another vault's logins queued for it", async () => {
		peek.mockResolvedValue({ pending: [enc("from vault A")] });
		await expect(peekPendingLogins()).resolves.toEqual([]);
		expect(remove).not.toHaveBeenCalled();
	});

	it("removes records that decrypt to no usable login", async () => {
		peek.mockResolvedValue({
			pending: [enc(JSON.stringify({ username: "me" })), enc("not json")],
		});
		await expect(peekPendingLogins()).resolves.toEqual([]);
		expect(remove).toHaveBeenCalledWith({ ivs: ["iv1", "iv2"] });
	});

	it("reads missing text fields as empty", async () => {
		peek.mockResolvedValue({ pending: [enc(JSON.stringify({ password: "pw" }))] });
		await expect(peekPendingLogins()).resolves.toEqual([
			{ key: "iv1", name: "", url: "", username: "", password: "pw" },
		]);
	});

	it("resolves [] when the bridge method is absent (old build)", async () => {
		peek.mockRejectedValue(new Error("not implemented"));
		await expect(peekPendingLogins()).resolves.toEqual([]);
	});
});

describe("removePendingLogins", () => {
	it("removes by record", async () => {
		await removePendingLogins(["iv1"]);
		expect(remove).toHaveBeenCalledWith({ ivs: ["iv1"] });
	});

	it("skips the bridge for nothing", async () => {
		await removePendingLogins([]);
		expect(remove).not.toHaveBeenCalled();
	});
});
