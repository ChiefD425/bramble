// The account page (src/pages/account/index.astro): open an account behind ALTCHA, or take a
// number from an app's fragment or the field; then its status, and buying time through Stripe.

import {
	type AccountStatusResponse,
	parseAccountNumber,
} from "@vault/core/src/sync/mailbox/protocol.ts";
import { formatStorage } from "@vault/core/src/util/storage-size.ts";
import {
	type AccountApi,
	AccountError,
	type AccountErrorCode,
	accountApi,
	type PaymentMethod,
	type Purchase,
	solveAltcha,
} from "./api";
import { BILLING_URL, MAILBOX_URL } from "./endpoints";
import { forget, PAID_THROUGH_KEY, remember, rememberedNumber, takeNumberFromUrl } from "./session";

const MESSAGES: Record<AccountErrorCode, string> = {
	rate_limited: "Too many tries. Wait a minute and try again.",
	challenge_failed: "The browser check didn't go through. Try again.",
	account_unknown: "That account number isn't recognized.",
	payment_provider: "The payment provider didn't answer. Try again shortly.",
	method_unavailable:
		"Paying with Bitcoin or Monero isn't available right now. You can pay by card.",
	nothing_to_refund: "That purchase can't be refunded.",
	network: "Can't reach Bramble right now.",
	bad_request: "Something went wrong. Try again.",
	unexpected: "Something went wrong. Try again.",
};

export const messageFor = (err: unknown): string =>
	MESSAGES[err instanceof AccountError ? err.code : "unexpected"];

const MIN_MONTHS = 6;
const MAX_MONTHS = 36;
const PRICE_PER_MONTH = 2;

/** The whole number of months a field names, or null when it can't be bought. Billing checks too. */
export function chosenMonths(value: string): number | null {
	const months = Number(value);
	return value.trim() !== "" &&
		Number.isInteger(months) &&
		months >= MIN_MONTHS &&
		months <= MAX_MONTHS
		? months
		: null;
}

/** Cents as the buyer's locale writes that currency. */
export const money = (cents: number, currency: string): string =>
	new Intl.NumberFormat(undefined, { style: "currency", currency }).format(cents / 100);

export const dateOf = (ms: number): string =>
	new Date(ms).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });

/** The paid-time line, worded as the app words it. */
export function paidLine(status: AccountStatusResponse, now = Date.now()): string {
	if (status.frozen) return "Posting is paused for this account";
	if (status.paidThrough === 0) return "No paid time yet";
	if (status.paidThrough <= now) return `Paid time ended ${dateOf(status.paidThrough)}`;
	return `Paid through ${dateOf(status.paidThrough)}`;
}

export const usedLine = (status: AccountStatusResponse): string =>
	`${formatStorage(status.usedBytes, navigator.language)} of ${formatStorage(status.quotaBytes, navigator.language)} used`;

/** A button whose action is running: disabled, with a spinner (starwind.css) and aria-busy. */
function working(button: HTMLButtonElement, on: boolean): void {
	button.disabled = on;
	if (on) button.setAttribute("aria-busy", "true");
	else button.removeAttribute("aria-busy");
}

/** An element of the page by its data-account name. */
export function part<T extends HTMLElement = HTMLElement>(name: string): T {
	const found = document.querySelector<T>(`[data-account="${name}"]`);
	if (!found) throw new Error(`the account page has no "${name}"`);
	return found;
}

export function start(
	api: AccountApi = accountApi({ billing: BILLING_URL, mailbox: MAILBOX_URL }),
) {
	const error = part("error");
	const showError = (message: string | null) => {
		error.textContent = message ?? "";
		error.hidden = !message;
	};
	const create = part<HTMLButtonElement>("create");
	const checking = part("checking");
	const input = part<HTMLInputElement>("number-input");
	const numberError = part("number-error");
	const months = part<HTMLInputElement>("months");
	/** The three ways to pay, each its own button of the same weight. */
	const payButtons = [...document.querySelectorAll<HTMLButtonElement>("[data-pay]")];
	let number: string | null = null;
	let shown = false;
	let paidThrough = 0;
	/** Set before anything awaits, so a second click while one runs does nothing. */
	let busy = false;

	async function refresh() {
		if (!number) return;
		try {
			const status = await api.status(number);
			paidThrough = status.paidThrough;
			part("paid").textContent = paidLine(status);
			part("used").textContent = usedLine(status);
			showError(null);
		} catch (err) {
			part("paid").textContent = "";
			part("used").textContent = "";
			showError(messageFor(err));
		}
	}

	async function loadPurchases() {
		if (!number) return;
		let purchases: Purchase[];
		try {
			purchases = await api.purchases(number);
		} catch (err) {
			showError(messageFor(err));
			return;
		}
		part("purchases").replaceChildren(...purchases.map(purchaseRow));
		part("no-purchases").hidden = purchases.length > 0;
		part("delete-refund-note").hidden = purchases.length === 0;
	}

	/** A purchase's row, from the page's template: "Refund" asks before it refunds. */
	function purchaseRow(purchase: Purchase): HTMLElement {
		const template = part<HTMLTemplateElement>("purchase-row").content.firstElementChild;
		const row = template?.cloneNode(true) as HTMLElement;
		const slot = <T extends HTMLElement = HTMLElement>(name: string) =>
			row.querySelector(`[data-row="${name}"]`) as T;
		const refund = slot<HTMLButtonElement>("refund");
		const confirm = slot("confirm");
		const yes = slot<HTMLButtonElement>("yes");
		slot("label").textContent = `${purchase.day}: ${purchase.days} days`;
		const paidFor = purchase.days - purchase.refundDays;
		slot("question").textContent =
			`Refund ${money(purchase.refundAmount, purchase.currency)}? You pay for ${paidFor} ${paidFor === 1 ? "day" : "days"}, and the other ${purchase.refundDays} come off the account.`;
		const asking = (on: boolean) => {
			refund.hidden = on;
			confirm.hidden = !on;
		};
		refund.addEventListener("click", () => asking(true));
		slot("keep").addEventListener("click", () => asking(false));
		yes.addEventListener("click", async () => {
			if (busy || !number) return;
			busy = true;
			yes.disabled = true;
			showError(null);
			try {
				const refunded = await api.refund(number, purchase.id);
				const message = part("refund-message");
				message.textContent = `Refunded ${money(refunded.amount, refunded.currency)}. ${refunded.days} days came off the account.`;
				message.hidden = false;
				await Promise.all([loadPurchases(), refresh()]);
			} catch (err) {
				showError(messageFor(err));
				asking(false);
			} finally {
				busy = false;
				yes.disabled = false;
			}
		});
		return row;
	}

	/** The number masked unless asked for, as the app shows it; in full just after it is made. */
	function paintNumber() {
		if (!number) return;
		part("number").textContent = shown ? number : `••••• ••••• ••••• ••••• ${number.slice(-5)}`;
		part("show").textContent = shown ? "Hide" : "Show";
	}

	function showAccount(next: string, created: boolean) {
		number = next;
		shown = created;
		part("confirm").hidden = true;
		part("start").hidden = true;
		part("account").hidden = false;
		part("created").hidden = !created;
		paintNumber();
		part("refund-message").hidden = true;
		part("notice").hidden = true;
		askingToDelete(false);
		void refresh();
		void loadPurchases();
	}

	function showStart() {
		number = null;
		part("confirm").hidden = true;
		part("start").hidden = false;
		part("account").hidden = true;
		showError(null);
	}

	/** A number from a link, shown in full: anyone can send one, so it's used only once the visitor
	 * says it's theirs. */
	let offered: string | null = null;
	function showConfirm(next: string) {
		offered = next;
		part("start").hidden = true;
		part("account").hidden = true;
		part("confirm").hidden = false;
		part("confirm-number").textContent = next;
	}
	part("confirm-yes").addEventListener("click", () => {
		if (!offered) return;
		remember(offered);
		showAccount(offered, false);
		offered = null;
	});
	part("confirm-no").addEventListener("click", () => {
		offered = null;
		showStart();
	});

	create.addEventListener("click", async () => {
		if (busy) return;
		busy = true;
		working(create, true);
		checking.hidden = false;
		showError(null);
		try {
			const opened = parseAccountNumber(
				await api.openAccount(await solveAltcha(await api.challenge())),
			);
			if (!opened) throw new AccountError("unexpected");
			remember(opened);
			showAccount(opened, true);
		} catch (err) {
			showError(messageFor(err));
		} finally {
			busy = false;
			working(create, false);
			checking.hidden = true;
		}
	});

	part<HTMLFormElement>("number-form").addEventListener("submit", (event) => {
		event.preventDefault();
		const parsed = parseAccountNumber(input.value);
		numberError.hidden = !!parsed;
		if (!parsed) return;
		input.value = "";
		remember(parsed);
		showAccount(parsed, false);
	});

	/** The total follows the field, and the buttons are disabled for a number it can't buy. */
	function paintMonths() {
		const chosen = chosenMonths(months.value);
		for (const button of payButtons) button.disabled = busy || chosen === null;
		part("months-error").hidden = chosen !== null;
		const total = part("total");
		total.hidden = chosen === null;
		if (chosen !== null) total.textContent = `${chosen} months, $${chosen * PRICE_PER_MONTH}`;
	}
	months.addEventListener("input", paintMonths);
	for (const shortcut of document.querySelectorAll<HTMLButtonElement>("[data-months]")) {
		shortcut.addEventListener("click", () => {
			months.value = shortcut.dataset.months ?? "";
			paintMonths();
		});
	}

	/** Checkout by card or crypto: the processor's page, with the paid time remembered for the paid
	 * page to tell when the new time lands. */
	async function checkout(method: PaymentMethod, button: HTMLButtonElement) {
		const chosen = chosenMonths(months.value);
		if (busy || !number || chosen === null) return;
		busy = true;
		working(button, true);
		paintMonths();
		showError(null);
		try {
			const url = await api.checkout(
				number,
				chosen,
				await solveAltcha(await api.challenge()),
				method,
			);
			if (!url.startsWith("https://")) throw new AccountError("unexpected");
			sessionStorage.setItem(PAID_THROUGH_KEY, String(paidThrough));
			location.assign(url);
		} catch (err) {
			showError(messageFor(err));
			busy = false;
			working(button, false);
			paintMonths();
		}
	}
	for (const button of payButtons) {
		button.addEventListener(
			"click",
			() => void checkout(button.dataset.pay as PaymentMethod, button),
		);
	}

	part("show").addEventListener("click", () => {
		shown = !shown;
		paintNumber();
	});
	part("copy").addEventListener("click", () => {
		if (number) void navigator.clipboard.writeText(number);
	});
	part("sign-out").addEventListener("click", () => {
		forget();
		showStart();
	});

	function askingToDelete(on: boolean) {
		part("delete").hidden = on;
		part("delete-confirm").hidden = !on;
	}
	part("delete").addEventListener("click", () => askingToDelete(true));
	part("delete-keep").addEventListener("click", () => askingToDelete(false));
	const deleteYes = part<HTMLButtonElement>("delete-yes");
	deleteYes.addEventListener("click", async () => {
		if (busy || !number) return;
		busy = true;
		deleteYes.disabled = true;
		showError(null);
		try {
			await api.deleteAccount(number);
			forget();
			showStart();
			part("notice").hidden = false;
		} catch (err) {
			showError(messageFor(err));
		} finally {
			busy = false;
			deleteYes.disabled = false;
		}
	});

	// Back from Stripe may restore this page from the browser's cache just as it was left, in the
	// middle of a checkout: let go of it and read the account again.
	window.addEventListener("pageshow", (event) => {
		if (!event.persisted) return;
		busy = false;
		for (const button of payButtons) working(button, false);
		paintMonths();
		working(create, false);
		checking.hidden = true;
		void refresh();
		void loadPurchases();
	});

	const arrived = takeNumberFromUrl();
	const known = rememberedNumber();
	if (arrived && arrived !== known) showConfirm(arrived);
	else if (known) showAccount(known, false);
	else showStart();
}
