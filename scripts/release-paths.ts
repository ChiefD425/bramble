// Which files each release ships, and which of them are security-sensitive. Release notes are
// narrowed to the first; every GitHub release page lists the commits that touched the second
// (scripts/release-evidence.ts, docs/ci-releases.md).

// What each target actually ships, as git pathspecs. A commit belongs to a release only if it
// touched one of these, so the notes describe THAT target rather than everything that happened in
// the range. Shared paths are deliberately in every list: a core fix ships in all five, and it
// should be listed in all five rather than attributed to whichever one released first.
//
// Paths decide what a release INCLUDES, and never the commit scope: a `feat(desktop):` that only
// touches scripts/ or website/ is real work but not shipped code, and guessing from a scope that
// nothing enforces would put commits in the wrong release. Silently dropping a few is the cheaper
// mistake. Scope only ever subtracts, in PLATFORM_SCOPES in release.ts.
export const SHARED_PATHS = ["packages/core", "packages/core-rust", "packages/theme"];
export const PLATFORM_PATHS: Record<string, string[]> = {
	chromium: ["clients/extension", "packages/manifests/chromium"],
	firefox: ["clients/extension", "packages/manifests/firefox"],
	desktop: ["clients/desktop"],
	// One mobile package builds both, so each excludes the other's native half and keeps the
	// shared src/. Order matters to git: the exclude has to follow what it subtracts from.
	ios: ["clients/mobile", ":(exclude)clients/mobile/android"],
	android: ["clients/mobile", ":(exclude)clients/mobile/ios"],
};

/**
 * Code where a mistake can expose a secret, weaken a lock, or let a page, a peer or an update in.
 * A path is a file or a directory; `*` matches within one path segment. Tests and docs under these
 * paths are not shipped and never count.
 */
export const SECURITY_PATHS: { path: string; why: string }[] = [
	// Every app
	{ path: "packages/core-rust", why: "cryptography: key derivation, encryption, signatures" },
	{ path: "packages/core/src/vault-format.ts", why: "the encrypted vault format" },
	{ path: "packages/core/src/vault", why: "vault storage, key slots, recovery codes, passkeys" },
	{ path: "packages/core/src/sync", why: "sync, pairing and device rosters" },
	{ path: "packages/core/src/backup", why: "encrypted backups and cloud credentials" },
	{ path: "packages/core/src/exchange", why: "credential import and export between apps" },
	{ path: "packages/core/src/export", why: "vault exports" },
	{ path: "packages/core/src/adapters", why: "what the shared code asks of each app's shell" },
	{ path: "packages/core/src/util/pwned.ts", why: "what breach checks send" },
	{ path: "packages/core/src/flags.json", why: "security switches shared by every app" },
	{ path: "packages/core/src/app/screens/Auth", why: "unlock and lock" },
	{ path: "packages/core/src/app/hooks/useWebauthn*", why: "passkey and security key unlock" },
	{ path: "packages/core/src/app/hooks/useDesktopLink*", why: "linking to the desktop app" },
	// Browser extensions
	{ path: "clients/extension/src", why: "the extension: keys, messaging, autofill on pages" },
	{ path: "packages/manifests", why: "extension permissions and content security policy" },
	// Desktop
	{ path: "clients/desktop/src-tauri/src", why: "the native app: keys, biometrics, updates" },
	{ path: "clients/desktop/src-tauri/capabilities", why: "what the app's webview may call" },
	{ path: "clients/desktop/src-tauri/tauri.conf.json", why: "updater, signing and webview policy" },
	{ path: "clients/desktop/src-tauri/sigsum-keys.txt", why: "keys that may sign updates" },
	{ path: "clients/desktop/src-tauri/entitlements.plist", why: "macOS permissions" },
	{ path: "clients/desktop/src-tauri/Cargo.lock", why: "native dependencies" },
	{ path: "clients/desktop/src/adapters", why: "the desktop shell" },
	{ path: "clients/desktop/src/sync", why: "desktop sync" },
	{ path: "clients/desktop/src/sync-crypto.ts", why: "desktop sync encryption" },
	{ path: "clients/desktop/src/auto-lock.ts", why: "auto-lock" },
	{ path: "clients/desktop/macos/BrambleAutoFill", why: "the macOS AutoFill extension" },
	// iPhone and Android
	{ path: "clients/mobile/src/adapters", why: "the mobile shell" },
	{ path: "clients/mobile/src/sync", why: "mobile sync" },
	{ path: "clients/mobile/src/native-crypto.ts", why: "the bridge to native cryptography" },
	{ path: "clients/mobile/src/secure-storage.ts", why: "keys kept by the system" },
	{ path: "clients/mobile/src/auto-lock*", why: "auto-lock" },
	{ path: "clients/mobile/src/autofill-pending*", why: "what autofill hands the app" },
	{ path: "clients/mobile/src/encrypted-handoff.ts", why: "encrypted handoff to the app" },
	{ path: "clients/mobile/src/credential-exchange.ts", why: "credential import and export" },
	{ path: "clients/mobile/android/app/src/main/java", why: "Android autofill, passkeys, keys" },
	{ path: "clients/mobile/android/app/src/main/AndroidManifest.xml", why: "Android permissions" },
	{ path: "clients/mobile/android/app/src/main/res/xml", why: "autofill, backup and file rules" },
	{ path: "clients/mobile/ios/App/App/*.swift", why: "the iPhone app's native code" },
	{ path: "clients/mobile/ios/App/App/App.entitlements", why: "iPhone permissions" },
	{ path: "clients/mobile/ios/App/App/Info.plist", why: "iPhone app settings" },
	{ path: "clients/mobile/ios/App/AutoFillProbe", why: "the iPhone AutoFill extension" },
];

const NOT_SHIPPED =
	/(^|\/)(tests?|Tests|__tests__|androidTest|fixtures)\/|\.(test|spec)\.[cm]?[jt]sx?$|\.harness\.ts$|\.md$/;

/** A SECURITY_PATHS entry as a regular expression over repository paths. */
export const pathPattern = (path: string): RegExp =>
	new RegExp(
		`^${path
			.split("*")
			.map((s) => s.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
			.join("[^/]*")}(/|$)`,
	);
const SECURITY_PATTERNS = SECURITY_PATHS.map((p) => pathPattern(p.path));

const under = (file: string, dir: string) => file === dir || file.startsWith(`${dir}/`);

/** Whether a target's build contains `file`, by the same pathspecs its release notes use. */
export function shipsIn(file: string, target: string): boolean {
	const specs = PLATFORM_PATHS[target];
	if (!specs) throw new Error(`no paths defined for target "${target}"`);
	const excluded = specs.filter((s) => s.startsWith(":(exclude)")).map((s) => s.slice(10));
	const included = [...specs.filter((s) => !s.startsWith(":")), ...SHARED_PATHS];
	return included.some((d) => under(file, d)) && !excluded.some((d) => under(file, d));
}

/** The files among `files` that are security-sensitive and ship in `target`. */
export function securityFiles(files: string[], target: string): string[] {
	return files.filter(
		(f) => !NOT_SHIPPED.test(f) && shipsIn(f, target) && SECURITY_PATTERNS.some((p) => p.test(f)),
	);
}
