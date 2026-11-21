import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DESKTOP_PW, desk, expect, test } from "./fixtures";
import { desktopCreateAnotherVault, desktopUseLocalRelay } from "./steps";

// The .bramble round trip in the desktop app alone: entries with passkeys go out through Export
// selection and come back into another vault. The desktop's crypto adapter is its own, so the
// extension's version of this (e2e/extension/bramble-export.spec.ts) says nothing about it: it
// once had no sealPortableVault, and Export selection failed with "Exporting a .bramble isn't
// available here."

const dir = path.dirname(fileURLToPath(import.meta.url));
const PASSKEY_FIXTURE = path.resolve(
	dir,
	"../../clients/extension/src/fixtures/imports/bitwarden-passkeys.json",
);
// Two more vaults on the relay are not what link.spec.ts expects to find.
test.use({ ownApp: true });

/** Not DESKTOP_PW, so a file sealed under the master password can't pass. */
const FILE_PW = "Br8-dsk-p0rt-Qk3-vT9";

/** Settings > Backups > Import, and `bytes` picked on the card titled `provider`. A .bramble has
 * its own row, "Import a backup"; every other format is under "Import from another manager". The
 * card's input is hidden and opens the system panel, so the file is set on it as a pick would set
 * it. */
async function desktopPickImportFile(provider: string, name: string, bytes: Buffer) {
	const row = provider === "Bramble (.bramble)" ? "Import a backup" : "Import from another manager";
	await desk(`
		await front();
		await click(/^Settings$/);
		await click(/^Backups$/);
		await click(new RegExp("^" + ${JSON.stringify(row)} + "$"));
		const card = await waitFor(() =>
			[...document.querySelectorAll("label")].find(
				(l) => l.querySelector("p")?.textContent === ${JSON.stringify(provider)},
			),
		).catch(missing(${JSON.stringify(provider)}));
		const input = card.querySelector('input[type="file"]');
		const picked = new DataTransfer();
		const bytes = Uint8Array.from(atob(${JSON.stringify(bytes.toString("base64"))}), (c) => c.charCodeAt(0));
		picked.items.add(new File([bytes], ${JSON.stringify(name)}));
		input.files = picked.files;
		input.dispatchEvent(new Event("change", { bubbles: true }));
	`);
}

/** Finish an import of `count` items and return to the list, with the passkey marker of each row
 * that has one. */
async function desktopFinishImport(count: number): Promise<string[]> {
	return desk<string[]>(`
		await click(/Import ${count} items/);
		await waitFor(() => /Imported ${count} items/.test(text()), 20000);
		await click(/^Done$/);
		await waitFor(() => /Items \\(${count}\\)/.test(text()));
		return [...document.querySelectorAll('[aria-label^="Holds "]')]
			.map((el) => el.getAttribute("aria-label"))
			.sort();
	`);
}

test("Export selection writes a .bramble that another vault opens, passkeys included", async ({
	desktop,
}) => {
	test.skip(process.platform !== "darwin", "macOS only");
	const id = Date.now().toString(36);
	// In the app's scratch HOME, which goes when it does.
	const out = path.join(desktop.home, "selection.bramble");
	await desktopCreateAnotherVault(`Export from ${id}`);
	await desktopUseLocalRelay();
	await desktopPickImportFile("Bitwarden", "bitwarden.json", readFileSync(PASSKEY_FIXTURE));
	const passkeys = await desktopFinishImport(7);
	expect(passkeys.length).toBeGreaterThan(0);

	// The save panel's answer is queued before it opens: e2e-dialog.ts stands in for it.
	const left = await desk<string | null>(`
		await front();
		(await import("/src/e2e-dialog.ts")).saveTo(${JSON.stringify(out)});
		await click(/^Select items$/);
		await click(/^Select all$/);
		await click(/^Actions$/);
		await click(/^Export selection$/, "[role=menuitem]");
		const dialog = await waitFor(() => document.querySelector("[role=dialog]"));
		for (const el of dialog.querySelectorAll('input[type="password"]')) {
			setValue(el, ${JSON.stringify(FILE_PW)});
		}
		[...dialog.querySelectorAll("button")].find((b) => b.textContent.trim() === "Export").click();
		// It closes once the file is written, and stays open saying why when it can't be.
		const closed = await waitFor(() => !document.querySelector("[role=dialog]"), 20000).catch(() => false);
		return closed ? null : document.querySelector("[role=dialog]").textContent;
	`);
	expect(left, "the export dialog stayed open").toBeNull();
	expect(existsSync(out)).toBe(true);
	expect(readFileSync(out).subarray(0, 4).toString("ascii")).toBe("VLT1");

	// Into an empty vault: the source vault would hold these back as entries it already has.
	await desktopCreateAnotherVault(`Import into ${id}`);
	await desktopUseLocalRelay();
	await desktopPickImportFile("Bramble (.bramble)", "selection.bramble", readFileSync(out));
	// The file has its own password, and a wrong one is an answer, not an error.
	await desk(`
		await fillPasswords(${JSON.stringify(DESKTOP_PW)});
		await click(/^Open database$/);
		await waitFor(() => /didn't open the file/.test(text()), 20000);
		await fillPasswords(${JSON.stringify(FILE_PW)});
		await click(/^Open database$/);
		await waitFor(() => find(/Import 7 items/), 20000);
	`);
	expect(await desktopFinishImport(7)).toEqual(passkeys);
});
