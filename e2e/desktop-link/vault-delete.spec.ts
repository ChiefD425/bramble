import { DESKTOP_PW, desk, expect, test } from "./fixtures";
import { desktopCreateAnotherVault } from "./steps";

// #261: on the desktop, deleted vaults stayed in the list to unlock. Delete one through Settings,
// as a person does, and the registry and the picker must both lose it.
test.use({ ownApp: true });

/** The ids and labels the desktop's registry lists, read the way the app reads it. */
const registry = () =>
	desk<{ id: string; label: string }[]>(`
		const { desktopStorage } = await import("/src/adapters/storage.ts");
		const reg = await desktopStorage.getMeta("vault.registry");
		return (reg?.vaults ?? []).map((v) => ({ id: v.id, label: v.label }));
	`);

test("a vault deleted in Settings leaves the list (#261)", async ({ desktop }) => {
	void desktop;
	await desktopCreateAnotherVault("Doomed");
	expect((await registry()).map((v) => v.label)).toContain("Doomed");

	await desk(`
		await front();
		await click(/^Settings$/);
		await click(/^General$/);
		await click(/^Delete this vault$/);
		await fillPasswords(${JSON.stringify(DESKTOP_PW)});
		await click(/^Delete this vault$/, "button[type=submit]");
	`);

	await expect
		.poll(async () => (await registry()).map((v) => v.label), { timeout: 15_000 })
		.not.toContain("Doomed");
	const picker = await desk<string>(`
		await front();
		await waitFor(() => /Choose a vault to unlock|Enter your master password/.test(text()), 10000);
		if (find(/^Choose a different vault$/)) await click(/^Choose a different vault$/);
		return text();
	`);
	expect(picker).not.toContain("Doomed");
});

test("a closed vault is deleted from the unlock screen, by name, without opening it", async ({
	desktop,
}) => {
	void desktop;
	await desktopCreateAnotherVault("Leftover");
	await desktopCreateAnotherVault("Spare");

	await desk(`
		await front();
		await click(/^Lock vault$/);
		await waitFor(() => find(/^Choose a different vault$/) || /Choose a vault to unlock/.test(text()));
		if (find(/^Choose a different vault$/)) await click(/^Choose a different vault$/);
	`);
	await desk(`
		await front();
		await click(/^Delete a vault$/);
		await click(/^Delete Leftover$/);
	`);
	await desk(`
		await front();
		await fillLabel(/^Type Leftover to confirm$/, "Leftover");
		await click(/^Delete vault$/, "button[type=submit]");
	`);

	await expect
		.poll(async () => (await registry()).map((v) => v.label), { timeout: 15_000 })
		.not.toContain("Leftover");
	expect((await registry()).map((v) => v.label)).toContain("Spare");
});
