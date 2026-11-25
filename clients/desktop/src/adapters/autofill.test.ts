import { PREF_AUTOFILL_QUICKTYPE } from "@core/hooks/usePrefs";
import type { IndexEntry } from "@core/index";
import { VAULT_REGISTRY_KEY } from "@core/vault/vault-registry";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { invoke, meta, encrypt, readVaultBlob, events } = vi.hoisted(() => ({
	events: new Map<string, () => void>(),
	invoke: vi.fn(async (_cmd: string, _args?: unknown) => {}),
	meta: new Map<string, unknown>(),
	encrypt: vi.fn(async (plaintext: string) => ({ iv: "IV", ciphertext: plaintext })),
	// No blob in the test store: the slot read swallows the throw and leaves the slot out.
	readVaultBlob: vi.fn(async (_vaultId?: string): Promise<Uint8Array> => {
		throw new Error("no vault stored");
	}),
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("@tauri-apps/api/event", () => ({
	listen: async (event: string, handler: () => void) => {
		events.set(event, handler);
		return () => events.delete(event);
	},
}));
vi.mock("./crypto", () => ({ desktopCrypto: { encryptWithVek: encrypt } }));
vi.mock("./storage", () => ({
	desktopStorage: { getMeta: async (k: string) => meta.get(k), readVaultBlob },
}));

const { desktopAutofill } = await import("./autofill");
const personal = () => desktopAutofill.withVault?.("v1") ?? desktopAutofill;

const login = {
	type: "login",
	id: "e1",
	name: "GitHub",
	username: "me@example.com",
	password: "pw",
	hostnames: ["github.com"],
} as IndexEntry;

const onMac = (yes: boolean) =>
	vi.stubGlobal("navigator", {
		userAgent: yes
			? "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)"
			: "Mozilla/5.0 (X11; Linux x86_64)",
	});

const mirrorCall = () =>
	invoke.mock.calls.find(([cmd]) => cmd === "autofill_provider_set")?.[1] as
		| {
				mirror: {
					suggestLogins?: boolean;
					ciphertext: string;
					vaultId: string;
					vaultName?: string;
					listedVaultIds?: string[];
					identities: unknown[];
				};
		  }
		| undefined;

beforeEach(() => {
	invoke.mockClear();
	encrypt.mockClear();
	readVaultBlob.mockClear();
	meta.clear();
	meta.set(VAULT_REGISTRY_KEY, {
		vaults: [
			{ id: "v0", label: "Work", number: 1, createdAt: 1 },
			{ id: "v1", label: "Personal", number: 2, createdAt: 2 },
		],
	});
});

describe("desktopAutofill", () => {
	it("mirrors the index for the macOS AutoFill extension", async () => {
		onMac(true);
		meta.set(PREF_AUTOFILL_QUICKTYPE, true);
		await personal().setIndex([login]);
		expect(invoke).toHaveBeenCalledWith("link_set_index", { entries: [login] });
		const m = mirrorCall()?.mirror;
		expect(m?.vaultId).toBe("v1");
		expect(JSON.parse(m?.ciphertext ?? "[]")[0]).toMatchObject({ recordId: "e1", password: "pw" });
		expect(m?.identities).toEqual([
			{ recordId: "e1", username: "me@example.com", service: "github.com" },
		]);
	});

	it("keeps the browser link when the mirror fails", async () => {
		onMac(true);
		encrypt.mockRejectedValueOnce(new Error("locked"));
		await expect(personal().setIndex([login])).resolves.toBeUndefined();
		expect(invoke).toHaveBeenCalledWith("link_set_index", { entries: [login] });
	});

	it("does nothing for the provider off macOS", async () => {
		onMac(false);
		await personal().setIndex([login]);
		expect(mirrorCall()).toBeUndefined();
		expect(encrypt).not.toHaveBeenCalled();
	});

	it("clears the copy of the vault it is for", async () => {
		await personal().clearProviderData?.();
		expect(invoke).toHaveBeenCalledWith("autofill_provider_clear", { vaultId: "v1" });
		invoke.mockClear();
		await desktopAutofill.clearProviderData?.();
		expect(invoke).not.toHaveBeenCalled();
	});

	// A copy of any vault the picker no longer lists is pruned when the next copy is written.
	it("setSshKeys sends the vault's keys, name and listed vaults", async () => {
		const keys = [{ id: "k", name: "Deploy", privateKey: "PK", hosts: ["github.com"] }];
		await personal().setSshKeys?.(keys);
		expect(invoke).toHaveBeenCalledWith("ssh_agent_set_keys", {
			vaultId: "v1",
			vaultName: "Personal",
			listedVaultIds: ["v0", "v1"],
			keys,
		});
	});

	it("the unscoped adapter has no setSshKeys", () => {
		expect(desktopAutofill.setSshKeys).toBeUndefined();
	});

	it("clearing a vault's provider data forgets its SSH keys", async () => {
		await personal().clearProviderData?.();
		expect(invoke).toHaveBeenCalledWith("ssh_agent_forget_vault", { vaultId: "v1" });
	});

	it("tells the copy which vaults the picker lists", async () => {
		onMac(true);
		meta.set(VAULT_REGISTRY_KEY, {
			vaults: [
				{ id: "v0", label: "Work", number: 1, createdAt: 1 },
				{ id: "v1", label: "Personal", number: 2, createdAt: 2 },
				{
					id: "v2",
					label: "Old",
					number: 3,
					createdAt: 3,
					hidden: { at: 4, blobHash: "h", into: "v1" },
				},
			],
		});
		await personal().setIndex([login]);
		expect(mirrorCall()?.mirror.listedVaultIds).toEqual(["v0", "v1"]);
	});

	it("gives the AutoFill extension the unlock key but never the browser link", async () => {
		onMac(true);
		const unlock = {
			type: "unlock-key",
			id: "u",
			passkey: {
				credentialId: "Y2lk",
				rpId: "bramble.sh",
				userHandle: "dWg=",
				alg: -7,
				privateKey: "sk",
			},
		} as unknown as IndexEntry;
		await personal().setIndex([login, unlock]);
		expect(invoke).toHaveBeenCalledWith("link_set_index", { entries: [login] });
		const m = mirrorCall()?.mirror as unknown as { passkeyIdentities: { rpId: string }[] };
		expect(m.passkeyIdentities.map((p) => p.rpId)).toEqual(["bramble.sh"]);
	});

	// The active-vault setting still names the last vault partway through an unlock: a copy built
	// from it pairs this vault's logins with another vault's password and Touch ID.
	it("writes the copy for its own vault, whatever the active-vault setting says", async () => {
		onMac(true);
		meta.set("active-vault", "v0");
		await personal().setIndex([login]);
		expect(mirrorCall()?.mirror.vaultId).toBe("v1");
		expect(readVaultBlob.mock.calls.map(([id]) => id)).toEqual(["v1"]);
	});

	it("names the vault as the app does, so the sheet says which one it unlocks", async () => {
		onMac(true);
		await personal().setIndex([login]);
		expect(mirrorCall()?.mirror.vaultName).toBe("Personal");
		meta.set(VAULT_REGISTRY_KEY, { vaults: [{ id: "v1", label: " ", number: 2, createdAt: 2 }] });
		invoke.mockClear();
		await personal().setIndex([login]);
		expect(mirrorCall()?.mirror.vaultName).toBe("Vault 2");
	});

	it("names a vault the picker is not listing, so the sheet never shows a blank", async () => {
		onMac(true);
		meta.set(VAULT_REGISTRY_KEY, {
			vaults: [
				{ id: "v0", label: "Work", number: 1, createdAt: 1 },
				{
					id: "v1",
					label: "Personal",
					number: 2,
					createdAt: 2,
					hidden: { at: 3, blobHash: "h", into: "v0" },
				},
			],
		});
		await personal().setIndex([login]);
		expect(mirrorCall()?.mirror.vaultName).toBe("Personal");
	});

	it("writes no copy without a vault to write it for, but keeps the browser link", async () => {
		onMac(true);
		meta.set("active-vault", "v1");
		await desktopAutofill.setIndex([login]);
		expect(invoke).toHaveBeenCalledWith("link_set_index", { entries: [login] });
		expect(mirrorCall()).toBeUndefined();
	});

	it("offers AutoFill suggestions only on a Mac", async () => {
		onMac(true);
		expect(await desktopAutofill.inlineSuggestionsAvailable?.()).toBe(true);
		onMac(false);
		expect(await desktopAutofill.inlineSuggestionsAvailable?.()).toBe(false);
	});

	// Off, every vault's login and code suggestions leave macOS, not only the open vault's.
	it("tells the copy whether login suggestions are on", async () => {
		onMac(true);
		await personal().setIndex([login]);
		expect(mirrorCall()?.mirror.suggestLogins).toBe(false);
		meta.set(PREF_AUTOFILL_QUICKTYPE, true);
		invoke.mockClear();
		await personal().setIndex([login]);
		expect(mirrorCall()?.mirror.suggestLogins).toBe(true);
	});

	it("hears Bramble being switched on in AutoFill, until unsubscribed", async () => {
		const heard = vi.fn();
		const stop = desktopAutofill.onProviderEnabled?.(heard);
		await vi.waitFor(() => expect(events.has("autofill-provider-enabled")).toBe(true));
		events.get("autofill-provider-enabled")?.();
		expect(heard).toHaveBeenCalledTimes(1);
		stop?.();
		await vi.waitFor(() => expect(events.has("autofill-provider-enabled")).toBe(false));
	});
});
