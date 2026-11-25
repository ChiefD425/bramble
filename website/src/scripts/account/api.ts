// The account page's calls: billing's public API (docs/mailbox-service.md) and the
// mailbox's account status. The number travels in request bodies and in the mailbox's header, never
// in a URL.

import {
	type AccountStatusResponse,
	AccountStatusResponseSchema,
	HEADERS,
} from "@vault/core/src/sync/mailbox/protocol.ts";
import { type Challenge, solveChallenge } from "altcha-lib";
// The WebCrypto build: the default one uses node:crypto, which a browser has not got.
import { deriveKey } from "altcha-lib/algorithms/web/pbkdf2";

const BILLING_CODES = [
	"rate_limited",
	"challenge_failed",
	"account_unknown",
	"bad_request",
	"payment_provider",
	"nothing_to_refund",
	"method_unavailable",
] as const;
/** A card through Stripe, or Bitcoin and Monero through BTCPay. */
export type PaymentMethod = "card" | "crypto";

export type AccountErrorCode = (typeof BILLING_CODES)[number] | "network" | "unexpected";

export class AccountError extends Error {
	readonly code: AccountErrorCode;
	constructor(code: AccountErrorCode) {
		super(code);
		this.name = "AccountError";
		this.code = code;
	}
}

export interface Purchase {
	id: string;
	day: string;
	days: number;
	/** What refunding it now gives back: those days come off, and that much money, in cents. */
	refundDays: number;
	refundAmount: number;
	currency: string;
}

export interface Refunded {
	days: number;
	amount: number;
	currency: string;
}

const codeOf = (body: unknown): AccountErrorCode => {
	const error = (body as { error?: unknown } | null)?.error;
	return BILLING_CODES.find((code) => code === error) ?? "unexpected";
};

export function accountApi(opts: { billing: string; mailbox: string; fetch?: typeof fetch }) {
	const send = opts.fetch ?? ((input, init) => fetch(input, init));
	async function call(url: string, init?: RequestInit): Promise<unknown> {
		let res: Response;
		try {
			res = await send(url, init);
		} catch {
			throw new AccountError("network");
		}
		const body: unknown = await res.json().catch(() => null);
		if (!res.ok) throw new AccountError(codeOf(body));
		return body;
	}
	const post = (path: string, body: unknown) =>
		call(`${opts.billing}${path}`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(body),
		});
	const field = <T>(body: unknown, key: string, is: (v: unknown) => v is T): T => {
		const value = (body as Record<string, unknown> | null)?.[key];
		if (!is(value)) throw new AccountError("unexpected");
		return value;
	};
	const isString = (v: unknown): v is string => typeof v === "string";

	return {
		challenge: async () => (await call(`${opts.billing}/v1/challenge`)) as Challenge,
		openAccount: async (altcha: string) =>
			field(await post("/v1/accounts", { altcha }), "number", isString),
		checkout: async (
			number: string,
			months: number,
			altcha: string,
			method: PaymentMethod = "card",
		) => field(await post("/v1/checkout", { number, months, altcha, method }), "url", isString),
		purchases: async (number: string) =>
			field(await post("/v1/purchases", { number }), "purchases", Array.isArray) as Purchase[],
		refund: async (number: string, purchase: string): Promise<Refunded> => {
			const body = await post("/v1/refunds", { number, purchase });
			const isNumber = (v: unknown): v is number => typeof v === "number";
			return {
				days: field(body, "days", isNumber),
				amount: field(body, "amount", isNumber),
				currency: field(body, "currency", isString),
			};
		},
		deleteAccount: async (number: string): Promise<void> => {
			await post("/v1/accounts/delete", { number });
		},
		status: async (number: string): Promise<AccountStatusResponse> => {
			const parsed = AccountStatusResponseSchema.safeParse(
				await call(`${opts.mailbox}/v1/accounts/status`, {
					headers: { [HEADERS.account]: number },
				}),
			);
			if (!parsed.success) throw new AccountError("unexpected");
			return parsed.data;
		},
	};
}

export type AccountApi = ReturnType<typeof accountApi>;

/** A solved challenge, as billing reads it: base64 of `{ challenge, solution }`. */
export async function solveAltcha(challenge: Challenge): Promise<string> {
	const solution = await solveChallenge({ challenge, deriveKey });
	if (!solution) throw new AccountError("challenge_failed");
	return btoa(JSON.stringify({ challenge, solution }));
}
