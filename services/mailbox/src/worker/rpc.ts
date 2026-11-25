// The one narrow call billing has into accounts (docs/mailbox-service.md, "The server"), over a
// service binding: open an account, find one by its number, add or remove paid time, freeze or
// unfreeze, delete it. Billing keeps the account id, never the number, and this Worker never sees payment data.

import { WorkerEntrypoint } from "cloudflare:workers";
import { drizzle } from "drizzle-orm/d1";
import { rootMessage } from "../core/errors.ts";
import * as schema from "../core/schema.ts";
import {
	accountKey,
	credit,
	deleteAccount,
	freeze,
	openAccount,
	resolveAccount,
} from "./accounts.ts";
import { r2Bodies } from "./r2-bodies.ts";

/** An error crossing to billing as its innermost message alone: Drizzle's quotes the query's values,
 * which hold account ids and key hashes, and billing logs what it gets. */
async function flat<T>(run: () => Promise<T>): Promise<T> {
	try {
		return await run();
	} catch (err) {
		throw new Error(rootMessage(err));
	}
}

/** The contract with billing, a separate Worker kept in a private repo that copies this shape:
 * change it only together with billing. */
export interface AccountsRpc {
	open(): Promise<{ number: string; accountId: string }>;
	resolve(number: string): Promise<string | null>;
	/** Once per `op`, however often it's asked: billing names the payment, refund or dispute. */
	credit(
		accountId: string,
		days: number,
		op: string,
	): Promise<{ paidThrough: number; applied: boolean }>;
	freeze(accountId: string, frozen: boolean): Promise<void>;
	/** The account and everything stored under it, for good. Asking again is not an error. */
	remove(accountId: string): Promise<void>;
}

export class Accounts extends WorkerEntrypoint<Env> implements AccountsRpc {
	private get db() {
		return drizzle(this.env.DB, { schema });
	}

	open(): Promise<{ number: string; accountId: string }> {
		return flat(async () =>
			openAccount(this.db, await accountKey(this.env.ACCOUNT_KEY), Date.now()),
		);
	}

	resolve(number: string): Promise<string | null> {
		return flat(async () =>
			resolveAccount(this.db, await accountKey(this.env.ACCOUNT_KEY), number),
		);
	}

	credit(
		accountId: string,
		days: number,
		op: string,
	): Promise<{ paidThrough: number; applied: boolean }> {
		return flat(() => credit(this.db, accountId, days, op, Date.now()));
	}

	freeze(accountId: string, frozen: boolean): Promise<void> {
		return flat(() => freeze(this.db, accountId, frozen));
	}

	remove(accountId: string): Promise<void> {
		return flat(() => deleteAccount(this.db, r2Bodies(this.env.BODIES), accountId));
	}
}
