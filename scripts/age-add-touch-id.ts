#!/usr/bin/env node
// Let Touch ID open a release secret as well as the YubiKey: re-wrap the .age file to both
// recipients. Costs one last YubiKey PIN + touch per file, then one Touch ID to prove the new
// file opens before it replaces the old one. The plaintext stays in memory. The YubiKey-only
// original is kept beside it as <file>.yubikey-only. See docs/release-signing.md.
//
//   pnpm keys:touch-id                       # the desktop updater key
//   pnpm keys:touch-id ~/.config/bramble/asc-api-key.age ...

import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	releaseIdentity,
	SE_IDENTITY,
	touchIdIdentity,
	touchIdRecipient,
	yubiKeyRecipient,
} from "./age-yubikey-identity.ts";
import { KEY_AGE } from "./desktop-signing-key.ts";
import { notifyYubiKeyTouch } from "./yubikey-notify.ts";

const fail = (message: string): never => {
	console.error(message);
	process.exit(1);
};

const touchId = touchIdRecipient();
if (!touchId)
	fail(
		`no Touch ID identity at ${SE_IDENTITY}. Create it once with:\n` +
			`  brew install age-plugin-se && age-plugin-se keygen --access-control any-biometry -o ${SE_IDENTITY}`,
	);
let yubiKey = "";
try {
	yubiKey = yubiKeyRecipient();
} catch (e) {
	fail(
		`${(e as Error).message}\nRe-wrapping needs the YubiKey this once, to open the current file.`,
	);
}
const files = process.argv.slice(2).length ? process.argv.slice(2) : [KEY_AGE];

const tmp = mkdtempSync(join(tmpdir(), "bramble-touchid-"));
try {
	const both = join(tmp, "both.txt");
	const touchOnly = join(tmp, "touch-id.txt");
	writeFileSync(both, releaseIdentity(), { mode: 0o600 });
	writeFileSync(touchOnly, touchIdIdentity() ?? "", { mode: 0o600 });

	for (const file of files) {
		if (!existsSync(file)) fail(`no ${file}`);
		notifyYubiKeyTouch(`re-wrap ${file} for Touch ID`);
		const plaintext = execFileSync("age", ["-d", "-i", both, file], {
			stdio: ["inherit", "pipe", "inherit"],
			maxBuffer: 1 << 24,
		});
		const next = `${file}.touchid.tmp`;
		execFileSync("age", ["-e", "-r", yubiKey, "-r", touchId as string, "-o", next], {
			input: plaintext,
		});
		// age -o follows the umask (0644 here); the originals are owner-only.
		chmodSync(next, 0o600);
		console.error(`Approve with Touch ID to check ${next} opens.`);
		const check = execFileSync("age", ["-d", "-i", touchOnly, next], {
			stdio: ["ignore", "pipe", "inherit"],
			maxBuffer: 1 << 24,
		});
		const same = check.equals(plaintext);
		plaintext.fill(0);
		check.fill(0);
		if (!same) {
			rmSync(next, { force: true });
			fail(`${next} did not open to the same secret; ${file} is unchanged.`);
		}
		renameSync(file, `${file}.yubikey-only`);
		renameSync(next, file);
		console.error(`${file}: opens with Touch ID or the YubiKey (old copy: ${file}.yubikey-only)`);
	}
} finally {
	rmSync(tmp, { recursive: true, force: true });
}
