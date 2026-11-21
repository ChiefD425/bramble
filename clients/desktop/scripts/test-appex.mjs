/*
 * The AutoFill extension's pure Swift, tested without Xcode: compile it with its checks into a
 * throwaway binary and run it. macOS only; the extension does not exist elsewhere.
 */

import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

if (process.platform !== "darwin") {
	console.log("test:appex: macOS only, skipped");
	process.exit(0);
}

const src = join(dirname(fileURLToPath(import.meta.url)), "..", "macos", "BrambleAutoFill");
const out = mkdtempSync(join(tmpdir(), "bramble-appex-test-"));
try {
	const bin = join(out, "vault-copies-tests");
	execFileSync(
		"swiftc",
		["-parse-as-library", "-o", bin, join(src, "VaultCopies.swift"), join(src, "Tests", "VaultCopiesTests.swift")],
		{ stdio: "inherit" },
	);
	execFileSync(bin, { stdio: "inherit" });
} finally {
	rmSync(out, { recursive: true, force: true });
}
