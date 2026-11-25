// Hosted accounts (docs/mailbox-service.md, "The account number", "Entitlement"). A number is a
// bearer secret: 25 random digits, shown in groups of 5, stored only as a keyed hash. Billing never
// keeps the number either; it holds the account id these functions hand back.

import {
	ACCOUNT_DIGITS,
	type AccountStatusResponse,
	formatAccountNumber,
	parseAccountNumber,
} from "@vault/core/src/sync/mailbox/protocol.ts";
import { and, eq, inArray, sql } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import type { Db } from "../core/app.ts";
import type { BodyStore } from "../core/bodies.ts";
import { deleteMailbox } from "../core/cleanup.ts";
import { heldBytes } from "../core/messages.ts";
import type * as schema from "../core/schema.ts";
import { accountCredits, accounts, mailboxes } from "../core/schema.ts";
import { DAY_MS } from "../core/time.ts";

const hex = (bytes: ArrayBuffer) =>
	Array.from(new Uint8Array(bytes), (b) => b.toString(16).padStart(2, "0")).join("");
const base64url = (bytes: Uint8Array) =>
	btoa(String.fromCharCode(...bytes))
		.replaceAll("+", "-")
		.replaceAll("/", "_")
		.replace(/=+$/, "");

/** The HMAC key a number's stored hash is made with, from the ACCOUNT_KEY secret. */
export function accountKey(secret: string): Promise<CryptoKey> {
	return crypto.subtle.importKey(
		"raw",
		new TextEncoder().encode(secret),
		{ name: "HMAC", hash: "SHA-256" },
		false,
		["sign"],
	);
}

/** Uniform random digits: bytes of 250 and above are drawn again, so no digit is likelier. */
function randomDigits(n: number): string {
	let out = "";
	while (out.length < n) {
		for (const byte of crypto.getRandomValues(new Uint8Array(n))) {
			if (byte < 250 && out.length < n) out += String(byte % 10);
		}
	}
	return out;
}

async function keyHash(key: CryptoKey, digits: string): Promise<string> {
	return hex(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(digits)));
}

/** An address as the rate limiter keys it: keyed-hashed, so no address leaves the Worker. */
export async function addressHash(key: CryptoKey, address: string): Promise<string> {
	return keyHash(key, `address:${address}`);
}

/** A new account, collect-only until credited. The number is returned once and never stored. */
export async function openAccount(
	db: Db,
	key: CryptoKey,
	now: number,
): Promise<{ number: string; accountId: string }> {
	const digits = randomDigits(ACCOUNT_DIGITS);
	const accountId = base64url(crypto.getRandomValues(new Uint8Array(16)));
	await db.insert(accounts).values({
		id: accountId,
		keyHash: await keyHash(key, digits),
		paidThrough: 0,
		frozen: false,
		createdAt: now,
	});
	return { number: formatAccountNumber(digits), accountId };
}

/** The account a number names, however it is spaced or dashed; null for none. Looked up by its
 * hash through the unique index, so no secret is compared in code. */
export async function resolveAccount(
	db: Db,
	key: CryptoKey,
	input: string,
): Promise<string | null> {
	const parsed = parseAccountNumber(input);
	if (!parsed) return null;
	const digits = parsed.replace(/ /g, "");
	const row = await db
		.select({ id: accounts.id })
		.from(accounts)
		.where(eq(accounts.keyHash, await keyHash(key, digits)))
		.get();
	return row?.id ?? null;
}

/** Add paid days, from the later of now and paid-through, once per `op`: a repeated op adds
 * nothing and says so. Negative days remove time, never further back than now. */
export async function credit(
	db: DrizzleD1Database<typeof schema>,
	accountId: string,
	days: number,
	op: string,
	now: number,
): Promise<{ paidThrough: number; applied: boolean }> {
	if (!Number.isSafeInteger(days)) throw new Error("credit takes whole days");
	const ms = days * DAY_MS;
	// One statement, so two payments landing at once can't read the same value and lose one.
	const paidThrough =
		days >= 0
			? sql`max(${now}, ${accounts.paidThrough}) + ${ms}`
			: sql`max(${now}, ${accounts.paidThrough} + ${ms})`;
	// One batch, which D1 runs as a transaction: the op is recorded with this call's token, and the
	// time moves only where the record carries it, so a repeat of the op moves nothing.
	const token = base64url(crypto.getRandomValues(new Uint8Array(16)));
	const [, moved] = await db.batch([
		db.insert(accountCredits).values({ op, accountId, days, token, at: now }).onConflictDoNothing(),
		db
			.update(accounts)
			.set({ paidThrough })
			.where(
				and(
					eq(accounts.id, accountId),
					sql`(select ${accountCredits.token} from ${accountCredits} where ${accountCredits.op} = ${op}) = ${token}`,
				),
			)
			.returning({ paidThrough: accounts.paidThrough }),
	]);
	const [applied] = moved;
	if (applied) return { paidThrough: applied.paidThrough, applied: true };
	const row = await db
		.select({ paidThrough: accounts.paidThrough })
		.from(accounts)
		.where(eq(accounts.id, accountId))
		.get();
	if (!row) throw new Error("no such account");
	return { paidThrough: row.paidThrough, applied: false };
}

export async function freeze(db: Db, accountId: string, frozen: boolean): Promise<void> {
	await db.update(accounts).set({ frozen }).where(eq(accounts.id, accountId));
}

/** An account and everything on it, the account last: its mailboxes refer to it, and a retry after
 * a failure still finds it by its number. Its credits go with it. */
export async function deleteAccount(db: Db, bodies: BodyStore, accountId: string): Promise<void> {
	const owned = await db
		.select({ id: mailboxes.id })
		.from(mailboxes)
		.where(eq(mailboxes.accountId, accountId));
	for (const { id } of owned) await deleteMailbox({ db, bodies }, id);
	await db.delete(accounts).where(eq(accounts.id, accountId));
}

/** The bytes every mailbox on the account holds: pending messages, blobs and wants. */
export function accountUsedBytes(db: Db, accountId: string): Promise<number> {
	const owned = db
		.select({ id: mailboxes.id })
		.from(mailboxes)
		.where(eq(mailboxes.accountId, accountId));
	return heldBytes(db, (column) => inArray(column, owned));
}

/** Whether the account may post now: paid through a time still ahead, and not frozen. */
export async function accountActive(db: Db, accountId: string, now: number): Promise<boolean> {
	const row = await db
		.select({ id: accounts.id })
		.from(accounts)
		.where(
			and(
				eq(accounts.id, accountId),
				sql`${accounts.paidThrough} > ${now}`,
				eq(accounts.frozen, false),
			),
		)
		.get();
	return !!row;
}

export async function accountStatus(
	db: Db,
	accountId: string,
	quotaBytes: number,
): Promise<AccountStatusResponse> {
	const row = await db
		.select({ paidThrough: accounts.paidThrough, frozen: accounts.frozen })
		.from(accounts)
		.where(eq(accounts.id, accountId))
		.get();
	if (!row) throw new Error("no such account");
	return { ...row, usedBytes: await accountUsedBytes(db, accountId), quotaBytes };
}
