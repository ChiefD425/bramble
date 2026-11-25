// The shared app's dependencies on the hosted mailbox: D1 through Drizzle, R2 for bodies, and the
// environment's limits.

import { drizzle } from "drizzle-orm/d1";
import type { AppDeps } from "../core/app.ts";
import { HttpError } from "../core/auth.ts";
import * as schema from "../core/schema.ts";
import { accountKey, accountStatus, addressHash, resolveAccount } from "./accounts.ts";
import { accountEntitlement } from "./entitlement.ts";
import { r2Bodies } from "./r2-bodies.ts";

export function workerDeps(env: Env, now: () => number = Date.now): AppDeps {
	const db = drizzle(env.DB, { schema });
	// Imported only by a request that needs it, so one that never touches an account never fails
	// on a missing secret.
	const key = () => accountKey(env.ACCOUNT_KEY);
	const quotaBytes = Number(env.ACCOUNT_QUOTA_BYTES);
	return {
		db,
		bodies: r2Bodies(env.BODIES),
		entitlement: accountEntitlement(
			db,
			key,
			{
				quotaBytes,
				maxMailboxes: Number(env.ACCOUNT_MAX_MAILBOXES),
				limit: async (accountId) => (await env.ACCOUNT_LIMIT.limit({ key: accountId })).success,
			},
			now,
		),
		accounts: {
			async status(number) {
				const accountId = await resolveAccount(db, await key(), number);
				if (!accountId) return null;
				// Keyed by the id: the number is a secret and goes nowhere it isn't needed.
				if (!(await env.ACCOUNT_LIMIT.limit({ key: accountId })).success) {
					throw new HttpError(429, "rate_limited");
				}
				return accountStatus(db, accountId, quotaBytes);
			},
		},
		limit: async (key) => (await env.MAILBOX_LIMIT.limit({ key })).success,
		limitAddress: async (address) =>
			(await env.ACCOUNT_LIMIT.limit({ key: `address:${await addressHash(await key(), address)}` }))
				.success,
		now,
		config: { retentionMaxDays: Number(env.RETENTION_MAX_DAYS), token: null },
	};
}
