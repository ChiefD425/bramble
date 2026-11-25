// The hosted mailbox's entitlement: a mailbox belongs to an account from its creation, posts only
// while that account is paid and not frozen, and counts against the account's quota across all
// of its mailboxes. Collecting is never gated.

import { and, count, eq, ne } from "drizzle-orm";
import type { Db, Entitlement } from "../core/app.ts";
import { HttpError } from "../core/auth.ts";
import { mailboxes } from "../core/schema.ts";
import { accountActive, accountUsedBytes, resolveAccount } from "./accounts.ts";

export interface AccountLimits {
	quotaBytes: number;
	/** How many mailboxes one account may hold: bounds what a single account can make the
	 * service store, since a collect-only mailbox still writes metadata. */
	maxMailboxes: number;
	/** false: the account is asking too often. Keyed by the account id, never the number. */
	limit?(accountId: string): Promise<boolean>;
}

export function accountEntitlement(
	db: Db,
	key: () => Promise<CryptoKey>,
	limits: AccountLimits,
	now: () => number,
): Entitlement {
	const { quotaBytes, maxMailboxes } = limits;
	const accountOf = async (mailboxId: string) =>
		(
			await db
				.select({ accountId: mailboxes.accountId })
				.from(mailboxes)
				.where(eq(mailboxes.id, mailboxId))
				.get()
		)?.accountId ?? null;
	return {
		async canPost(mailboxId) {
			const accountId = await accountOf(mailboxId);
			return accountId !== null && (await accountActive(db, accountId, now()));
		},
		async usage(mailboxId) {
			const accountId = await accountOf(mailboxId);
			return { usedBytes: accountId ? await accountUsedBytes(db, accountId) : 0, quotaBytes };
		},
		async admit(account, mailboxId) {
			if (!account) throw new HttpError(402, "account_required");
			const accountId = await resolveAccount(db, await key(), account);
			if (!accountId) throw new HttpError(403, "account_unknown");
			if (limits.limit && !(await limits.limit(accountId)))
				throw new HttpError(429, "rate_limited");
			const [held] = await db
				.select({ n: count() })
				.from(mailboxes)
				.where(
					mailboxId
						? and(eq(mailboxes.accountId, accountId), ne(mailboxes.id, mailboxId))
						: eq(mailboxes.accountId, accountId),
				);
			if ((held?.n ?? 0) >= maxMailboxes) throw new HttpError(507, "quota_exceeded");
			return accountId;
		},
		async overMailboxCap(accountId) {
			const [held] = await db
				.select({ n: count() })
				.from(mailboxes)
				.where(eq(mailboxes.accountId, accountId));
			return (held?.n ?? 0) > maxMailboxes;
		},
	};
}
