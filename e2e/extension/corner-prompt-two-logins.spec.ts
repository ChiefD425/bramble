import type { Page } from "@playwright/test";
import { expect, test } from "./fixtures";
import {
	backgroundWorker,
	clickCornerAction,
	clickCornerElement,
	cornerHas,
	cornerText,
	createVault,
	lock,
	openPopup,
	unlock,
} from "./helpers";

// Two accounts on one site, and a password changed on a page with no username field (Proton's
// is one). The update card used to pre-select the first login, so one click wrote the new
// password into the other account's login.

const PROMPT = "#bramble-corner-prompt";
const CHANGE = `<!doctype html><html><head><title>change password</title></head><body>
	<form id="change">
		<input id="cur" name="current-password" type="password" autocomplete="current-password" />
		<input id="new" name="new-password" type="password" autocomplete="new-password" />
		<input id="confirm" name="confirm-password" type="password" autocomplete="new-password" />
		<button type="submit">Change password</button>
	</form>
	<script>
		document.getElementById('change').addEventListener('submit', function (e) {
			e.preventDefault();
			setTimeout(function () { document.getElementById('change').remove(); }, 100);
		});
	</script>
</body></html>`;

async function addLogin(popup: Page, name: string, username: string, password: string) {
	await popup.getByRole("button", { name: /Add New/i }).click();
	await popup.getByRole("button", { name: /Add a new login/i }).click();
	await popup.getByLabel("Name", { exact: true }).fill(name);
	await popup.getByRole("button", { name: /Add URL/i }).click();
	await popup.getByLabel("Website URL", { exact: true }).fill("https://example.com");
	await popup.getByLabel("Username or email", { exact: true }).fill(username);
	await popup.getByLabel("Password", { exact: true }).fill(password);
	await popup.getByRole("button", { name: /Save Login/i }).click();
	await expect(popup.getByText(name, { exact: true })).toBeVisible();
}

async function changePassword(page: Page, from: string, to: string) {
	await page
		.context()
		.route(/example\.com/, (route) =>
			route.request().resourceType() === "document"
				? route.fulfill({ body: CHANGE, headers: { "content-type": "text/html" } })
				: route.fulfill({ status: 200, body: "" }),
		);
	await page.goto("https://example.com/account/password");
	await page.locator("#cur").fill(from);
	await page.locator("#new").fill(to);
	await page.locator("#confirm").fill(to);
	await page.getByRole("button", { name: "Change password" }).click();
	await expect(page.locator(PROMPT)).toBeVisible({ timeout: 10_000 });
}

/** Pick the card's login for `username`. */
async function pick(page: Page, username: string) {
	for (const n of [1, 2]) {
		if ((await cornerText(page, `.tp-candidate:nth-child(${n}) .tp-cand-user`)) === username) {
			await clickCornerElement(page, `.tp-candidate:nth-child(${n}) input`);
			return;
		}
	}
	throw new Error(`no ${username} on the card`);
}

async function passwordOf(popup: Page, name: string): Promise<string> {
	await popup.getByText(name, { exact: true }).click();
	await popup.getByRole("button", { name: "Show password" }).click();
	const text = await popup.locator("#root").innerText();
	await popup.getByRole("button", { name: "Go back" }).click();
	return text;
}

async function twoAccounts(page: Page, extensionId: string) {
	await createVault(page, extensionId);
	await openPopup(page, extensionId);
	await addLogin(page, "Org account", "org@example.com", "Org-Acct-Pw-1");
	await addLogin(page, "Family account", "family@example.com", "Family-Old-Pw-1");
}

test("the update card picks no login for the user, and updates the one they pick", async ({
	context,
	extensionId,
}) => {
	const popup = await context.newPage();
	await twoAccounts(popup, extensionId);

	const page = await context.newPage();
	await changePassword(page, "Family-Old-Pw-1", "Family-New-Pw-2");

	expect(await cornerHas(page, 'input[name="tp-update-target"]:checked')).toBe(false);
	expect(await cornerHas(page, '[data-tp-action="update"]:disabled')).toBe(true);
	await clickCornerAction(page, "update");
	await expect(page.locator(PROMPT)).toBeAttached();

	await pick(page, "family@example.com");
	expect(await cornerHas(page, '[data-tp-action="update"]:disabled')).toBe(false);
	await clickCornerAction(page, "update");
	await expect(page.locator(PROMPT)).toHaveCount(0);

	await openPopup(popup, extensionId);
	const family = await passwordOf(popup, "Family account");
	expect(family).toContain("Family-New-Pw-2");
	const org = await passwordOf(popup, "Org account");
	expect(org).toContain("Org-Acct-Pw-1");
	expect(org).not.toContain("Family-New-Pw-2");
});

// Locked, the card can't see which logins match, so it offers a save. After the unlock it used to
// fold that save into the first matching login.
test("saving while locked overwrites neither login", async ({ context, extensionId }) => {
	const popup = await context.newPage();
	await twoAccounts(popup, extensionId);
	await lock(popup);

	const page = await context.newPage();
	await changePassword(page, "Family-Old-Pw-1", "Family-New-Pw-2");
	await clickCornerAction(page, "save-unlock-first");
	// The capture is parked for the unlock to pick up.
	await expect
		.poll(
			async () =>
				(await backgroundWorker(context)).evaluate(async () => {
					const r = await chrome.storage.session.get("cornerPrompt.handoff");
					return !!r["cornerPrompt.handoff"];
				}),
			{ timeout: 10_000 },
		)
		.toBe(true);

	await popup.bringToFront();
	await unlock(popup);
	await expect(popup.getByText("Items (3)")).toBeVisible({ timeout: 10_000 });
	expect(await passwordOf(popup, "example.com")).toContain("Family-New-Pw-2");
	expect(await passwordOf(popup, "Family account")).toContain("Family-Old-Pw-1");
	expect(await passwordOf(popup, "Org account")).toContain("Org-Acct-Pw-1");
});
