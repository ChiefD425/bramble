import type { BrowserContext, Page } from "@playwright/test";
import { expect, test } from "./fixtures";
import { createVault, expectUnlocked, popupUrl } from "./helpers";

// Two open views of one vault, each saving from its own copy: neither may undo the other
// (docs/mailbox-service.md).

async function openView(context: BrowserContext, extensionId: string): Promise<Page> {
	const view = await context.newPage();
	await view.goto(popupUrl(extensionId));
	await expect(view.locator("#root")).not.toBeEmpty();
	await expectUnlocked(view);
	return view;
}

async function addLogin(view: Page, name: string) {
	await view.getByRole("button", { name: /Add New/i }).click();
	await view.getByRole("button", { name: /Add a new login/i }).click();
	await view.getByLabel("Name", { exact: true }).fill(name);
	await view.getByLabel("Username or email", { exact: true }).fill("alice@example.com");
	await view.getByLabel("Password", { exact: true }).fill("s3cr3t-pw-01");
	await view.getByRole("button", { name: /Save Login/i }).click();
	await expect(view.getByText(name)).toBeVisible();
}

test("two open views never undo each other", async ({ context, extensionId }) => {
	await createVault(await context.newPage(), extensionId);
	const one = await openView(context, extensionId);
	const two = await openView(context, extensionId);
	await addLogin(one, "From tab one");
	// Tab two never reloads before its own save: it starts from a copy without tab one's login.
	await addLogin(two, "From tab two");
	await expect(two.getByText("From tab one")).toBeVisible();
	await expect(one.getByText("From tab two")).toBeVisible();
	const fresh = await openView(context, extensionId);
	await expect(fresh.getByText("From tab one")).toBeVisible();
	await expect(fresh.getByText("From tab two")).toBeVisible();
});
