// The page Stripe returns to after a payment: it waits for the webhook's time to reach the
// account, then says so. The number and the paid time from before come from this tab's session.
// It shows the number once more, with how to add it in Bramble when this was its first payment.

import { type AccountApi, accountApi } from "./api";
import { BILLING_URL, MAILBOX_URL } from "./endpoints";
import { dateOf } from "./page";
import { PAID_THROUGH_KEY, rememberedNumber } from "./session";

const POLL_MS = 2000;
const WAIT_MS = 30_000;

export async function waitForTime(
	api: AccountApi = accountApi({ billing: BILLING_URL, mailbox: MAILBOX_URL }),
	sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
): Promise<void> {
	const message = document.querySelector('[data-paid="message"]') as HTMLElement;
	const number = rememberedNumber();
	if (!number) {
		message.textContent = "Payment received.";
		return;
	}
	const stored = sessionStorage.getItem(PAID_THROUGH_KEY);
	const before = Number(stored ?? 0);
	// Unknown on a reload once the time has landed: then neither the steps nor the note.
	showNumber(number, stored === null ? null : before === 0);
	const deadline = Date.now() + WAIT_MS;
	for (;;) {
		try {
			const status = await api.status(number);
			if (status.paidThrough > before) {
				sessionStorage.removeItem(PAID_THROUGH_KEY);
				message.textContent = `Payment received. Paid through ${dateOf(status.paidThrough)}.`;
				return;
			}
		} catch {
			// Asked again on the next poll; the closing line covers a mailbox that never answers.
		}
		if (Date.now() + POLL_MS > deadline) break;
		await sleep(POLL_MS);
	}
	message.textContent = "Payment received. Your time will show up in a few minutes.";
}

/** The number and what to do with it: on a first payment, how to add it in Bramble. */
function showNumber(number: string, first: boolean | null): void {
	const part = (name: string) => document.querySelector(`[data-paid="${name}"]`) as HTMLElement;
	part("number").textContent = number;
	part("copy").addEventListener("click", () => void navigator.clipboard.writeText(number));
	part("account").hidden = false;
	if (first !== null) part(first ? "first" : "again").hidden = false;
}
