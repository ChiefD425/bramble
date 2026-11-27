import type { Page } from "@playwright/test";
import { expect, test } from "./fixtures";
import {
	createVault,
	lockToPicker,
	openPopup,
	STRONG_PW,
	selectVault,
	waitOutPickerClickGuard,
} from "./helpers";

async function deleteOpenVault(popup: Page) {
	await popup.getByRole("button", { name: "Settings" }).click();
	await popup.getByRole("button", { name: "Delete this vault" }).click();
	await popup.getByLabel("Master password").fill(STRONG_PW);
	await popup.getByRole("button", { name: "Delete this vault" }).click();
	await expect(popup.getByRole("heading", { name: /Choose a vault/i })).toBeVisible();
}

// Unnamed vaults were numbered by their place on the list, so deleting Vault 1 relabelled the
// others Vault 1 and Vault 2: the deleted name stayed and the last vault seemed to go.
test("a deleted vault's name leaves the picker, and the rest keep theirs", async ({
	context,
	extensionId,
}) => {
	for (let i = 0; i < 3; i++) await createVault(await context.newPage(), extensionId);

	const popup = await context.newPage();
	await openPopup(popup, extensionId);
	await lockToPicker(popup);
	await waitOutPickerClickGuard(popup);
	await selectVault(popup, /Vault 1/);
	await deleteOpenVault(popup);

	const rows = popup.getByRole("button", { name: /^V\d\s*Vault \d/ });
	await expect(rows).toHaveCount(2);
	await expect(rows.nth(0)).toContainText("Vault 2");
	await expect(rows.nth(1)).toContainText("Vault 3");

	const reopened = await context.newPage();
	await openPopup(reopened, extensionId);
	await expect(reopened.getByRole("button", { name: /Vault 1/ })).toHaveCount(0);
	await expect(reopened.getByRole("button", { name: /Vault 2/ })).toBeVisible();
	await expect(reopened.getByRole("button", { name: /Vault 3/ })).toBeVisible();
});

// #261: a vault leaves from the unlock screen without being opened, confirmed by typing its name,
// and the others still open.
test("deletes a vault from the picker without unlocking it", async ({ context, extensionId }) => {
	for (let i = 0; i < 3; i++) await createVault(await context.newPage(), extensionId);

	const popup = await context.newPage();
	await openPopup(popup, extensionId);
	await lockToPicker(popup);
	await waitOutPickerClickGuard(popup);

	await popup.getByRole("button", { name: "Delete a vault" }).click();
	await popup.getByRole("button", { name: "Delete Vault 1" }).click();
	const confirm = popup.getByRole("button", { name: "Delete vault", exact: true });
	await expect(confirm).toBeDisabled();
	await popup.getByLabel("Type Vault 1 to confirm").fill("Vault 1");
	await confirm.click();

	const rows = popup.getByRole("button", { name: /^V\d\s*Vault \d/ });
	await expect(rows).toHaveCount(2);
	await expect(rows.nth(0)).toContainText("Vault 2");
	await expect(rows.nth(1)).toContainText("Vault 3");

	// Unlocks it with its own password, and waits for it to open.
	await selectVault(popup, /Vault 2/);
});

// #270: the unlock screen's "Choose a different vault" clears the choice. Deleting one of two then
// showed the last vault's unlock screen with no vault chosen, and its correct password failed.
test("deleting one of two vaults from the picker unlocks the one left", async ({
	context,
	extensionId,
}) => {
	for (let i = 0; i < 2; i++) await createVault(await context.newPage(), extensionId);

	const popup = await context.newPage();
	await openPopup(popup, extensionId);
	await lockToPicker(popup);
	await waitOutPickerClickGuard(popup);
	await selectVault(popup, /Vault 2/);
	await lockToPicker(popup);
	await waitOutPickerClickGuard(popup);

	await popup.getByRole("button", { name: "Delete a vault" }).click();
	await popup.getByRole("button", { name: "Delete Vault 2" }).click();
	await popup.getByLabel("Type Vault 2 to confirm").fill("Vault 2");
	await popup.getByRole("button", { name: "Delete vault", exact: true }).click();

	const pw = popup.locator('input[type="password"]').first();
	await expect(pw).toBeVisible();
	await pw.fill(STRONG_PW);
	await popup.getByRole("button", { name: "Unlock Vault" }).click();
	await expect(popup.getByRole("button", { name: "Lock vault", exact: true })).toBeVisible();
});
