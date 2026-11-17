// The throwaway Sigsum key the local-update test build trusts, shared by the build
// (build-macos.ts makes it) and `pnpm updater:smoke` (which logs the archive it serves with it).
// See docs/update-transparency.md.

import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export const SMOKE_SIGSUM_KEY = join(ROOT, "clients/desktop/src-tauri/target/smoke-sigsum-key");

/** The Ed25519 key in an OpenSSH public key line, as hex. */
export function sshEd25519Hex(pubLine: string): string {
	const blob = Buffer.from(pubLine.trim().split(/\s+/)[1] ?? "", "base64");
	if (blob.length !== 51 || !blob.subarray(4, 15).equals(Buffer.from("ssh-ed25519")))
		throw new Error("not an ssh-ed25519 public key");
	return blob.subarray(19).toString("hex");
}
