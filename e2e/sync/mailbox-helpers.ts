import type { Locator, Page } from "@playwright/test";
import { expect } from "./fixtures";

// What the mailbox specs share. See mailbox.spec.ts and mailbox-mobile.spec.ts.

/** The local mailbox server playwright.sync.config.ts starts. */
export const MAILBOX = "http://localhost:7401";
export const SYNCED = /Synced through the mailbox/;

/**
 * Step back until the vault list shows: a reloaded popup reopens on the last screen any view saw.
 * Waits for the page to settle on the list or a screen with a Back button before acting.
 */
export async function toList(page: Page): Promise<void> {
	const addNew = page.getByRole("button", { name: /Add New/i });
	const backButton = page.getByRole("button", { name: /^(Back|Go back)/i }).first();
	for (let step = 0; step < 6; step++) {
		await expect(addNew.or(backButton).first()).toBeVisible();
		if (await addNew.isVisible()) return;
		await backButton.click();
	}
	throw new Error("couldn't reach the vault list");
}

/** The Mailbox card: the innermost element holding its heading and `control`. */
function mailboxCard(page: Page, control: Locator): Locator {
	return page
		.locator("div")
		.filter({ has: page.getByRole("heading", { name: "Mailbox", exact: true }) })
		.filter({ has: control })
		.last();
}

/** One mailbox round from the Sync tab, by the Mailbox card's "Sync now" (not the device list's),
 * which stays disabled while it runs. */
export async function mailboxRound(page: Page): Promise<void> {
	const name = { name: "Sync now" } as const;
	const button = mailboxCard(page, page.getByRole("button", name)).getByRole("button", name);
	await button.click();
	await expect(button).toBeEnabled({ timeout: 30_000 });
}

/**
 * Press the mailbox's "Sync now" on the Sync tab until `done` holds: rounds are otherwise minutes apart. The
 * button stays disabled while its round runs, so each check sees a finished round, and a device
 * is never locked in the middle of one.
 */
export async function syncUntil(page: Page, done: () => Promise<void>): Promise<void> {
	await expect(async () => {
		await mailboxRound(page);
		await done();
	}).toPass({ timeout: 90_000 });
}

/** On the Sync tab: use the local mailbox, and wait for this device's first round through it. */
export async function useLocalMailbox(page: Page): Promise<void> {
	// A server of one's own sits under the Mailbox card's Advanced, closed while the hosted
	// mailbox is on offer.
	const field = page.getByLabel("Mailbox server");
	if (!(await field.isVisible())) {
		const advanced = { name: "Advanced" } as const;
		await mailboxCard(page, page.getByRole("button", advanced))
			.getByRole("button", advanced)
			.click();
	}
	await field.fill(MAILBOX);
	await page.getByRole("button", { name: "Use this server" }).click();
	await expect(page.getByText(MAILBOX)).toBeVisible();
	await syncUntil(page, () => expect(page.getByText(SYNCED)).toBeVisible());
}
