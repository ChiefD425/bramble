// Rebuild a browser-extension release from its tag and check it byte for byte against what was
// published: the zip on the GitHub release, and the package the store hands to users.
//
//   node scripts/verify-release.ts 1.37.0-firefox       # a release by its tag
//   node scripts/verify-release.ts --live chromium      # whatever the store is serving right now
//   node scripts/verify-release.ts 1.40.0-chromium --no-store
//
// Needs git (a clone with the tag), Docker, and network. The build runs in
// docker/reproducible-build.Dockerfile as linux/amd64, which is the release runner's platform; see
// docs/reproducible-builds.md for why the platform matters and what each store changes.

import { execFileSync, execSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { CWS_ITEM_ID } from "./cws-ids.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const REPO = process.env.GITHUB_REPOSITORY ?? "bramble-sh/bramble";
const DOCKERFILE = "docker/reproducible-build.Dockerfile";
const AMO_ID = "firefox@bramble.app";
const AMO_API = "https://addons.mozilla.org/api/v5/addons/addon";
const CWS_CRX =
	"https://clients2.google.com/service/update2/crx?response=redirect&prodversion=999.0" +
	`&acceptformat=crx3&x=${encodeURIComponent(`id=${CWS_ITEM_ID}&uc`)}`;

export type Target = "firefox" | "chromium";

/** Path relative to the extension root, mapped to the SHA-256 of its bytes. */
export type Tree = Map<string, string>;

export interface Mismatch {
	path: string;
	problem: "missing" | "extra" | "differs";
}

export function parseTag(tag: string): { version: string; target: Target } {
	const m = /^(\d+\.\d+\.\d+)-(firefox|chromium)$/.exec(tag);
	if (!m) throw new Error(`${tag} is not an extension release tag (like 1.37.0-firefox)`);
	return { version: m[1], target: m[2] as Target };
}

/**
 * What the GitHub zip leaves out of the build directory: the bundle scripts' `zip -x` list in
 * clients/extension/package.json.
 */
export function inReleaseZip(path: string): boolean {
	const name = path.split("/").pop() ?? path;
	return !(
		path.endsWith(".d.ts") ||
		path === "wasm/package.json" ||
		name === ".gitignore" ||
		name === ".DS_Store"
	);
}

/**
 * What a store package carries that the build did not make: AMO's signature in META-INF/, and the
 * Chrome Web Store's _metadata/ (its own hashes of every file). Dotfiles never reach either store.
 */
export function storeAdded(path: string): boolean {
	return path.startsWith("META-INF/") || path.startsWith("_metadata/");
}

/**
 * manifest.json as the store rewrites it: AMO reformats it, and the Chrome Web Store adds
 * update_url. Compared as data, with only that one key allowed to differ.
 */
export function canonicalManifest(bytes: Buffer): string {
	const manifest = JSON.parse(bytes.toString("utf8"));
	delete manifest.update_url;
	return JSON.stringify(sortKeys(manifest));
}

function sortKeys(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(sortKeys);
	if (value && typeof value === "object")
		return Object.fromEntries(
			Object.keys(value)
				.sort()
				.map((k) => [k, sortKeys((value as Record<string, unknown>)[k])]),
		);
	return value;
}

export function compareTrees(rebuilt: Tree, published: Tree): Mismatch[] {
	const out: Mismatch[] = [];
	for (const [path, hash] of rebuilt) {
		const other = published.get(path);
		if (other === undefined) out.push({ path, problem: "missing" });
		else if (other !== hash) out.push({ path, problem: "differs" });
	}
	for (const path of published.keys()) if (!rebuilt.has(path)) out.push({ path, problem: "extra" });
	return out.sort((a, b) => a.path.localeCompare(b.path));
}

/** The zip inside a CRX3 package: "Cr24", version 3, the header's length, the header, then the zip. */
export function crxZip(crx: Buffer): Buffer {
	if (crx.subarray(0, 4).toString("latin1") !== "Cr24") throw new Error("not a CRX package");
	const version = crx.readUInt32LE(4);
	if (version !== 3) throw new Error(`CRX version ${version}, want 3`);
	return crx.subarray(12 + crx.readUInt32LE(8));
}

const sha256 = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

/** Every file under `dir`, filtered, with manifest.json hashed in its canonical form. */
function readTree(dir: string, keep: (path: string) => boolean, canonical = false): Tree {
	const tree: Tree = new Map();
	const walk = (at: string) => {
		for (const entry of readdirSync(at, { withFileTypes: true })) {
			const full = join(at, entry.name);
			if (entry.isDirectory()) walk(full);
			else {
				const path = relative(dir, full).split("\\").join("/");
				if (!keep(path)) continue;
				const bytes = readFileSync(full);
				tree.set(
					path,
					canonical && path === "manifest.json"
						? sha256(Buffer.from(canonicalManifest(bytes)))
						: sha256(bytes),
				);
			}
		}
	};
	walk(dir);
	return tree;
}

async function download(url: string): Promise<Buffer> {
	const res = await fetch(url, { redirect: "follow" });
	if (!res.ok) throw new Error(`${url} answered ${res.status}`);
	return Buffer.from(await res.arrayBuffer());
}

function unzip(zip: Buffer, into: string): void {
	mkdirSync(into, { recursive: true });
	const file = `${into}.zip`;
	writeFileSync(file, zip);
	execFileSync("unzip", ["-q", "-o", file, "-d", into]);
}

/** The version the store serves to a fresh install right now. */
async function liveVersion(target: Target, scratch: string): Promise<string> {
	if (target === "firefox") {
		const res = await fetch(`${AMO_API}/${encodeURIComponent(AMO_ID)}/`);
		if (!res.ok) throw new Error(`AMO answered ${res.status}`);
		return (await res.json()).current_version.version;
	}
	const dir = join(scratch, "live-crx");
	unzip(crxZip(await download(CWS_CRX)), dir);
	return JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8")).version;
}

/** The store's copy of `version`, unpacked, or null when the store no longer serves it. */
async function storePackage(target: Target, version: string, into: string): Promise<string | null> {
	if (target === "firefox") {
		const res = await fetch(`${AMO_API}/${encodeURIComponent(AMO_ID)}/versions/${version}/`);
		if (!res.ok) throw new Error(`AMO has no ${version} (${res.status})`);
		const file = (await res.json()).file as { url: string; hash: string };
		const xpi = await download(file.url);
		if (`sha256:${sha256(xpi)}` !== file.hash)
			throw new Error(`the AMO download does not match AMO's own hash for ${version}`);
		unzip(xpi, into);
		return into;
	}
	// The Chrome Web Store only ever serves its current version.
	unzip(crxZip(await download(CWS_CRX)), into);
	const served = JSON.parse(readFileSync(join(into, "manifest.json"), "utf8")).version;
	return served === version ? into : null;
}

/** The GitHub release's zip, checked against its own SHA256SUMS, unpacked. */
async function releaseZip(tag: string, target: Target, version: string, into: string) {
	const base = `https://github.com/${REPO}/releases/download/${tag}`;
	const name = `bramble_${target}_${version}.zip`;
	const zip = await download(`${base}/${name}`);
	const sums = (await download(`${base}/SHA256SUMS`)).toString("utf8");
	const listed = sums.split("\n").find((l) => l.trim().endsWith(` ${name}`));
	if (!listed?.startsWith(sha256(zip)))
		throw new Error(`${name} does not match the release's SHA256SUMS`);
	unzip(zip, into);
	return into;
}

function rebuild(tag: string, target: Target, scratch: string): string {
	const src = join(scratch, "src");
	const out = join(scratch, "out");
	mkdirSync(src, { recursive: true });
	mkdirSync(out, { recursive: true });
	try {
		execFileSync("git", ["-C", ROOT, "rev-parse", "--verify", "--quiet", `${tag}^{commit}`]);
	} catch {
		throw new Error(`no tag ${tag} here; run git fetch --tags`);
	}
	execSync(`git -C "${ROOT}" archive --format=tar "${tag}" | tar -x -C "${src}"`);

	const dockerfile = readFileSync(join(ROOT, DOCKERFILE));
	const image = `bramble-reproducible:${sha256(dockerfile).slice(0, 12)}`;
	const platform = ["--platform", "linux/amd64"];
	execFileSync(
		"docker",
		[
			"build",
			...platform,
			"-t",
			image,
			"-f",
			join(ROOT, DOCKERFILE),
			dirname(join(ROOT, DOCKERFILE)),
		],
		{ stdio: "inherit" },
	);
	const uid = process.getuid?.() ?? 0;
	const gid = process.getgid?.() ?? 0;
	const script = [
		"set -euo pipefail",
		"cp -a /src /build && cd /build",
		"pnpm install --frozen-lockfile",
		"pnpm run wasm:build",
		`pnpm --filter @vault/platform-extension run bundle:${target}`,
		`cp -a clients/extension/dist-${target} /out/dist`,
		`chown -R ${uid}:${gid} /out`,
	].join("\n");
	execFileSync(
		"docker",
		[
			"run",
			"--rm",
			...platform,
			"-v",
			`${src}:/src:ro`,
			"-v",
			`${out}:/out`,
			image,
			"bash",
			"-c",
			script,
		],
		{ stdio: "inherit" },
	);
	return join(out, "dist");
}

function report(label: string, mismatches: Mismatch[], count: number): boolean {
	if (!mismatches.length) {
		console.log(`  ${label}: all ${count} files identical`);
		return true;
	}
	console.log(`  ${label}: ${mismatches.length} of ${count} files do not match`);
	for (const m of mismatches) console.log(`    ${m.problem.padEnd(8)} ${m.path}`);
	return false;
}

async function main(argv: string[]): Promise<number> {
	const scratch = mkdtempSync(join(tmpdir(), "bramble-verify-"));
	try {
		let tag = argv.find((a) => !a.startsWith("--"));
		const live = argv.indexOf("--live");
		if (live !== -1) {
			const target = argv[live + 1] as Target;
			if (target !== "firefox" && target !== "chromium")
				throw new Error("--live takes firefox or chromium");
			tag = `${await liveVersion(target, scratch)}-${target}`;
			console.log(`the store is serving ${tag}`);
		}
		if (!tag) throw new Error("usage: verify-release.ts <tag> | --live <firefox|chromium>");
		const { version, target } = parseTag(tag);

		const dist = rebuild(tag, target, scratch);
		const wasm = readFileSync(join(dist, "wasm/vault_crypto_bg.wasm"));
		console.log(`\nrebuilt ${tag}; vault_crypto_bg.wasm sha256 ${sha256(wasm)}`);

		const fromRelease = await releaseZip(tag, target, version, join(scratch, "release"));
		const zipTree = readTree(dist, inReleaseZip);
		let ok = report(
			"GitHub release zip",
			compareTrees(
				zipTree,
				readTree(fromRelease, () => true),
			),
			zipTree.size,
		);

		if (!argv.includes("--no-store")) {
			const store = target === "firefox" ? "addons.mozilla.org" : "the Chrome Web Store";
			const fromStore = await storePackage(target, version, join(scratch, "store"));
			if (fromStore) {
				const notDot = (p: string) => !(p.split("/").pop() ?? p).startsWith(".");
				const built = readTree(dist, notDot, true);
				const served = readTree(fromStore, (p) => notDot(p) && !storeAdded(p), true);
				ok = report(store, compareTrees(built, served), built.size) && ok;
			} else {
				console.log(`  ${store}: no longer serves ${version}; --live checks what it serves now`);
			}
		}
		console.log(ok ? "\nreproducible" : "\nNOT reproducible");
		return ok ? 0 : 1;
	} finally {
		rmSync(scratch, { recursive: true, force: true });
	}
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	main(process.argv.slice(2)).then(
		(code) => process.exit(code),
		(e: Error) => {
			console.error(`error: ${e.message}`);
			process.exit(2);
		},
	);
}
