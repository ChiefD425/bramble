import type { Page } from "@playwright/test";
import { createVault, expect, gotoSync, PW, test } from "./fixtures";

// Mobile's default "Immediately" auto-lock fires on every trip to another app. Coming back from
// one is not being done with the screen, so the unlock returns to it. Every other lock (the Lock
// button, idling in the app) unlocks to the list. Here for the mobile SPA this suite serves.

/** What the OS does when the user switches to another app: Capacitor's App plugin reports it. */
async function leaveApp(page: Page): Promise<void> {
	await page.evaluate(async () => {
		const app = (window as unknown as { Capacitor: { Plugins: Record<string, unknown> } }).Capacitor
			.Plugins.App as { notifyListeners: (event: string, data: unknown) => Promise<void> };
		await app.notifyListeners("appStateChange", { isActive: false });
	});
}

const unlockButton = (page: Page) => page.getByRole("button", { name: "Unlock Vault" });

async function unlock(page: Page): Promise<void> {
	await page.locator('input[type="password"]').first().fill(PW);
	await unlockButton(page).click();
	await expect(page.getByRole("button", { name: "Lock vault", exact: true })).toBeVisible();
}

/** A fresh mobile vault. The welcome screen renders after the page loads, and createVault only
 * clicks through it if it is already there. */
async function freshVault(page: Page): Promise<void> {
	await page.getByRole("button", { name: /Create your vault/i }).click();
	await createVault(page);
	await expect(page.getByRole("button", { name: "Lock vault", exact: true })).toBeVisible();
}

const sections = (page: Page) => page.getByRole("navigation", { name: "Settings sections" });

test("coming back to the app returns to the screen it left", async ({ mobile }) => {
	const { page } = mobile;
	await freshVault(page);
	await gotoSync(page);

	await leaveApp(page);
	await expect(unlockButton(page)).toBeVisible();
	await unlock(page);

	await expect(page.getByRole("heading", { name: /Device sync/i })).toBeVisible();
	await expect(sections(page).getByRole("button", { name: "Sync" })).toHaveAttribute(
		"aria-current",
		"true",
	);
});

test("coming back to the app keeps the list's search", async ({ mobile }) => {
	const { page } = mobile;
	await freshVault(page);
	const search = page.getByLabel(/Search vault/i);
	await search.fill("bank");

	await leaveApp(page);
	await expect(unlockButton(page)).toBeVisible();
	await unlock(page);

	await expect(search).toHaveValue("bank");
});

test("the Lock button unlocks to the list", async ({ mobile }) => {
	const { page } = mobile;
	await freshVault(page);
	await gotoSync(page);

	await page.getByRole("button", { name: "Lock vault", exact: true }).click();
	await expect(unlockButton(page)).toBeVisible();
	await unlock(page);

	await expect(page.getByLabel(/Search vault/i)).toBeVisible();
	await expect(sections(page)).toHaveCount(0);
});
