import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "./fixtures";
import { createVault, downloadAttachment, expectUnlocked, optionsUrl, popupUrl } from "./helpers";

const dir = path.dirname(fileURLToPath(import.meta.url));
const fixture = (name: string) =>
	path.join(dir, "../../clients/extension/src/fixtures/imports", name);
const FIXTURE = fixture("onepassword-files.1pux");

// A 1Password export carries its files beside export.data: the parser is unit-tested, but only
// this shows them sealed onto the entries and opened again. Bank's statement is on a field,
// Passport is a Document item.
test("imports a 1Password export's files onto the items that hold them", async ({
	context,
	extensionId,
}) => {
	const page = await context.newPage();
	await createVault(page, extensionId);

	await page.goto(`${optionsUrl(extensionId)}?screen=import`);
	const card = page
		.locator("label")
		.filter({ hasText: /1Password/ })
		.first();
	await card.locator('input[type="file"]').setInputFiles(FIXTURE);
	await expect(page.getByText(/· 2 attachments$/)).toBeVisible();
	await page.getByRole("button", { name: /Import 2 items/i }).click();
	await expect(page.getByText(/2 attachments came with them/i)).toBeVisible();

	const popup = await context.newPage();
	await popup.goto(`${popupUrl(extensionId)}?detached=1`);
	await expectUnlocked(popup);
	expect((await downloadAttachment(popup, "Bank", "statement.pdf")).toString()).toBe(
		"fake bank statement",
	);
	expect((await downloadAttachment(popup, "Passport", "passport-scan.png")).toString()).toBe(
		"fake passport scan",
	);
});

// 1Password 7 exports a .1pif folder. Its data.1pif alone brings the items, and the preview says
// what stays behind; the folder zipped brings the attachments beside it too.
test("imports a 1Password 7 data.1pif, and says its attachments stay behind", async ({
	context,
	extensionId,
}) => {
	const page = await context.newPage();
	await createVault(page, extensionId);

	await page.goto(`${optionsUrl(extensionId)}?screen=import`);
	const card = page
		.locator("label")
		.filter({ hasText: /1Password/ })
		.first();
	await card.locator('input[type="file"]').setInputFiles(fixture("onepassword7-data.1pif"));
	// A login, a card and a note; the folder is a tag and the trashed note stays behind.
	await expect(page.getByRole("button", { name: /Import 3 items/i })).toBeVisible();
	await expect(page.getByText(/Attachments aren't in data\.1pif/)).toBeVisible();
	await expect(page.getByText(/1 item\(s\) were in a 1Password folder/)).toBeVisible();
	await page.getByRole("button", { name: /Import 3 items/i }).click();
	await expect(page.getByRole("heading", { name: /Imported 3 items/i })).toBeVisible();

	const popup = await context.newPage();
	await popup.goto(`${popupUrl(extensionId)}?detached=1`);
	await expectUnlocked(popup);
	const search = popup.getByLabel(/Search vault/i);
	await search.fill("#finance");
	await expect(popup.getByText("Items (1)")).toBeVisible();
	await expect(popup.getByText("Bank", { exact: true })).toBeVisible();
});

test("imports a zipped 1Password 7 export folder with its attachments", async ({
	context,
	extensionId,
}) => {
	const page = await context.newPage();
	await createVault(page, extensionId);

	await page.goto(`${optionsUrl(extensionId)}?screen=import`);
	const card = page
		.locator("label")
		.filter({ hasText: /1Password/ })
		.first();
	await card.locator('input[type="file"]').setInputFiles(fixture("onepassword7.zip"));
	await expect(page.getByText(/· 1 attachment$/)).toBeVisible();
	await expect(page.getByText(/Attachments aren't in data\.1pif/)).toHaveCount(0);
	await page.getByRole("button", { name: /Import 3 items/i }).click();
	await expect(page.getByText(/1 attachment came with them/i)).toBeVisible();

	const popup = await context.newPage();
	await popup.goto(`${popupUrl(extensionId)}?detached=1`);
	await expectUnlocked(popup);
	expect((await downloadAttachment(popup, "House deed", "deed-scan.txt")).toString()).toBe(
		"fake house deed scan",
	);
});
