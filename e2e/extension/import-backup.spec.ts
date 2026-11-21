import { readFileSync } from "node:fs";
import type { BrowserContext, Page } from "@playwright/test";
import { expect, test } from "./fixtures";
import {
	backgroundWorker,
	createVault,
	gotoBackups,
	openExampleLogin,
	openPopup,
	optionsUrl,
	popupUrl,
	STRONG_PW,
} from "./helpers";

// Importing a full .bramble backup from inside a vault merges it into that vault, attachments
// included. It used to be turned away with "Restore it instead", and Settings' "Import a backup"
// added it as a vault of its own. Restoring as a separate vault is vault setup's job now.

// Two sealed chunks and a short third, so the copied blob is checked across chunk boundaries.
const BODY = Buffer.from(
	Uint8Array.from({ length: 2 * 256 * 1024 + 99 }, (_, i) => (i * 17) % 253),
);

async function vaultCount(context: BrowserContext): Promise<number> {
	const sw = await backgroundWorker(context);
	return sw.evaluate(async () => {
		const reg = (await chrome.storage.local.get("vault.registry"))["vault.registry"] as {
			vaults?: unknown[];
		};
		return reg?.vaults?.length ?? 0;
	});
}

async function exportBackup(popup: Page): Promise<string> {
	await gotoBackups(popup);
	const exporting = popup.waitForEvent("download");
	await popup.getByRole("button", { name: "Export an encrypted backup" }).click();
	return (await (await exporting).path()) as string;
}

/** Pick the backup on the import screen and open it with the backed-up vault's password. */
async function openBackup(page: Page, file: string) {
	await page.locator('input[type="file"]').setInputFiles(file);
	await page.locator('input[type="password"]').first().fill(STRONG_PW);
	await page.getByRole("button", { name: /Open database/i }).click();
}

test("a backup imported into another vault merges in, attachment and all", async ({
	context,
	extensionId,
}) => {
	const popup = await openExampleLogin(context, extensionId, { detached: true });
	await popup.locator('input[type="file"]').setInputFiles({
		name: "deed.pdf",
		mimeType: "application/pdf",
		buffer: BODY,
	});
	await expect(popup.getByText("deed.pdf")).toBeVisible();
	await popup.getByRole("button", { name: "Go to vault" }).click();
	const backup = await exportBackup(popup);
	expect(readFileSync(backup).subarray(0, 2).toString()).toBe("PK");

	// A second, empty vault under its own key: the backup's file key has to move over to it.
	await createVault(await context.newPage(), extensionId);
	const page = await context.newPage();
	await page.goto(`${optionsUrl(extensionId)}?screen=import-backup`);
	await openBackup(page, backup);
	await expect(page.getByText(/1 items ready to import/i)).toBeVisible();
	await expect(page.getByText(/1 attachment$/)).toBeVisible();
	await page.getByRole("button", { name: /Import 1 items/i }).click();
	await expect(page.getByRole("heading", { name: /Imported 1 items/i })).toBeVisible();
	await expect(page.getByText(/1 attachment came with them/i)).toBeVisible();
	// Merged, not added as a third vault.
	expect(await vaultCount(context)).toBe(2);

	// Opened from the vault it was merged into, byte for byte.
	const view = await context.newPage();
	await view.goto(`${popupUrl(extensionId)}?detached=1`);
	// The popup reopens where it was last left: Settings, from the export.
	await view.getByRole("button", { name: "Go to vault" }).click();
	await view.getByText("Example Login").click();
	await expect(view.getByText("deed.pdf")).toBeVisible();
	const downloading = view.waitForEvent("download");
	await view.getByRole("button", { name: "Open attachment" }).click();
	const saved = readFileSync((await (await downloading).path()) as string);
	expect(saved.equals(BODY)).toBe(true);
});

test("Settings' Import a backup brings back what this vault lost, and nothing twice", async ({
	context,
	extensionId,
}) => {
	const popup = await openExampleLogin(context, extensionId);
	await popup.getByRole("button", { name: "Go to vault" }).click();
	const backup = await exportBackup(popup);

	await popup.getByRole("button", { name: "Go to vault" }).click();
	await popup.getByText("Example Login").click();
	await popup.getByRole("button", { name: "Delete entry" }).click();
	await popup.getByRole("button", { name: "Delete", exact: true }).click();
	await expect(popup.getByText("Example Login")).toHaveCount(0);

	await gotoBackups(popup);
	const opening = context.waitForEvent("page");
	await popup.getByRole("button", { name: "Import a backup" }).click();
	const page = await opening;
	await expect(page).toHaveURL(/screen=import-backup/);
	// Only the .bramble route here, not the other managers.
	await expect(page.getByText("Bitwarden")).toHaveCount(0);
	await openBackup(page, backup);
	await expect(page.getByText(/1 items ready to import/i)).toBeVisible();
	await page.getByRole("button", { name: /Import 1 items/i }).click();
	await expect(page.getByRole("heading", { name: /Imported 1 items/i })).toBeVisible();
	await expect(page.getByText(/still encrypted, so it's safe to keep/i)).toBeVisible();
	expect(await vaultCount(context)).toBe(1);

	// The popup closed itself once it opened the import tab, as it does for the user.
	const view = await context.newPage();
	await openPopup(view, extensionId);
	await view.getByRole("button", { name: "Go to vault" }).click();
	await expect(view.getByText("Example Login")).toBeVisible();

	// The same backup again: everything in it is here now.
	const again = await context.newPage();
	await again.goto(`${optionsUrl(extensionId)}?screen=import-backup`);
	await openBackup(again, backup);
	await expect(again.getByText(/already in your vault/i)).toBeVisible();
	await expect(again.getByText(/items ready to import/i)).toBeHidden();
	expect(await vaultCount(context)).toBe(1);
});
