// Website feature flags (website/src/flags.ts): a flagged page stays out of sight on the live site
// unless this tab asked for it with `?ff=`.

import { expect, type Page, test } from "@playwright/test";

const accountHeading = (page: Page) =>
	page.getByRole("heading", { name: "Your Bramble Mailbox account" });

const isHome = async (page: Page) => {
	await expect(page).toHaveURL(/\/$/);
	await expect(accountHeading(page)).toHaveCount(0);
	await expect(page.getByRole("heading", { level: 1 }).first()).toBeVisible();
};

test("a flagged page sends a visitor without the flag home", async ({ page }) => {
	await page.goto("/account/");
	await isHome(page);
	await page.goto("/account/paid");
	await isHome(page);
});

test("the flag shows the page, and the tab keeps it for the trip to Stripe and back", async ({
	page,
}) => {
	await page.goto("/account/?ff=account");
	await expect(accountHeading(page)).toBeVisible();
	await page.goto("/account/paid");
	await expect(accountHeading(page)).toBeVisible();
	await page.goto("/account/");
	await expect(accountHeading(page)).toBeVisible();
});

test("any page takes the flag", async ({ page }) => {
	await page.goto("/?ff=account");
	await page.goto("/account/");
	await expect(accountHeading(page)).toBeVisible();
});

test("another tab doesn't have it", async ({ context, page }) => {
	await page.goto("/account/?ff=account");
	await expect(accountHeading(page)).toBeVisible();
	const other = await context.newPage();
	await other.goto("/account/");
	await isHome(other);
});

test("an empty value turns it off", async ({ page }) => {
	await page.goto("/account/?ff=account");
	await expect(accountHeading(page)).toBeVisible();
	await page.goto("/?ff=");
	await page.goto("/account/");
	await isHome(page);
});

test("an unknown name does nothing", async ({ page }) => {
	await page.goto("/account/?ff=nope");
	await isHome(page);
});

test("a page with no flag is left alone", async ({ page }) => {
	await page.goto("/support");
	await expect(page).toHaveURL(/\/support$/);
});

test("a flagged page asks not to be indexed, and only a flagged one", async ({ page }) => {
	await page.goto("/account/?ff=account");
	await expect(page.locator('meta[name="robots"][content="noindex"]')).toHaveCount(1);
	await page.goto("/support");
	await expect(page.locator('meta[name="robots"]')).toHaveCount(0);
});
