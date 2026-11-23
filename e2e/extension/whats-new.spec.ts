import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "./fixtures";
import { addLogin, backgroundWorker, createVault, openPopup } from "./helpers";

// The What's new card in the real build (docs/whats-new.md): the notes bundled for the manifest's
// version, a fresh install that never sees them, Read more, and one card per popup open.

const dir = path.dirname(fileURLToPath(import.meta.url));
const notes = readFileSync(
	path.join(dir, "../../packages/core/src/app/release-notes/en/chromium.md"),
	"utf8",
);
const notesVersion = notes.match(/^version:\s*(\S+)/m)?.[1];
const firstItem = notes.match(/^- (.+)$/m)?.[1];

test("an update shows what's new once, and the next card waits for the next open", async ({
	context,
	extensionId,
}) => {
	const page = await context.newPage();
	await createVault(page, extensionId);
	const sw = await backgroundWorker(context);
	const version = await sw.evaluate(() => chrome.runtime.getManifest().version);
	const seen = () => sw.evaluate(() => chrome.storage.local.get("pref.whatsNew"));

	// A fresh install starts on its own version, so it is never told what changed since one it
	// never had.
	expect(await seen()).toEqual({ "pref.whatsNew": { seen: version } });
	const first = await context.newPage();
	await openPopup(first, extensionId);
	for (const name of ["Codeberg", "Mastodon", "Proton Mail"]) await addLogin(first, name);
	await expect(first.getByText(/What's new in/)).toHaveCount(0);
	await first.close();

	test.skip(
		notesVersion !== version,
		`the committed notes are for ${notesVersion}, the build is ${version}: the next release's notes landed before its version bump`,
	);

	// The update: the card was last closed on an older version, and the review ask is due too.
	await sw.evaluate(() =>
		chrome.storage.local.set({
			"pref.whatsNew": { seen: "1.0.0" },
			"pref.reviewNudge": {
				installedAt: Date.now() - 30 * 86_400_000,
				sessions: 20,
				asks: 0,
				rated: false,
			},
		}),
	);
	const popup = await context.newPage();
	await openPopup(popup, extensionId);
	await expect(popup.getByText(`What's new in ${version}`)).toBeVisible();
	await expect(popup.getByText(/Say something nice/)).toHaveCount(0);

	await popup.getByRole("button", { name: /^Show \d+ changes?$/ }).click();
	await expect(popup.getByText(firstItem as string)).toBeVisible();

	await context.route("https://bramble.sh/**", (route) => route.fulfill({ status: 200, body: "" }));
	const [tab] = await Promise.all([
		context.waitForEvent("page"),
		popup.getByRole("link", { name: /Read more/ }).click(),
	]);
	expect(tab.url()).toBe(`https://bramble.sh/whats-new/chromium/${version}`);

	// Read more ends it, and the review ask waits for the next open rather than taking the spot.
	await expect(popup.getByText(/What's new in/)).toHaveCount(0);
	await expect(popup.getByText(/Say something nice/)).toHaveCount(0);
	expect(await seen()).toEqual({ "pref.whatsNew": { seen: version } });
	await popup.close();

	const next = await context.newPage();
	await openPopup(next, extensionId);
	await expect(next.getByText(/Say something nice/)).toBeVisible();
	await expect(next.getByText(/What's new in/)).toHaveCount(0);
});
