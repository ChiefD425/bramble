import type { Page } from "@playwright/test";
import { lock, popupUrl, unlock } from "../extension/helpers";
import { addLogin, expect, gotoSync, PW, pairWithPhone, test } from "./fixtures";
import {
	MAILBOX,
	mailboxRound,
	SYNCED,
	syncUntil,
	toList,
	useLocalMailbox,
} from "./mailbox-helpers";

// The extension and the mobile app (its web build) sync through the mailbox while never unlocked
// together. Locking stops a device's P2P sync, so a login can only cross through the local
// mailbox server. Entries only: the web build has no native file crypto, so attachments through
// the mailbox are covered by unit tests and the device check. See docs/mailbox-service.md.

const FROM_LAPTOP = "Mailbox courier";
const FROM_PHONE = "Made on the phone";

/** On the phone, which has one page: press the mailbox's "Sync now" in Settings until the list shows `name`. */
async function phoneSyncUntilListed(phone: Page, name: string): Promise<void> {
	await expect(async () => {
		await toList(phone);
		await gotoSync(phone);
		await mailboxRound(phone);
		await toList(phone);
		await expect(phone.getByText(name, { exact: true })).toBeVisible({ timeout: 2_000 });
	}).toPass({ timeout: 90_000 });
}

test("the extension and the mobile app sync through the mailbox when never unlocked together", async ({
	ext,
	mobile,
}) => {
	const list = await pairWithPhone(ext, mobile);

	// Switch the mailbox on in the extension; the setting reaches the phone over P2P.
	await ext.page.goto(popupUrl(ext.extensionId));
	await gotoSync(ext.page);
	await useLocalMailbox(ext.page);
	await gotoSync(mobile.page);
	await expect(mobile.page.getByText(MAILBOX)).toBeVisible({ timeout: 90_000 });
	await syncUntil(mobile.page, () => expect(mobile.page.getByText(SYNCED)).toBeVisible());
	// Once both are members, the extension's next round answers the phone's catch-up.
	await syncUntil(ext.page, () => expect(ext.page.getByText(SYNCED)).toBeVisible());

	// The phone goes away; the extension makes a login and posts it.
	await toList(mobile.page);
	await lock(mobile.page);
	// The list was loaded before the mailbox was switched on; reload it so its save keeps that.
	await list.reload();
	await toList(list);
	await addLogin(list, FROM_LAPTOP);
	await syncUntil(ext.page, () => expect(ext.page.getByText(SYNCED)).toBeVisible());

	// Now the extension goes away and the phone comes back: only the mailbox has the login.
	await lock(ext.page);
	await unlock(mobile.page, PW);
	await phoneSyncUntilListed(mobile.page, FROM_LAPTOP);

	// And back: a login made on the phone reaches the extension through the mailbox too.
	await addLogin(mobile.page, FROM_PHONE);
	await gotoSync(mobile.page);
	await syncUntil(mobile.page, () => expect(mobile.page.getByText(SYNCED)).toBeVisible());
	await toList(mobile.page);
	await lock(mobile.page);
	await unlock(ext.page, PW);
	await ext.page.goto(popupUrl(ext.extensionId));
	await gotoSync(ext.page);
	await syncUntil(ext.page, async () => {
		await list.reload();
		await toList(list);
		await expect(list.getByText(FROM_PHONE, { exact: true })).toBeVisible({ timeout: 2_000 });
	});
});
