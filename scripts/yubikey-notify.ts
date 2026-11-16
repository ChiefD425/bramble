// Best-effort macOS banner (with sound) fired right before an `age` decrypt that needs a
// YubiKey PIN + touch, so the short touch window isn't missed while you're looking away.
// No-op off macOS, and never throws: a failed notification must never break a release.
// See docs/release-signing.md.

import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { SE_IDENTITY } from "./age-yubikey-identity.ts";

/** `touchIdToo`: the secret is read through releaseIdentity, so Touch ID may answer instead. */
export function notifyYubiKeyTouch(reason: string, touchIdToo = false): void {
	if (process.platform !== "darwin") return;
	const ask =
		touchIdToo && existsSync(SE_IDENTITY)
			? "Approve with Touch ID (or touch your YubiKey)"
			: "Touch your YubiKey";
	// Strip quotes/backslashes so the reason can't break the AppleScript string literal.
	const body = `${ask} to ${reason}.`.replace(/["\\]/g, "");
	try {
		execFileSync(
			"osascript",
			[
				"-e",
				`display notification "${body}" with title "Bramble release" subtitle "YubiKey" sound name "Submarine"`,
			],
			{ stdio: "ignore" },
		);
	} catch {
		// notifications are non-essential; ignore any failure.
	}
}
