// Test-only: hosted accounts and devices for the Worker's suites.

import { env, exports } from "cloudflare:workers";
import { drizzle } from "drizzle-orm/d1";
import * as schema from "../core/schema.ts";
import { activate, createMailbox, deviceWith, type TestDevice } from "../test/device.ts";
import { accountKey, credit, openAccount } from "./accounts.ts";

export const db = () => drizzle(env.DB, { schema });

/** A device talking to the Worker's own fetch handler. */
export const device = () =>
	deviceWith(Date.now, (path, init) =>
		exports.default.fetch(new Request(`https://mailbox.test${path}`, init)),
	);

export const withAccount = (number: string) => ({ headers: { "x-bramble-account": number } });

/** A new account, paid for `days` (none: collect-only). */
export async function account(days = 30): Promise<{ number: string; accountId: string }> {
	const opened = await openAccount(db(), await accountKey(env.ACCOUNT_KEY), Date.now());
	if (days > 0) await credit(db(), opened.accountId, days, `test:${opened.accountId}`, Date.now());
	return opened;
}

/** Two active members of a mailbox on `number`'s account. */
export async function pair(number?: string): Promise<{ a: TestDevice; b: TestDevice; id: string }> {
	const [a, b] = [await device(), await device()];
	const id = await createMailbox(
		a,
		[b],
		undefined,
		withAccount(number ?? (await account()).number),
	);
	await activate(id, b);
	return { a, b, id };
}

/** A database that fails when a statement runs, where Drizzle wraps the error with its SQL and
 * parameters. */
export function failing(): D1Database {
	return new Proxy(env.DB, {
		get(target, prop) {
			if (prop === "batch") return () => Promise.reject(new Error("the database is unreachable"));
			if (prop === "prepare") {
				return () => {
					const fail = () => Promise.reject(new Error("the database is unreachable"));
					const statement = { bind: () => statement, all: fail, raw: fail, run: fail, first: fail };
					return statement;
				};
			}
			const value = Reflect.get(target, prop);
			return typeof value === "function" ? value.bind(target) : value;
		},
	});
}
