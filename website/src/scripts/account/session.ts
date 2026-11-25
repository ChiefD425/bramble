// The account page's memory of a number: this tab's sessionStorage only, for the round trip through
// Stripe, and never a URL, a cookie or localStorage.

import { accountFromFragment } from "@vault/core/src/sync/mailbox/protocol.ts";

const NUMBER_KEY = "bramble.account";
/** paidThrough as it was before checkout, so the return page can tell when the time landed. */
export const PAID_THROUGH_KEY = "bramble.paidThrough";

export const rememberedNumber = (): string | null => sessionStorage.getItem(NUMBER_KEY);

export function remember(number: string): void {
	sessionStorage.setItem(NUMBER_KEY, number);
}

export function forget(): void {
	sessionStorage.removeItem(NUMBER_KEY);
	sessionStorage.removeItem(PAID_THROUGH_KEY);
}

/** The number a link sent in the fragment; the fragment leaves the address bar, so it isn't
 * bookmarked or shared. Not remembered: anyone can send a link, so the visitor says it's theirs
 * first. */
export function takeNumberFromUrl(): string | null {
	if (!location.hash.startsWith("#n=")) return null;
	const number = accountFromFragment(location.hash);
	history.replaceState(null, "", `${location.pathname}${location.search}`);
	return number;
}
