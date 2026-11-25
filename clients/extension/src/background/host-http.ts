/// <reference types="chrome" />

// The background's HttpTransport for backups: each request runs in the crypto host as a job (see
// http-host.ts), because a Chrome service worker cannot hold one open for a large upload.

import { bodyToBlob, type HttpTransport } from "@core/adapters/http";
import { type MailboxBlobMover, storeBlobMover } from "@core/sync/mailbox";
import { base64ToBytes, bytesToBase64 } from "@core/util/bytes";
import type { BlobStore } from "@core/vault/blob-store";
import { dropHandoff, putHandoff } from "../files/idb";
import type { HttpJobRequest, HttpJobState } from "../http-host";
import { sendToOffscreen } from "./offscreen-client";

/** Bodies up to this size go inline in the message; larger ones by handoff. */
const INLINE_MAX = 256 * 1024;
const POLL_MS = 1000;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Start a job in the host and poll it to the end: no message waits on the transfer itself. */
async function runJob(
	payload: HttpJobRequest,
): Promise<{ status: number; body: Uint8Array; headers: Record<string, string> }> {
	const started = await sendToOffscreen({ type: "HTTP_JOB_START", payload });
	if (!started.ok || typeof started.data !== "string") {
		throw new Error(started.error ?? "the request could not be started");
	}
	for (;;) {
		await sleep(POLL_MS);
		const polled = await sendToOffscreen({
			type: "HTTP_JOB_POLL",
			payload: { id: started.data },
		});
		if (!polled.ok) throw new Error(polled.error ?? "the request was lost");
		const state = polled.data as HttpJobState;
		if (!state.done) continue;
		if ("error" in state) throw new Error(state.error);
		return { status: state.status, body: base64ToBytes(state.body), headers: state.headers };
	}
}

export const hostHttp: HttpTransport = {
	async send({ method, url, headers, body }) {
		let handoff: string | null = null;
		let jobBody: HttpJobRequest["body"];
		if (body instanceof Uint8Array && body.length <= INLINE_MAX) {
			jobBody = { inline: bytesToBase64(body) };
		} else if (body) {
			handoff = await putHandoff(
				body instanceof Uint8Array ? new Blob([body as BlobPart]) : await bodyToBlob(body),
			);
			jobBody = { handoff };
		}
		try {
			const res = await runJob({ method, url, headers, body: jobBody });
			return {
				status: res.status,
				ok: res.status >= 200 && res.status < 300,
				body: res.body,
				headers: res.headers,
			};
		} finally {
			if (handoff) await dropHandoff(handoff).catch(() => {});
		}
	},
};

/**
 * The mailbox's blob mover on the extension. Uploads go as hostHttp sends any large body; a
 * download is written into the vault's blob store by the host, since an attachment can be larger
 * than a message may carry back (Chrome caps one at 64 MiB).
 */
export function hostBlobMover(vaultId: string, store: BlobStore): MailboxBlobMover {
	return {
		upload: storeBlobMover(hostHttp, store).upload,
		async download(hash, request) {
			const res = await runJob({ ...request, sink: { vaultId, hash } });
			if (res.status === 404) return "missing";
			if (res.status < 200 || res.status >= 300) {
				throw new Error(`the mailbox answered ${res.status} for a blob`);
			}
			return "stored";
		},
	};
}
