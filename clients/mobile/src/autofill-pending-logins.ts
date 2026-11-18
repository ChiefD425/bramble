import { registerPlugin } from "@capacitor/core";
import type { PendingNewLogin } from "@core/index";
import { mobileCrypto } from "./adapters/crypto";
import type { EncryptedRecord } from "./encrypted-handoff";

interface PendingLoginsPlugin {
	peekPendingLogins(): Promise<{ pending: EncryptedRecord[] }>;
	removePendingLogins(o: { ivs: string[] }): Promise<void>;
}
const Bridge = registerPlugin<PendingLoginsPlugin>("AutofillBridge");

function str(v: unknown): string {
	return typeof v === "string" ? v : "";
}

/**
 * The logins the autofill picker created, decrypted with the active vault's VEK. Unlike the other
 * handoffs nothing is cleared here: the picker already filled each password into a sign-up form,
 * so a record stays queued until it is in the vault. One another vault sealed is left for it; one
 * that decrypts to nothing usable is removed, since no vault could ever save it.
 */
export async function peekPendingLogins(): Promise<PendingNewLogin[]> {
	const pending = (await Bridge.peekPendingLogins().catch(() => null))?.pending ?? [];
	const out: PendingNewLogin[] = [];
	const unusable: string[] = [];
	for (const record of pending) {
		let plaintext: string;
		try {
			plaintext = await mobileCrypto.decryptWithVek(record.iv, record.ciphertext);
		} catch {
			continue;
		}
		try {
			const d = JSON.parse(plaintext) as Record<string, unknown> | null;
			const password = str(d?.password);
			if (!password) throw new Error("no password");
			out.push({
				key: record.iv,
				name: str(d?.name),
				url: str(d?.url),
				username: str(d?.username),
				password,
			});
		} catch {
			unusable.push(record.iv);
		}
	}
	if (unusable.length) await removePendingLogins(unusable);
	return out;
}

export async function removePendingLogins(keys: string[]): Promise<void> {
	if (keys.length === 0) return;
	await Bridge.removePendingLogins({ ivs: keys });
}
