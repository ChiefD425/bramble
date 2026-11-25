// File blobs through the mailbox (docs/mailbox-service.md, "Files"): collect what is delivered,
// list what this device's manifest names but its store lacks, and upload what others want that
// this device holds. Blobs are sealed under their own file keys, so nothing here touches a key.

import type { EntriesPayload } from "../entries-payload";
import { wantedFromPayload } from "../transport/blob-sync";
import { limit, type MailboxContext } from "./context";
import { type InboxResponse, MAX_WANTS } from "./protocol";
import type { MailboxState } from "./state";

const download = async (ctx: MailboxContext, hash: string) =>
	ctx.blobs.mover.download(hash, await ctx.api.blobRequest("GET", hash));

/**
 * Collect delivered blobs; the hashes to acknowledge. A held hash is acknowledged without a
 * download, a missing one is acknowledged (the manifest will want it again), and a failed
 * download is left for the next sync.
 */
export async function collectBlobs(
	ctx: MailboxContext,
	blobs: InboxResponse["blobs"],
): Promise<string[]> {
	const acked: string[] = [];
	for (const { hash } of blobs) {
		try {
			if (!(await ctx.blobs.store.has(hash))) await download(ctx, hash);
			acked.push(hash);
		} catch (err) {
			console.warn("[mailbox] blob download failed; it stays for the next sync:", err);
		}
	}
	return acked;
}

/**
 * Send the wants list when it changed. A new want is first fetched directly: a blob the mailbox
 * already held when this device became active has no delivery for it.
 */
export async function syncWants(
	ctx: MailboxContext,
	state: MailboxState,
	local: EntriesPayload,
	/** Wraps the wants update, a post a collect-only mailbox may refuse; fetching always runs. */
	post: (send: () => Promise<void>) => Promise<void> = (send) => send(),
): Promise<void> {
	const held = new Set(await ctx.blobs.store.list());
	const missing = [...new Set(wantedFromPayload(local).map((w) => w.hash))]
		.filter((hash) => !held.has(hash))
		.sort();
	// Tried once each, a few per sync: past the cap, the rest wait for the next sync, not forever.
	const tried = new Set(state.tried.filter((hash) => missing.includes(hash)));
	const got = new Set<string>();
	for (const hash of missing.filter((h) => !tried.has(h)).slice(0, limit(ctx, "directGets"))) {
		tried.add(hash);
		try {
			if ((await download(ctx, hash)) === "stored") got.add(hash);
		} catch (err) {
			console.warn("[mailbox] direct blob fetch failed; it stays wanted:", err);
		}
	}
	state.tried = [...tried];
	const wants = missing.filter((hash) => !got.has(hash)).slice(0, MAX_WANTS);
	if (wants.join() === state.wants.join()) return;
	await post(async () => {
		await ctx.api.wants(wants);
		state.wants = wants;
	});
}

/** Upload what other members want that this device holds; stop at the first failure. */
export async function uploadWanted(ctx: MailboxContext, wanted: string[]): Promise<void> {
	for (const hash of wanted) {
		if (!(await ctx.blobs.store.has(hash))) continue;
		try {
			await ctx.blobs.mover.upload(hash, await ctx.api.blobRequest("PUT", hash));
		} catch (err) {
			console.warn("[mailbox] uploading a wanted blob failed; next sync tries again:", err);
			return;
		}
	}
}
