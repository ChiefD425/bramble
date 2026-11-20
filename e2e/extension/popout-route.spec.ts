import type { BrowserContext, Page } from "@playwright/test";
import { expect, test } from "./fixtures";
import { gotoBackups, openExampleLogin, openPopup } from "./helpers";

// "Open in window" shows the screen the popup was on, even when a pop-out is already open
// somewhere: the pop-out is reused, but it moves to that screen rather than staying where it was.

const detached = (context: BrowserContext) =>
	context.pages().filter((p) => !p.isClosed() && p.url().includes("detached=1"));

async function popOut(context: BrowserContext, popup: Page, windows: number): Promise<Page> {
	await popup.getByRole("button", { name: "Open in window" }).click();
	await expect.poll(() => detached(context).length, { timeout: 20_000 }).toBe(windows);
	return detached(context).at(-1)!;
}

test("popping out Settings > Backups shows Backups in the pop-out already open on an entry", async ({
	context,
	extensionId,
}) => {
	const popup = await openExampleLogin(context, extensionId);
	const first = await popOut(context, popup, 1);
	await expect(first.getByRole("button", { name: "Edit entry" })).toBeVisible();

	const again = await context.newPage();
	await openPopup(again, extensionId);
	await gotoBackups(again);
	const shown = await popOut(context, again, 1);

	expect(shown).toBe(first);
	await expect(first.getByRole("heading", { name: "Cloud backups" })).toBeVisible();
});

test("a pop-out holding an unsaved edit keeps it, and Backups opens in a new window", async ({
	context,
	extensionId,
}) => {
	const popup = await openExampleLogin(context, extensionId);
	const first = await popOut(context, popup, 1);
	await first.getByRole("button", { name: "Edit entry" }).click();
	await first.getByLabel("Name", { exact: true }).fill("Half-typed name");

	const again = await context.newPage();
	await openPopup(again, extensionId);
	await gotoBackups(again);
	const second = await popOut(context, again, 2);

	await expect(second.getByRole("heading", { name: "Cloud backups" })).toBeVisible();
	await expect(first.getByLabel("Name", { exact: true })).toHaveValue("Half-typed name");
});
