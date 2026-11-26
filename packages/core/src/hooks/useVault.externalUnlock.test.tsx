/** @vitest-environment happy-dom */
// Unlocking in the macOS AutoFill extension unlocks the app: the shell loads the key and says so,
// and the window opens the vault as it does after its own Touch ID, so the next fill (the
// password page of a two-step sign-in) asks for nothing.

import { act, cleanup, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Platform } from "../context/PlatformContext";
import { mountVault } from "../test/vault-harness";
import { bytesToBase64 } from "../util/bytes";
import { VAULT_REGISTRY_KEY } from "../vault/vault-registry";

afterEach(cleanup);

vi.mock("../vault-format", async (importOriginal) => ({
	...(await importOriginal<typeof import("../vault-format")>()),
	decodeVaultBlob: () => ({
		slots: [],
		entriesIv: new Uint8Array(12),
		entriesCiphertext: new Uint8Array([1]),
	}),
}));

const at = (wall: number) => ({ wall, counter: 0, node: "mac" });
const LOGIN = JSON.stringify({
	type: "login",
	name: "Google",
	urls: [],
	username: "u",
	password: "p",
});
const PAYLOAD = JSON.stringify({
	entries: [
		{
			id: "e1",
			wrappedDek: "w",
			dekIv: "d",
			iv: "i",
			ciphertext: `ct:${LOGIN}`,
			hlc: at(1),
			vv: { mac: at(1) },
		},
	],
	tombstones: [],
});

function makePlatform() {
	let heard: ((vaultId: string) => void) | null = null;
	let locked = true;
	const crypto = {
		isLocked: async () => locked,
		onExternalLock: () => () => {},
		onExternalChange: () => () => {},
		onExternalUnlock: (cb: (vaultId: string) => void) => {
			heard = cb;
			return () => {
				heard = null;
			};
		},
		decryptWithVek: async () => PAYLOAD,
		decryptEntries: async (ps: { ciphertext: string }[]) => ps.map((p) => p.ciphertext.slice(3)),
		encryptWithVek: async () => ({
			iv: "AAAAAAAAAAAAAAAA",
			ciphertext: bytesToBase64(new Uint8Array([1])),
		}),
		lock: vi.fn(async () => {
			locked = true;
		}),
	};
	const meta = new Map<string, unknown>([
		[VAULT_REGISTRY_KEY, { vaults: [{ id: "v1", label: "Personal", createdAt: 1 }] }],
	]);
	const platform = {
		target: "desktop",
		storage: {
			getMeta: async (k: string) => meta.get(k),
			setMeta: async (k: string, v: unknown) => void meta.set(k, v),
			removeMeta: async (k: string) => void meta.delete(k),
			hasVaultHandle: async () => true,
			readVaultBlob: async () => new Uint8Array([1]),
			writeVaultBlob: async () => {},
			readQuarantine: async () => null,
			writeQuarantine: async () => {},
		},
		crypto: { ...crypto, withVault: () => crypto },
		autofill: { clearIndex: async () => {}, setIndex: async () => {} },
		shell: {
			setActiveVault: async () => {},
			getActiveVault: async () => "v1",
			notifyVaultOpened: vi.fn(async () => {}),
			onSyncStatus: () => () => {},
			onSyncEvent: () => () => {},
			flushPendingCornerCapture: async () => false,
		},
		clipboard: {},
	} as unknown as Platform;
	return {
		platform,
		/** AutoFill was unlocked for `vaultId`. Rust keeps a key only for the vault it has open, v1
		 * here, so another vault's unlock leaves the shell locked; the event is sent anyway, to check
		 * the window ignores it. (Unlocking the shell for any vault let the mount's own lock check
		 * race the event and open the vault, so this test failed about half the time.) */
		unlockedInAutofill: (vaultId: string) => {
			if (vaultId === "v1") locked = false;
			heard?.(vaultId);
		},
		listening: () => heard !== null,
	};
}

describe("an unlock in AutoFill unlocks the app", () => {
	it("opens the active vault when AutoFill unlocked it", async () => {
		const p = makePlatform();
		const vault = mountVault(p.platform);
		await waitFor(() => expect(p.listening()).toBe(true));
		expect(vault.state().isLocked).toBe(true);

		await act(async () => p.unlockedInAutofill("v1"));

		await waitFor(() => expect(vault.state().isLocked).toBe(false));
		expect(vault.state().entries.map((e) => e.id)).toEqual(["e1"]);
	});

	it("stays locked when AutoFill unlocked another vault", async () => {
		const p = makePlatform();
		const vault = mountVault(p.platform);
		await waitFor(() => expect(p.listening()).toBe(true));

		await act(async () => p.unlockedInAutofill("v2"));

		await new Promise((r) => setTimeout(r, 20));
		expect(vault.state().isLocked).toBe(true);
	});
});
