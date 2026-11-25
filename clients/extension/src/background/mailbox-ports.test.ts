import { afterEach, describe, expect, it, vi } from "vitest";
import { memoryStorageArea } from "../test/test-harness";

type HostMessage = { type?: string; vaultId?: string; payload?: Record<string, unknown> };
const { sendToOffscreen } = vi.hoisted(() => ({
	sendToOffscreen: vi.fn(async (_message: HostMessage) => ({
		ok: true,
		data: undefined as unknown,
	})),
}));
vi.mock("./offscreen-client", () => ({
	sendToOffscreen,
	setInProcessSyncBridge: vi.fn(),
	useOffscreenDoc: false,
	ensureOffscreen: vi.fn(async () => {}),
	markOffscreenKey: vi.fn(),
}));
vi.mock("./router", () => ({
	on: vi.fn(),
	onPrefix: vi.fn(),
	extensionOnly: (fn: unknown) => fn,
	setReady: vi.fn(),
}));
vi.mock("../offscreen-core", () => ({ setSyncBridge: vi.fn() }));
vi.mock("./sync-clock", () => ({ witnessStamp: vi.fn(async () => {}), witnessStamps: vi.fn() }));

const b64 = (fill: number) => btoa(String.fromCharCode(...new Uint8Array(32).fill(fill)));
const SIGNING = { secretKey: b64(2), publicKey: b64(3) };
const GROUP = { groupKey: b64(4), roster: { devices: [], revoked: [] } };
const MAILBOX = "M".repeat(43);
const SERVER = { url: "https://mailbox.example" };

function stubChrome(local: Record<string, unknown> = {}) {
	vi.stubGlobal("chrome", {
		storage: { local: memoryStorageArea(local), session: memoryStorageArea({}) },
		alarms: { create: vi.fn(), clear: vi.fn(async () => {}) },
		runtime: {
			onMessage: { addListener: vi.fn() },
			onConnect: { addListener: vi.fn() },
			sendMessage: vi.fn(async () => {}),
			id: "bramble-test",
			getURL: (p: string) => `https://bramble-test.example/${p}`,
		},
	});
	return local;
}

async function load() {
	vi.resetModules();
	return import("./mailbox-ports");
}

afterEach(() => {
	vi.unstubAllGlobals();
	vi.clearAllMocks();
});

describe("the extension's mailbox ports", () => {
	it("tags every mailbox op with its vault", async () => {
		stubChrome();
		const { mailboxCryptoPort } = await load();
		await mailboxCryptoPort("v1", SIGNING).mailboxSeal("G", "A", "P");
		expect(sendToOffscreen).toHaveBeenCalledWith({
			type: "CRYPTO_MAILBOX_SEAL",
			vaultId: "v1",
			payload: { groupKeyB64: "G", aad: "A", plaintext: "P" },
		});
	});

	it("signs with the vault's roster key in the host", async () => {
		stubChrome();
		const { mailboxCryptoPort } = await load();
		sendToOffscreen.mockResolvedValueOnce({ ok: true, data: "sig" });
		expect(await mailboxCryptoPort("v1", SIGNING).sign("m")).toBe("sig");
		expect(sendToOffscreen).toHaveBeenCalledWith({
			type: "SYNC_ROSTER_SIGN",
			payload: { secretB64: SIGNING.secretKey, message: "m" },
		});
	});

	it("verifies in the host, and a host failure is not a bad signature", async () => {
		stubChrome();
		const port = (await load()).mailboxCryptoPort("v1", SIGNING);
		sendToOffscreen.mockResolvedValueOnce({ ok: true, data: true });
		expect(await port.verify("K", "m", "s")).toBe(true);
		expect(sendToOffscreen).toHaveBeenLastCalledWith({
			type: "SYNC_SIG_VERIFY",
			payload: { publicB64: "K", message: "m", sigB64: "s" },
		});
		sendToOffscreen.mockResolvedValueOnce({ ok: true, data: false });
		expect(await port.verify("K", "m", "s")).toBe(false);
		// A silent host must make the round retry, never quarantine a message as forged.
		sendToOffscreen.mockResolvedValueOnce({
			ok: false,
			error: "no response from offscreen",
		} as never);
		await expect(port.verify("K", "m", "s")).rejects.toThrow("no response from offscreen");
	});

	it("a vault with no group is never read as an empty roster", async () => {
		stubChrome();
		const port = (await load()).mailboxVaultPort("v1", () => true);
		await expect(port.previewRoster({ devices: [], revoked: [] })).rejects.toThrow("no sync group");
	});

	it("names the engine's identity by group and signing key, or null without them", async () => {
		stubChrome({ "sync.group:v1": GROUP });
		expect(await (await load()).mailboxIdentity("v1")).toBeNull();
		stubChrome({ "sync.group:v1": GROUP, "sync.signingKey:v1": SIGNING });
		expect(await (await load()).mailboxIdentity("v1")).toBe(
			`${GROUP.groupKey}|${SIGNING.publicKey}`,
		);
	});

	it("passes the core's refusal through, so the envelope can read it", async () => {
		stubChrome();
		const port = (await load()).mailboxCryptoPort("v1", SIGNING);
		sendToOffscreen.mockResolvedValueOnce({ ok: false, error: "mailbox open failed" } as never);
		await expect(port.mailboxOpen("G", "A", "S")).rejects.toThrow("mailbox open failed");
	});

	it("builds nothing for a vault with no group or no signing key", async () => {
		stubChrome();
		expect(await (await load()).buildMailboxEngine("v1", SERVER, () => true)).toBeNull();
		stubChrome({ "sync.group:v1": GROUP });
		expect(await (await load()).buildMailboxEngine("v1", SERVER, () => true)).toBeNull();
	});

	it("keeps engine state per vault and mailbox", async () => {
		const local = stubChrome({ "sync.group:v1": GROUP, "sync.signingKey:v1": SIGNING });
		sendToOffscreen.mockImplementation(async (m: HostMessage) =>
			m.type === "CRYPTO_MAILBOX_ID" ? { ok: true, data: MAILBOX } : { ok: false, data: undefined },
		);
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => {
				throw new Error("offline");
			}),
		);
		const engine = await (await load()).buildMailboxEngine("v1", SERVER, () => true);
		expect(engine?.api.mailboxId).toBe(MAILBOX);
		expect(await engine?.sync.sync()).toBe("retry");
		expect(Object.keys(local)).toContain(`mailbox.state:v1:${MAILBOX}`);
	});
});
