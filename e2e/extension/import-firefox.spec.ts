import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "./fixtures";
import { createVault, expectUnlocked, openPopup, optionsUrl } from "./helpers";

const dir = path.dirname(fileURLToPath(import.meta.url));
const fixture = (name: string) =>
	path.join(dir, "../../clients/extension/src/fixtures/imports", name);

// The parser's own rules are unit-tested in firefox.test.ts. What is only reachable here is the
// whole path: the provider card, the file read, the preview's counts, and the logins arriving.
test("imports a Firefox CSV export end to end", async ({ context, extensionId }) => {
	const page = await context.newPage();
	await createVault(page, extensionId);

	await page.goto(`${optionsUrl(extensionId)}?screen=import`);
	const card = page
		.locator("label")
		.filter({ hasText: /Firefox/ })
		.first();
	await expect(card).toBeVisible();
	await card.locator('input[type="file"]').setInputFiles(fixture("firefox.csv"));

	// 4 rows, 3 logins: Firefox's own account record stays behind.
	await expect(page.getByRole("button", { name: /Import 3 items/i })).toBeVisible();
	await page.getByRole("button", { name: /Import 3 items/i }).click();
	await expect(page.getByRole("heading", { name: /Imported 3 items/i })).toBeVisible();

	const popup = await context.newPage();
	await openPopup(popup, extensionId);
	await expectUnlocked(popup);
	await expect(popup.getByText("github.com", { exact: true })).toBeVisible();
	await expect(popup.getByText("router.example.net", { exact: true })).toBeVisible();
	await expect(popup.getByText(/FirefoxAccounts/)).toHaveCount(0);
});

test("names Firefox when its export is given to the Google card", async ({
	context,
	extensionId,
}) => {
	const page = await context.newPage();
	await createVault(page, extensionId);

	await page.goto(`${optionsUrl(extensionId)}?screen=import`);
	const card = page
		.locator("label")
		.filter({ hasText: /Google Password Manager/ })
		.first();
	await card.locator('input[type="file"]').setInputFiles(fixture("firefox.csv"));

	await expect(page.getByText(/looks like an export from Firefox/i)).toBeVisible();
});
