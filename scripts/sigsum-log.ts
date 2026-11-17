// Logging a desktop release's updater artifacts to Sigsum before anything is published, which the
// installed app requires before it will install an update (clients/desktop/src-tauri/src/update_log.rs).
// Each artifact gets a `<artifact>.proof` beside it: release-desktop.mjs copies the proofs into
// latest.json, and they are attached to the GitHub release. See docs/update-transparency.md.

import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { releaseIdentity } from "./age-yubikey-identity.ts";

/** The policy the app pins (the sigsum crate's built-in of the same name). */
export const SIGSUM_POLICY = "sigsum-generic-2025-1";
/** Where `_sigsum_v1.<domain>` holds the rate-limit key the logs check submissions against. */
export const SIGSUM_DOMAIN = "bramble.sh";
export const SIGSUM_SUBMIT_VERSION = "v0.14.1";

const WRAPPERS = join(homedir(), ".config/bramble");

/** What the updater downloads: the macOS archive, the AppImage, the Windows installer. */
export function isUpdaterArtifact(path: string): boolean {
	return [".app.tar.gz", ".AppImage", "-setup.exe"].some((suffix) => path.endsWith(suffix));
}

/** The two keys: from the environment in CI, else their age wrappers here (Touch ID or YubiKey). */
function keys(): { signing: string; rateLimit: string } {
	const fromEnv = {
		signing: process.env.SIGSUM_SIGNING_KEY ?? "",
		rateLimit: process.env.SIGSUM_RATE_LIMIT_KEY ?? "",
	};
	if (fromEnv.signing && fromEnv.rateLimit) return fromEnv;
	if (process.env.GITHUB_ACTIONS)
		throw new Error("SIGSUM_SIGNING_KEY and SIGSUM_RATE_LIMIT_KEY must be in desktop-release");
	const scratch = mkdtempSync(join(tmpdir(), "bramble-sigsum-id-"));
	try {
		const id = join(scratch, "id.txt");
		writeFileSync(id, releaseIdentity(), { mode: 0o600 });
		const open = (name: string) => {
			const file = join(WRAPPERS, name);
			if (!existsSync(file)) throw new Error(`no ${file}; see docs/update-transparency.md`);
			return execFileSync("age", ["-d", "-i", id, file], {
				encoding: "utf8",
				stdio: ["inherit", "pipe", "inherit"],
			});
		};
		return {
			signing: open("sigsum-signing-key.age"),
			rateLimit: open("sigsum-rate-limit-key.age"),
		};
	} finally {
		rmSync(scratch, { recursive: true, force: true });
	}
}

/**
 * Log `artifacts` and leave a proof beside each, or with `dryRun` only build the requests, which
 * proves the signing key works and logs nothing: a build that is never released must not appear in
 * the log, where monitors would rightly flag it.
 */
export function logToSigsum(artifacts: string[], dryRun: boolean): string[] {
	if (!artifacts.length) throw new Error("no updater artifacts to log");
	const { signing, rateLimit } = keys();
	const scratch = mkdtempSync(join(tmpdir(), "bramble-sigsum-"));
	// On any exit: these are the plaintext keys.
	const clear = () => rmSync(scratch, { recursive: true, force: true });
	process.once("exit", clear);
	try {
		const signingFile = join(scratch, "signing");
		const rateLimitFile = join(scratch, "rate-limit");
		writeFileSync(signingFile, signing, { mode: 0o600 });
		writeFileSync(rateLimitFile, rateLimit, { mode: 0o600 });
		if (dryRun) {
			execFileSync("sigsum-submit", ["-k", signingFile, "-O", scratch, ...artifacts], {
				stdio: "inherit",
			});
			console.log(
				`sigsum: ${artifacts.length} add-leaf request(s) signed; nothing logged (dry run)`,
			);
			return [];
		}
		// A proof left by an earlier build (Bramble.app.tar.gz has no version in its name) makes
		// sigsum-submit stop. Logging the same bytes again is harmless: the log keeps one leaf.
		for (const a of artifacts) rmSync(`${a}.proof`, { force: true });
		execFileSync(
			"sigsum-submit",
			[
				"-P",
				SIGSUM_POLICY,
				"-k",
				signingFile,
				"-a",
				rateLimitFile,
				"-d",
				SIGSUM_DOMAIN,
				...artifacts,
			],
			{ stdio: "inherit" },
		);
		const proofs = artifacts.map((a) => `${a}.proof`);
		for (const proof of proofs)
			if (!existsSync(proof)) throw new Error(`sigsum-submit left no ${proof}`);
		console.log(`sigsum: ${proofs.length} artifact(s) logged, proofs beside them`);
		return proofs;
	} finally {
		clear();
	}
}
