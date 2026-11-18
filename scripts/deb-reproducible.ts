// Rebuild the bundler's .deb so the same source gives the same bytes on any build host
// (docs/reproducible-builds.md). The files inside already match; what differed was the package
// around them: the build time and the builder's uid in the archive headers, the checksum list in
// the file system's directory order, and an Installed-Size that counted directory sizes, which
// differ between file systems. dpkg-deb with SOURCE_DATE_EPOCH, root ownership, sorted md5sums and
// Installed-Size from file sizes alone takes all of that out.

import { execFileSync } from "node:child_process";
import {
	existsSync,
	lstatSync,
	lutimesSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface Entry {
	kind: "file" | "dir" | "link";
	size: number;
}

/** Installed-Size in KiB as dpkg-gencontrol counts it: each file rounded up, one per dir and link. */
export function installedSize(entries: Entry[]): number {
	return entries.reduce((sum, e) => sum + (e.kind === "file" ? Math.ceil(e.size / 1024) : 1), 0);
}

export function withInstalledSize(control: string, kib: number): string {
	if (!/^Installed-Size: \d+$/m.test(control)) throw new Error("control has no Installed-Size");
	return control.replace(/^Installed-Size: \d+$/m, `Installed-Size: ${kib}`);
}

/** md5sums sorted by path, so it no longer follows the file system's directory order. */
export function sortedMd5sums(md5sums: string): string {
	const lines = md5sums.split("\n").filter(Boolean);
	const path = (l: string) => l.slice(l.indexOf("  ") + 2);
	return `${lines.sort((a, b) => (path(a) < path(b) ? -1 : path(a) > path(b) ? 1 : 0)).join("\n")}\n`;
}

/** Every path under `root`, depth first, with what dpkg needs to know about it. */
function walk(root: string, skip: string): [string, Entry][] {
	const out: [string, Entry][] = [];
	const visit = (dir: string) => {
		for (const name of readdirSync(dir)) {
			const path = join(dir, name);
			if (path === skip) continue;
			const st = lstatSync(path);
			if (st.isSymbolicLink()) out.push([path, { kind: "link", size: 0 }]);
			else if (st.isDirectory()) {
				visit(path);
				out.push([path, { kind: "dir", size: 0 }]);
			} else out.push([path, { kind: "file", size: st.size }]);
		}
	};
	visit(root);
	return out;
}

/** Rewrite every .deb in `bundleDir/deb` in place. */
export function normalizeDebs(bundleDir: string, epoch: number): void {
	const dir = join(bundleDir, "deb");
	if (!existsSync(dir)) return;
	for (const name of readdirSync(dir).filter((f) => f.endsWith(".deb"))) {
		const deb = join(dir, name);
		const scratch = mkdtempSync(join(tmpdir(), "bramble-deb-"));
		try {
			const root = join(scratch, "root");
			execFileSync("dpkg-deb", ["--raw-extract", deb, root]);
			const meta = join(root, "DEBIAN");
			const entries = walk(root, meta);
			const control = join(meta, "control");
			writeFileSync(
				control,
				withInstalledSize(readFileSync(control, "utf8"), installedSize(entries.map(([, e]) => e))),
			);
			const md5sums = join(meta, "md5sums");
			if (existsSync(md5sums)) writeFileSync(md5sums, sortedMd5sums(readFileSync(md5sums, "utf8")));
			for (const [path, e] of [...walk(root, "")]) {
				if (e.kind === "link") lutimesSync(path, epoch, epoch);
				else utimesSync(path, epoch, epoch);
			}
			utimesSync(root, epoch, epoch);
			execFileSync("dpkg-deb", ["--root-owner-group", "-Zgzip", "-z9", "--build", root, deb], {
				env: { ...process.env, SOURCE_DATE_EPOCH: String(epoch) },
				stdio: ["ignore", "ignore", "inherit"],
			});
		} finally {
			rmSync(scratch, { recursive: true, force: true });
		}
	}
}
