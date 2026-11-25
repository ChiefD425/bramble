// A self-hosted server's entitlement: every mailbox may post, its own bytes count against
// QUOTA_BYTES, and there are no accounts. The hosted one is in src/worker/entitlement.ts.

import type { Db, Entitlement } from "./app.ts";
import { usedBytes } from "./messages.ts";

export function selfHostedEntitlement(db: Db, quotaBytes: number | null): Entitlement {
	return {
		canPost: async () => true,
		usage: async (mailboxId) => ({ usedBytes: await usedBytes(db, mailboxId), quotaBytes }),
		admit: async () => null,
	};
}
