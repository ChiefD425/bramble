import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Page } from "@playwright/test";
import { lock, popupUrl, unlock } from "../extension/helpers";
import { openEntry } from "./entry-edits";
import {
	addLogin,
	createVault,
	enterCode,
	expect,
	gotoSync,
	invite,
	type Peer,
	PW,
	test,
	useLocalRelay,
} from "./fixtures";
import { MAILBOX, SYNCED, syncUntil, toList, useLocalMailbox } from "./mailbox-helpers";

// Two browsers that are never unlocked at the same time sync through the mailbox. Locking a
// browser stops its P2P sync, so nothing here can travel peer to peer: a login, its attachment
// and a login made on the other side all cross through the local mailbox server. See
// docs/mailbox-service.md.

type ExtPeer = Peer & { extensionId: string };

const NAME = "Mailbox courier";

let sources: string;
test.beforeAll(() => {
	sources = mkdtempSync(path.join(tmpdir(), "bramble-mailbox-"));
});
test.afterAll(() => rmSync(sources, { recursive: true, force: true }));

/** A popup on its own tab: the one that can attach. */
async function popup(peer: ExtPeer): Promise<Page> {
	const page = await peer.context.newPage();
	await page.goto(`${popupUrl(peer.extensionId)}?detached=1`);
	await expect(page.locator("#root")).not.toBeEmpty();
	return page;
}

test("two extensions that are never unlocked together sync through the mailbox", async ({
	ext,
	ext2,
}) => {
	// Pair the usual way, over P2P. A list popup on each side is opened first: a popup reopens on
	// its last screen, and these stay on the vault list.
	await createVault(ext.page);
	const a = await popup(ext);
	await expect(a.getByRole("button", { name: /Add New/i })).toBeVisible();
	await ext.page.goto(popupUrl(ext.extensionId));
	await gotoSync(ext.page);
	// Before pairing there's no group to make a mailbox for: the sign-in shows, disabled.
	await expect(ext.page.getByText("Connect a device to enable the mailbox.")).toBeVisible();
	await expect(ext.page.getByLabel("Account number")).toBeDisabled();
	await useLocalRelay(ext.page);
	const code = await invite(ext.page);
	await ext2.page.getByRole("button", { name: /Join a device/i }).click();
	await enterCode(ext2.page, code);
	await expect(ext.page.getByText(/Is this your device\?/i)).toBeVisible({ timeout: 90_000 });
	await ext.page.getByRole("button", { name: /They match, approve/i }).click();
	const b = await popup(ext2);
	await expect(b.getByRole("button", { name: /Add New/i })).toBeVisible({ timeout: 90_000 });

	// Switch the mailbox on in one browser; the setting reaches the other over P2P.
	await ext.page.goto(popupUrl(ext.extensionId));
	await gotoSync(ext.page);
	await useLocalMailbox(ext.page);

	await ext2.page.goto(popupUrl(ext2.extensionId));
	await gotoSync(ext2.page);
	await expect(ext2.page.getByText(MAILBOX)).toBeVisible({ timeout: 90_000 });
	await syncUntil(ext2.page, () => expect(ext2.page.getByText(SYNCED)).toBeVisible());
	// Once both are members, the first browser's next round answers the second's catch-up.
	await syncUntil(ext.page, () => expect(ext.page.getByText(SYNCED)).toBeVisible());

	// The second browser goes away; the first makes a login with an attachment and posts it.
	await lock(ext2.page);
	// The list popup was opened before the mailbox was switched on in the Sync tab, and an
	// extension view does not hear another view's writes: its next save would put back the
	// settings it last loaded, dropping the mailbox. Reload it first. (A known gap, not the
	// mailbox's: two open views can overwrite each other.)
	await a.reload();
	await toList(a);
	await addLogin(a, NAME);
	await openEntry(a, NAME);
	// Over 48 MiB: its download cannot come back as one message (Chrome caps those at 64 MiB).
	const file = path.join(sources, "scan.pdf");
	writeFileSync(file, Buffer.alloc(60 * 1024 * 1024, 7));
	await a.locator('input[type="file"]').setInputFiles(file);
	await expect(a.getByText("scan.pdf")).toBeVisible({ timeout: 60_000 });
	await syncUntil(ext.page, () => expect(ext.page.getByText(SYNCED)).toBeVisible());

	// Now the first goes away and the second comes back: only the mailbox has the login.
	await lock(ext.page);
	await unlock(ext2.page, PW);
	await ext2.page.goto(popupUrl(ext2.extensionId));
	await gotoSync(ext2.page);
	await syncUntil(ext2.page, async () => {
		await b.reload();
		await toList(b);
		await expect(b.getByText(NAME, { exact: true })).toBeVisible({ timeout: 2_000 });
	});
	// The bytes, not just the record: "Open attachment" is enabled only once the blob is held.
	await syncUntil(ext2.page, async () => {
		await b.reload();
		await toList(b);
		await openEntry(b, NAME);
		await expect(b.getByRole("button", { name: "Open attachment" })).toBeEnabled({
			timeout: 2_000,
		});
	});

	// And back: a login made on the second reaches the first through the mailbox too.
	await toList(b);
	await addLogin(b, "Made on the second");
	await syncUntil(ext2.page, () => expect(ext2.page.getByText(SYNCED)).toBeVisible());
	await lock(ext2.page);
	await unlock(ext.page, PW);
	await ext.page.goto(popupUrl(ext.extensionId));
	await gotoSync(ext.page);
	await syncUntil(ext.page, async () => {
		await a.reload();
		await toList(a);
		await expect(a.getByText("Made on the second", { exact: true })).toBeVisible({
			timeout: 2_000,
		});
	});
});
