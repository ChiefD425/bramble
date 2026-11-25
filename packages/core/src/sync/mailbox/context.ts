// What every part of the mailbox engine works with: the server, the keys, the vault and the blob
// store, as ports so each platform supplies its own.

import type { BlobStore } from "../../vault/blob-store";
import type { MailboxApi, MailboxBlobMover } from "./api";
import type { MailboxCryptoPort } from "./envelope";
import { LIMITS } from "./limits";
import type { MailboxVaultPort } from "./vault-port";

export interface MailboxContext {
	api: MailboxApi;
	crypto: MailboxCryptoPort;
	vault: MailboxVaultPort;
	blobs: { store: BlobStore; mover: MailboxBlobMover };
	groupKeyB64: string;
	sigKey: string;
	now: () => number;
	random: (n: number) => Uint8Array;
	/** Tests shrink these. */
	limits?: Partial<Record<keyof typeof LIMITS, number>>;
}

/** A design-call limit, as the context overrides it. */
export const limit = (ctx: Pick<MailboxContext, "limits">, key: keyof typeof LIMITS): number =>
	ctx.limits?.[key] ?? LIMITS[key];
