// When the hosted mailbox's paid time is ending. See docs/mailbox-service.md, "The paid-time card".

const DAY_MS = 86_400_000;

/** The notice shows from this many days before the paid time ends. */
export const EXPIRY_NOTICE_DAYS = 14;
/** Closed earlier, the vault list's card comes back once from this many days out. */
const FINAL_NOTICE_DAYS = 3;

/** This device closed the card for the paid time that ends at `paidThrough`, at `at`. */
export interface ExpiryClosed {
	paidThrough: number;
	at: number;
}

export const mailboxExpiryClosedKey = (vaultId: string) => `mailbox.expiryClosed:${vaultId}`;

export function isExpiryClosed(raw: unknown): raw is ExpiryClosed {
	const r = raw as Partial<ExpiryClosed> | null;
	return typeof r?.paidThrough === "number" && typeof r.at === "number";
}

/**
 * What the vault list's card says, if anything. Closing it holds for the paid time it was closed
 * for, until FINAL_NOTICE_DAYS out; once the time has ended it can't be closed. More time moves
 * `paidThrough`, so a close for the old date no longer counts.
 */
export function expiryStage(
	paidThrough: number,
	closed: ExpiryClosed | undefined,
	now: number,
): "ending" | "ended" | null {
	// No paid time yet: nothing is ending, and the Mailbox card says so.
	if (paidThrough <= 0) return null;
	const left = paidThrough - now;
	if (left <= 0) return "ended";
	if (left > EXPIRY_NOTICE_DAYS * DAY_MS) return null;
	if (closed?.paidThrough === paidThrough) {
		const finalFrom = paidThrough - FINAL_NOTICE_DAYS * DAY_MS;
		if (now < finalFrom || closed.at >= finalFrom) return null;
	}
	return "ending";
}

export function paidDate(ms: number, locale: string): string {
	return new Date(ms).toLocaleDateString(locale, {
		year: "numeric",
		month: "short",
		day: "numeric",
	});
}
