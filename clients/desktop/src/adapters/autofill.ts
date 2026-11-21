// Desktop autofill. Filling a browser form goes through the paired extension over the local
// socket; auto-type into native apps is phase 5. Both sit behind this adapter, so nothing in
// @core changes when the second one lands. See docs/desktop-port.md.

import type {
	AutofillAdapter,
	FillPayload,
	IndexEntry,
	QueryResult,
} from "@core/adapters/autofill";
import { PREF_AUTOFILL_QUICKTYPE } from "@core/hooks/usePrefs";
import { buildProviderMirror, passwordSlotPayload } from "@core/vault/provider-mirror";
import {
	displayLabel,
	listedVaults,
	parseRegistry,
	VAULT_REGISTRY_KEY,
} from "@core/vault/vault-registry";
import { decodeVaultBlob } from "@core/vault-format";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { desktopCrypto } from "./crypto";
import { desktopStorage } from "./storage";

const onMac = () =>
	typeof navigator !== "undefined" && /Macintosh|Mac OS X/.test(navigator.userAgent);

/**
 * What the app calls the vault next to its brand, so the sheet names the one it unlocks, and the
 * vaults the picker lists, so copies of any other vault are pruned.
 */
async function pickerView(vaultId: string): Promise<{ name?: string; listed: string[] }> {
	const registry = parseRegistry(await desktopStorage.getMeta(VAULT_REGISTRY_KEY));
	const vaults = listedVaults(registry);
	const listedAt = vaults.findIndex((v) => v.id === vaultId);
	// Named even when the picker is not listing it, so the sheet never shows a blank.
	const index = listedAt >= 0 ? listedAt : registry.vaults.findIndex((v) => v.id === vaultId);
	const record = listedAt >= 0 ? vaults[listedAt] : registry.vaults[index];
	return {
		name: record ? displayLabel(record, index) : undefined,
		listed: vaults.map((v) => v.id),
	};
}

/**
 * The macOS AutoFill extension's copy of the vault, the iOS mirror's shape: logins and passkeys
 * encrypted under the VEK, the password slot so it can unlock on its own, and the identities
 * the OS lists. See docs/macos-credential-provider.md.
 */
async function mirrorForProvider(entries: IndexEntry[], vaultId: string): Promise<void> {
	const quickType = (await desktopStorage.getMeta<boolean>(PREF_AUTOFILL_QUICKTYPE)) === true;
	const m = buildProviderMirror(entries, { quickType, includeUnlockKeys: true });
	const enc = await desktopCrypto.encryptWithVek(JSON.stringify(m.credentials));
	const encPk = await desktopCrypto.encryptWithVek(JSON.stringify(m.passkeys));
	const picker = await pickerView(vaultId);
	const slot = await desktopStorage
		.readVaultBlob(vaultId)
		.then((blob) => passwordSlotPayload(decodeVaultBlob(blob)))
		.catch(() => undefined);
	await invoke<void>("autofill_provider_set", {
		mirror: {
			iv: enc.iv,
			ciphertext: enc.ciphertext,
			vaultId,
			vaultName: picker.name,
			// Off, every vault's login and code suggestions leave macOS, not only this vault's.
			suggestLogins: quickType,
			listedVaultIds: picker.listed,
			slot,
			passkeyIv: encPk.iv,
			passkeyCiphertext: encPk.ciphertext,
			identities: m.identities,
			oneTimeCodeIdentities: m.oneTimeCodeIdentities,
			passkeyIdentities: m.passkeyIdentities,
		},
	});
}

/** The adapter, for `vaultId` when there is one: only then does the AutoFill extension get a copy. */
function desktopAutofillFor(vaultId?: string): AutofillAdapter {
	return {
		// @core already pushes on unlock and clears on lock, which is exactly when the browser
		// link's answers should start and stop being available, so no new plumbing was needed to
		// keep the two in step. The index goes to the Rust side rather than staying in this
		// window: the socket is served there, and a window the user closed must not take the
		// browser link down with it.
		setIndex: async (entries) => {
			// The browser link never sees the unlock key; the AutoFill extension below does.
			await invoke<void>("link_set_index", {
				entries: entries.filter((e) => e.type !== "unlock-key"),
			});
			// A failed mirror must not take the browser link with it; the next change retries.
			if (vaultId && onMac())
				await mirrorForProvider(entries, vaultId).catch((e) =>
					console.warn("[autofill] mirror:", e),
				);
		},
		withVault: (id) => desktopAutofillFor(id),
		// Below sign-in fields in Safari, from the logins macOS holds for the AutoFill extension.
		inlineSuggestionsAvailable: async () => onMac(),
		onProviderEnabled: (callback) => {
			let stop: (() => void) | null = null;
			let gone = false;
			void listen("autofill-provider-enabled", () => callback()).then((un) => {
				if (gone) un();
				else stop = un;
			});
			return () => {
				gone = true;
				stop?.();
			};
		},
		// The mirror stays on lock, as on iOS: it is VEK-encrypted, and the extension unlocks on its own.
		clearIndex: () => invoke<void>("link_clear_index"),
		clearProviderData: async () => {
			if (vaultId) await invoke<void>("autofill_provider_clear", { vaultId });
		},

		query: async (): Promise<QueryResult> => ({
			logins: [],
			cards: [],
			otps: [],
			locked: false,
			hasPotentialMatch: false,
		}),

		fetchFill: (): Promise<FillPayload> => {
			throw new Error("Autofill is not wired on desktop yet");
		},
	};
}

export const desktopAutofill: AutofillAdapter = desktopAutofillFor();
