/** @vitest-environment happy-dom */
// The macOS and iOS AutoFill extensions unlock and fill from a copy of one vault. It has to be the
// vault the app just opened, and it has to follow that vault's password and name: a copy that mixes
// in the last vault's password asks for the wrong one, and a stale one still opens with an old one.
import { act, cleanup, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Platform } from "../context/PlatformContext";
import { mountVault } from "../test/vault-harness";
import { VAULT_REGISTRY_KEY } from "../vault/vault-registry";
import { SLOT_KIND_PASSWORD, SLOT_KIND_WEBAUTHN } from "../vault-format";

afterEach(cleanup);

vi.mock("../vault-format", async (importOriginal) => ({
	...(await importOriginal<typeof import("../vault-format")>()),
	decodeVaultBlob: () => ({
		slots: [
			{
				kind: SLOT_KIND_PASSWORD,
				slotId: new Uint8Array(16),
				salt: new Uint8Array(16),
				verifier: new Uint8Array(32),
				wrapIv: new Uint8Array(12),
				wrappedVek: new Uint8Array(48),
			},
			{
				kind: SLOT_KIND_WEBAUTHN,
				slotId: new Uint8Array(16).fill(1),
				credentialId: new Uint8Array([1]),
				salt: new Uint8Array(32),
				verifier: new Uint8Array(32),
				wrapIv: new Uint8Array(12),
				wrappedVek: new Uint8Array(48),
			},
		],
		entriesIv: new Uint8Array(12),
		entriesCiphertext: new Uint8Array([1]),
	}),
	encodeVaultBlob: () => new Uint8Array([1, 2, 3]),
}));

// Two vaults, and the last session left "Old" as the active one: the state a switch starts from.
function makePlatform() {
	const meta = new Map<string, unknown>([
		[
			VAULT_REGISTRY_KEY,
			{
				vaults: [
					{ id: "vault-old", label: "Old", createdAt: 1 },
					{ id: "vault-new", label: "Personal", createdAt: 2 },
				],
			},
		],
		["active-vault", "vault-old"],
	]);
	let locked = true;
	// In order: which vault was recorded as active, and which vault's key was opened.
	const events: string[] = [];
	// The vault each provider copy was written for (undefined: written without one).
	const copies: (string | undefined)[] = [];
	const autofill = (vaultId?: string) => ({
		clearIndex: async () => {},
		setIndex: async () => void copies.push(vaultId),
		withVault: (id: string) => autofill(id),
	});
	const platform = {
		storage: {
			getMeta: async (k: string) => meta.get(k),
			setMeta: async (k: string, v: unknown) => void meta.set(k, v),
			removeMeta: async (k: string) => void meta.delete(k),
			hasVaultHandle: async () => true,
			readVaultBlob: async () => new Uint8Array([1]),
			writeVaultBlob: async () => {},
			restoreVaultFromBackup: async () => false,
			readQuarantine: async () => null,
			writeQuarantine: async () => {},
		},
		crypto: {
			isLocked: async () => locked,
			onExternalLock: () => () => {},
			onExternalChange: () => () => {},
			unwrapVekPassword: async () => {
				events.push("unwrap:password");
				locked = false;
				return true;
			},
			decryptWithVek: async () => JSON.stringify({ entries: [], tombstones: [] }),
			decryptEntries: async () => [],
			encryptEntry: async () => ({
				ciphertext: "Yw==",
				iv: "aXY=",
				wrappedDek: "ZA==",
				dekIv: "aXY=",
			}),
			encryptWithVek: async () => ({ ciphertext: "Yw==", iv: "aXY=" }),
			generateSalt: async () => "AAAAAAAAAAAAAAAAAAAAAA==",
			generateSlotId: async () => "AAAAAAAAAAAAAAAAAAAAAA==",
			wrapVekPassword: async () => ({
				verifier: "AAAA",
				wrapIv: "AAAAAAAAAAAAAAAA",
				wrappedVek: "AAAA",
			}),
			verifyPasswordSlot: async () => true,
			lock: async () => {
				locked = true;
			},
		},
		autofill: autofill(),
		biometric: {
			holdsKeyNatively: true,
			isAvailable: async () => true,
			biometryEnrolled: async () => true,
			biometryType: async () => "touchId",
			isEnabled: async () => true,
			unlock: async (id: string) => {
				events.push(`unwrap:${id}`);
				locked = false;
				return null;
			},
			disable: async () => {},
		},
		shell: {
			setActiveVault: async (id: string | null) => {
				events.push(`active:${id}`);
				if (id == null) meta.delete("active-vault");
				else meta.set("active-vault", id);
			},
			getActiveVault: async () => meta.get("active-vault") ?? null,
			onSyncStatus: () => () => {},
			flushPendingCornerCapture: async () => false,
		},
		clipboard: {},
	} as unknown as Platform;
	return { platform, events, copies };
}

async function openOnNewVault() {
	const p = makePlatform();
	const m = mountVault(p.platform);
	await waitFor(() => expect(m.registry().ready).toBe(true));
	act(() => m.registry().selectVault("vault-new"));
	await waitFor(() => expect(m.registry().activeId).toBe("vault-new"));
	return { ...p, m };
}

const unlocks = {
	"Touch ID": (m: Awaited<ReturnType<typeof openOnNewVault>>["m"]) =>
		m.actions().unlockWithBiometric(false),
	"the master password": (m: Awaited<ReturnType<typeof openOnNewVault>>["m"]) =>
		m.actions().unlock("pw"),
};

describe("the AutoFill extension's copy of the vault", () => {
	it("a Touch ID unlock records the vault it opens before opening its key", async () => {
		const { m, events } = await openOnNewVault();
		await act(() => m.actions().unlockWithBiometric(false));
		// Sync starts the moment the key is open, on whichever vault is recorded then.
		expect(events.slice(0, 2)).toEqual(["active:vault-new", "unwrap:vault-new"]);
	});

	for (const [how, unlock] of Object.entries(unlocks)) {
		it(`is written for the vault opened with ${how}, once`, async () => {
			const { m, copies } = await openOnNewVault();
			await act(() => unlock(m));
			await waitFor(() => expect(m.state().isLocked).toBe(false));
			expect(copies).toEqual(["vault-new"]);
		});
	}

	// The restore screen opens a vault it has just made, before this render has selected it.
	it("is written for the vault an unlock names, before the app has switched to it", async () => {
		const p = makePlatform();
		const m = mountVault(p.platform);
		await waitFor(() => expect(m.registry().activeId).toBe("vault-old"));
		await act(() => m.actions().unlock("pw", "vault-new"));
		expect(p.copies).toEqual(["vault-new"]);
	});

	it("is rewritten for its vault when an entry is added", async () => {
		const { m, copies } = await openOnNewVault();
		await act(() => m.actions().unlock("pw"));
		await act(() => m.actions().addEntry({ type: "note", name: "fresh" }));
		expect(copies).toEqual(["vault-new", "vault-new"]);
	});

	it("is rewritten when the master password changes, so the old one stops opening it", async () => {
		const { m, copies } = await openOnNewVault();
		await act(() => m.actions().unlock("pw"));
		await act(() => m.actions().changeMasterPassword("new password"));
		expect(copies).toEqual(["vault-new", "vault-new"]);
	});

	it("is rewritten when the master password is turned off", async () => {
		const { m, copies } = await openOnNewVault();
		await act(() => m.actions().unlock("pw"));
		await act(() => m.actions().disableMasterPassword());
		expect(copies).toEqual(["vault-new", "vault-new"]);
	});

	it("is rewritten when the open vault is renamed, so it shows the new name", async () => {
		const { m, copies } = await openOnNewVault();
		await act(() => m.actions().unlock("pw"));
		await act(() => m.registry().rename("Work"));
		await waitFor(() => expect(copies).toEqual(["vault-new", "vault-new"]));
	});
});
