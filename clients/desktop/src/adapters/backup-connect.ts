// One-click backup sign-in on the desktop. The shell runs the whole flow in Rust (the system
// browser, a loopback redirect, the token exchange) and keeps the refresh token in the OS
// credential store, so this only records the target. With no credential store the token comes
// back once and is sealed under the vault key, as S3 and WebDAV credentials are there.
// See docs/cloud-storage-backups.md "Google Drive".

import {
	type BackupTargetConfig,
	backupTargetsKeyFor,
	type TargetCreds,
} from "@core/backup/config";
import { invoke } from "@tauri-apps/api/core";
import { desktopCrypto } from "./crypto";
import { desktopStorage } from "./storage";

type Connected = { stored: boolean; refreshToken?: string };

export async function connectBackupOAuth(
	providerId: string,
	opts?: { targetId?: string; vaultId?: string },
): Promise<void> {
	const vaultId = opts?.vaultId;
	if (!vaultId) throw new Error("Unlock Bramble first, then connect.");
	const key = backupTargetsKeyFor(vaultId);
	const list = (await desktopStorage.getMeta<BackupTargetConfig[]>(key)) ?? [];
	const existing = list.find((t) => t.id === opts?.targetId);
	const targetId = existing?.id ?? globalThis.crypto.randomUUID();

	const connected = await invoke<Connected>("backup_oauth_connect", {
		vaultId,
		targetId,
		provider: providerId,
	});
	let creds: TargetCreds = { wrap: "os" };
	if (!connected.stored) {
		const sealed = await desktopCrypto.encryptWithVek(
			JSON.stringify({ refreshToken: connected.refreshToken }),
		);
		creds = { iv: sealed.iv, ciphertext: sealed.ciphertext };
	}

	if (existing) {
		await desktopStorage.setMeta(
			key,
			list.map((t) => (t.id === targetId ? { ...t, creds, lastError: undefined } : t)),
		);
		return;
	}
	const target: BackupTargetConfig = {
		id: targetId,
		providerId,
		provider: providerId as BackupTargetConfig["provider"],
		frequency: "daily",
		keep: 30,
		creds,
	};
	await desktopStorage.setMeta(key, [...list, target]);
}
