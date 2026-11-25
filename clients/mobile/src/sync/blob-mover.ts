// Attachments through the mailbox on a device, moved natively both ways: the Android bridge
// carries about 0.5 MB/s, so a blob's bytes never cross it. An upload is sent from the blob's own
// file; a download lands in a staging file and is adopted only if it hashes to its address.

import type { BlobStore } from "@core/index";
import { MailboxApiError, type MailboxBlobMover, storeBlobMover } from "@core/sync/mailbox";
import { BLOB_HASH_RE } from "@core/sync/mailbox/protocol";
import { blobFilePath } from "../adapters/blob-store";
import { mobileHttp, nativeDownload } from "../adapters/http";

export function nativeBlobMover(vaultId: string, store: BlobStore): MailboxBlobMover {
	const { upload } = storeBlobMover(mobileHttp, store, (hash) => blobFilePath(vaultId, hash));
	return {
		upload,
		async download(hash, request) {
			if (!BLOB_HASH_RE.test(hash)) throw new Error("not a blob hash");
			// One staging file per blob: a retry overwrites what an interrupted download left.
			const token = `mailbox-${hash}`;
			const path = await store.reserveStagingPath(token);
			if (!path) throw new Error("this blob store has no staging paths");
			const discard = () => store.discardStagingPath(token).catch(() => {});
			let res: { status: number; sha256: string };
			try {
				res = await nativeDownload(request, path);
			} catch (e) {
				await discard();
				throw e;
			}
			const ok = res.status >= 200 && res.status < 300;
			if (ok && res.sha256 === hash) {
				try {
					await store.adoptStagingPath(token, hash);
				} catch (e) {
					await discard();
					throw e;
				}
				return "stored";
			}
			await discard();
			if (res.status === 404) return "missing";
			if (ok) throw new Error("the downloaded blob does not match its hash");
			throw new MailboxApiError(res.status, "unexpected");
		},
	};
}
