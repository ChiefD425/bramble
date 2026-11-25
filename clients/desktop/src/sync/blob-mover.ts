// Attachments through the mailbox on desktop, kept out of the webview as everything else about
// files is (see adapters/files.ts). A download is one shell command that streams the body into
// the vault's blob folder and keeps it only if it hashes to its address; an upload streams the
// stored blob through the shell in raw chunks.

import type { BlobStore } from "@core/index";
import { MailboxApiError, type MailboxBlobMover, storeBlobMover } from "@core/sync/mailbox";
import { invoke } from "@tauri-apps/api/core";
import { desktopHttp } from "../adapters/http";

export function desktopBlobMover(vaultId: string, store: BlobStore): MailboxBlobMover {
	const { upload } = storeBlobMover(desktopHttp, store);
	return {
		upload,
		async download(hash, request) {
			const status = await invoke<number>("files_download_blob", { vaultId, hash, ...request });
			if (status >= 200 && status < 300) return "stored";
			if (status === 404) return "missing";
			throw new MailboxApiError(status, "unexpected");
		},
	};
}
