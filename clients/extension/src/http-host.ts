// Outbound HTTP run in the crypto host, for the background's long requests: a backup upload.
// The Chrome service worker cannot make them itself, because Chrome ends a worker whose fetch()
// response takes over 30 seconds or whose one call takes over 5 minutes, and an upload of a
// large backup does both. The offscreen document has no such limit. See docs/cloud-storage-backups.md.
//
// So a request is a job: started with one quick message, then polled with more. No message waits
// on the upload, and each poll is an extension API call, which keeps the worker alive meanwhile.
// Bodies travel as a Blob in the IndexedDB handoff store (files/idb.ts), never as a message.

import { base64ToBytes, bytesToBase64 } from "@core/util/bytes";
import { idbBlobStore, readHandoff } from "./files/idb";

export interface HttpJobRequest {
	method: string;
	url: string;
	headers?: Record<string, string>;
	/** Small bodies inline as base64; anything larger as a handoff key. */
	body?: { inline: string } | { handoff: string };
	/** Write a successful response into this vault's blob store instead of returning it: a mailbox
	 * attachment can be larger than any message may carry back. */
	sink?: { vaultId: string; hash: string };
}

export type HttpJobState =
	| { done: false }
	| { done: true; status: number; body: string; headers: Record<string, string> }
	| { done: true; error: string };

const jobs = new Map<string, HttpJobState>();

/** How long a finished job's result is kept for a poll that has not come yet. */
const RESULT_TTL_MS = 5 * 60_000;

export async function startHttpJob(req: HttpJobRequest): Promise<string> {
	let body: BodyInit | undefined;
	if (req.body && "inline" in req.body) body = base64ToBytes(req.body.inline) as BodyInit;
	if (req.body && "handoff" in req.body) {
		const blob = await readHandoff(req.body.handoff);
		if (!blob) throw new Error("the request body is no longer staged");
		body = blob;
	}
	const id = globalThis.crypto.randomUUID();
	jobs.set(id, { done: false });
	const finish = (state: HttpJobState) => {
		jobs.set(id, state);
		setTimeout(() => jobs.delete(id), RESULT_TTL_MS);
	};
	// The same rules as every transport: no ambient cookies, no redirects followed.
	fetch(req.url, {
		method: req.method,
		headers: req.headers,
		body,
		credentials: "omit",
		redirect: "manual",
	})
		.then(async (res) => {
			const bytes = new Uint8Array(await res.arrayBuffer());
			// Lower-cased by Headers. A provider's upload session URL comes back in Location.
			const headers = Object.fromEntries(res.headers);
			if (req.sink && res.ok) {
				// Verified against its hash on the way in; the bytes never cross back as a message.
				await idbBlobStore(req.sink.vaultId).put(req.sink.hash, bytes);
				finish({ done: true, status: res.status, body: "", headers });
				return;
			}
			finish({ done: true, status: res.status, body: bytesToBase64(bytes), headers });
		})
		.catch((e: unknown) =>
			finish({ done: true, error: e instanceof Error ? e.message : String(e) }),
		);
	return id;
}

/** A job's state. An unknown id means the host was restarted and the job went with it. */
export function pollHttpJob(id: string): HttpJobState {
	const state = jobs.get(id);
	if (!state) return { done: true, error: "the request was lost when the crypto host restarted" };
	if (state.done) jobs.delete(id);
	return state;
}
