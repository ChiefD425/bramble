// node --test scripts/windows-sign-handoff.test.ts

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { hasAuthenticode } from "./pe-normalize.ts";
import { sign, unsigned } from "./pe-test-fixtures.ts";
import { contentKey, handOff, isInstaller } from "./windows-sign-handoff.ts";

const root = mkdtempSync(join(tmpdir(), "sign-handoff-"));
after(() => rmSync(root, { recursive: true, force: true }));

let n = 0;
function dir(): string {
	const d = join(root, String(n++));
	mkdirSync(d, { recursive: true });
	return d;
}

describe("handOff", () => {
	it("collects a file, then swaps in its signed copy on the next build", () => {
		const build = dir();
		const collect = dir();
		const app = join(build, "bramble-desktop.exe");
		writeFileSync(app, unsigned(0x403, 3));
		assert.equal(handOff(app, { collect }), "collected");
		const [name] = readdirSync(collect);
		assert.equal(name, `${contentKey(unsigned(0x403, 3))}.exe`);
		assert.equal(hasAuthenticode(readFileSync(app)), false, "collecting leaves the file alone");

		// The signing round, then the same bytes rebuilt.
		const signed = dir();
		writeFileSync(join(signed, name as string), sign(readFileSync(join(collect, name as string))));
		writeFileSync(app, unsigned(0x403, 3));
		assert.equal(handOff(app, { signed }), "signed");
		assert.equal(hasAuthenticode(readFileSync(app)), true);
	});

	it("finds a signed copy by its bytes, whatever it is called or wherever it is", () => {
		const build = dir();
		const signed = dir();
		mkdirSync(join(signed, "$PLUGINSDIR"));
		writeFileSync(join(signed, "$PLUGINSDIR", "System.dll"), sign(unsigned(0x400, 5)));
		writeFileSync(join(signed, "readme.txt"), "not a PE file");
		writeFileSync(join(signed, "plain.exe"), unsigned(0x400, 5)); // unsigned: no help
		const dll = join(build, "System.dll");
		writeFileSync(dll, unsigned(0x400, 5));
		assert.equal(handOff(dll, { signed }), "signed");
		assert.equal(hasAuthenticode(readFileSync(dll)), true);
	});

	it("collects what has no signed copy yet, and gives a file makensis names .tmp an .exe", () => {
		const build = dir();
		const signed = dir();
		const collect = dir();
		writeFileSync(join(signed, "a.exe"), sign(unsigned(0x400, 3)));
		const uninstaller = join(build, "nst42.tmp");
		writeFileSync(uninstaller, unsigned(0x400, 9));
		assert.equal(handOff(uninstaller, { signed, collect }), "collected");
		assert.deepEqual(readdirSync(collect), [`${contentKey(unsigned(0x400, 9))}.exe`]);
	});

	it("fails on a file with no signed copy unless told to keep it", () => {
		const build = dir();
		const signed = dir();
		writeFileSync(join(signed, "a.exe"), sign(unsigned(0x400, 3)));
		const app = join(build, "bramble-desktop.exe");
		writeFileSync(app, unsigned(0x400, 4)); // not what was signed
		assert.throws(() => handOff(app, { signed }), /no signed copy/);
		assert.equal(handOff(app, { signed, lenient: true }), "kept");
		assert.equal(hasAuthenticode(readFileSync(app)), false);
	});

	it("leaves the installer for the last signature", () => {
		const nsis = join(dir(), "bundle", "nsis");
		mkdirSync(nsis, { recursive: true });
		const installer = join(nsis, "Bramble_0.22.0_x64-setup.exe");
		writeFileSync(installer, unsigned(0x400));
		assert.equal(isInstaller(installer), true);
		assert.equal(handOff(installer, {}), "installer");
		assert.equal(isInstaller(join(nsis, "bramble-desktop.exe")), false);
	});
});

describe("the command Tauri runs", () => {
	const script = join(import.meta.dirname, "windows-sign-handoff.ts");
	const run = (args: string[], env: Record<string, string>) =>
		execFileSync(process.execPath, [script, ...args], {
			encoding: "utf8",
			env: { PATH: process.env.PATH ?? "", ...env },
			stdio: ["ignore", "pipe", "pipe"],
		});

	it("reports what it did, and refuses to run unconfigured", () => {
		const build = dir();
		const collect = dir();
		const app = join(build, "bramble-proxy.exe");
		writeFileSync(app, unsigned(0x400, 11));
		assert.match(run([app], { BRAMBLE_SIGN_COLLECT: collect }), /collected: bramble-proxy\.exe/);
		assert.throws(() => run([app], {}), /BRAMBLE_SIGN_SIGNED/);
	});
});
