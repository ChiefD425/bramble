import type { BrowserContext, Page, Worker } from "@playwright/test";
import { expect, test } from "./fixtures";
import { backgroundWorker, createVault, openPopup } from "./helpers";

// The every-two-weeks donation card in the real build (docs/support-ask.md): nothing on a fresh
// install, the card once due, dismissing it, Donate to bramble.sh/donate, and the Settings switch.

const DAY = 24 * 60 * 60 * 1000;

async function makeDue(sw: Worker) {
	await sw.evaluate(
		(startedAt) => chrome.storage.local.set({ "pref.supportAsk": { startedAt } }),
		Date.now() - 15 * DAY,
	);
}

async function open(context: BrowserContext, extensionId: string): Promise<Page> {
	const popup = await context.newPage();
	await openPopup(popup, extensionId);
	await expect(popup.getByRole("button", { name: "Lock vault", exact: true })).toBeVisible();
	return popup;
}

const card = (page: Page) => page.getByText("Support Bramble", { exact: true });

test("asks once every two weeks, from the vault list", async ({ context, extensionId }) => {
	await createVault(await context.newPage(), extensionId);
	const sw = await backgroundWorker(context);
	const stored = async () =>
		(await sw.evaluate(() => chrome.storage.local.get("pref.supportAsk")))["pref.supportAsk"] as {
			startedAt: number;
			askedAt?: number;
			donatedAt?: number;
		};

	// A fresh install starts the clock and asks nothing.
	const first = await open(context, extensionId);
	await expect(card(first)).toHaveCount(0);
	expect(Date.now() - (await stored()).startedAt).toBeLessThan(60_000);
	await first.close();

	// Two weeks on: the card, counted as asked as soon as it shows.
	await makeDue(sw);
	const due = await open(context, extensionId);
	await expect(card(due)).toBeVisible();
	await expect.poll(async () => (await stored()).askedAt).toBeDefined();
	await due.getByRole("button", { name: "Dismiss" }).click();
	await expect(card(due)).toHaveCount(0);
	await due.close();

	const next = await open(context, extensionId);
	await expect(card(next)).toHaveCount(0);
	await next.close();

	// Donate opens the website's donate page and records it.
	await makeDue(sw);
	await context.route("https://bramble.sh/**", (route) => route.fulfill({ status: 200, body: "" }));
	const donating = await open(context, extensionId);
	const [tab] = await Promise.all([
		context.waitForEvent("page"),
		donating.getByRole("link", { name: /Donate/ }).click(),
	]);
	expect(tab.url()).toBe("https://bramble.sh/donate");
	await expect(card(donating)).toHaveCount(0);
	await expect.poll(async () => (await stored()).donatedAt).toBeDefined();
	await donating.close();

	// Switched off in Settings, a due ask never shows.
	await makeDue(sw);
	const settings = await open(context, extensionId);
	await settings.getByRole("button", { name: "Dismiss" }).click();
	await settings.getByRole("button", { name: "Settings" }).click();
	await settings.getByRole("button", { name: "About", exact: true }).click();
	await settings.getByRole("button", { name: "Remind me every two weeks" }).click();
	await expect(settings.getByRole("button", { name: "Remind me every two weeks" })).toHaveAttribute(
		"aria-pressed",
		"false",
	);
	await settings.close();
	await makeDue(sw);
	const off = await open(context, extensionId);
	// The popup reopens where it was left, Settings here.
	await off.getByRole("button", { name: "Go to vault" }).click();
	await expect(off.getByText(/Items \(/)).toBeVisible();
	await expect(card(off)).toHaveCount(0);
});
