#!/usr/bin/env node
// Tauri's Windows `signCommand` in the release build (windows-build.sh). Tauri calls it with every
// file it would Authenticode-sign while it bundles: the app, the proxy, the NSIS plugins, the
// uninstaller (from makensis) and last the installer. Signing happens on a Windows runner away from
// the build (sign-windows.yml), so this hands files across rather than signing them:
//
//   BRAMBLE_SIGN_SIGNED   a folder of signed files: a file whose bytes, signature aside, match one
//                         of them is replaced by it
//   BRAMBLE_SIGN_COLLECT  a folder to copy every file with no signed match into, for signing
//   BRAMBLE_SIGN_LENIENT  leave a file with no signed match as it is (rebuilding a release whose
//                         installer is the only source of signed files); otherwise that fails
//
// The installer is left alone: it is signed last, on its own. See docs/reproducible-builds.md.

import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, extname, join, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { hasAuthenticode, stripAuthenticode } from "./pe-normalize.ts";

/** The bytes a signature cannot change, hashed: what a file and its signed copy share. */
export function contentKey(pe: Buffer): string {
	return createHash("sha256").update(stripAuthenticode(pe)).digest("hex");
}

/** Every signed PE file under `dir`, by content key. Anything else is ignored. */
export function indexSigned(dir: string): Map<string, string> {
	const index = new Map<string, string>();
	const walk = (d: string) => {
		for (const name of readdirSync(d)) {
			const path = join(d, name);
			if (statSync(path).isDirectory()) walk(path);
			else {
				try {
					const pe = readFileSync(path);
					if (hasAuthenticode(pe)) index.set(contentKey(pe), path);
				} catch {
					// not a PE file, or not one we can read: no signed copy of anything
				}
			}
		}
	};
	walk(dir);
	return index;
}

export function isInstaller(file: string): boolean {
	return file.includes(`${sep}bundle${sep}nsis${sep}`) && file.endsWith("-setup.exe");
}

export type Outcome = "installer" | "signed" | "collected" | "kept";

export interface Handoff {
	signed?: string;
	collect?: string;
	lenient?: boolean;
}

export function handOff(file: string, opts: Handoff): Outcome {
	if (isInstaller(file)) return "installer";
	const pe = readFileSync(file);
	const key = contentKey(pe);
	const match = opts.signed ? indexSigned(opts.signed).get(key) : undefined;
	if (match) {
		copyFileSync(match, file);
		return "signed";
	}
	if (opts.collect) {
		mkdirSync(opts.collect, { recursive: true });
		const ext = [".exe", ".dll"].includes(extname(file).toLowerCase()) ? extname(file) : ".exe";
		copyFileSync(file, join(opts.collect, `${key}${ext}`));
		return "collected";
	}
	if (opts.lenient) return "kept";
	throw new Error(
		`no signed copy of ${file} (${key.slice(0, 12)}): the build differs from the one that was signed`,
	);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
	const file = process.argv[2];
	const opts: Handoff = {
		signed: process.env.BRAMBLE_SIGN_SIGNED || undefined,
		collect: process.env.BRAMBLE_SIGN_COLLECT || undefined,
		lenient: process.env.BRAMBLE_SIGN_LENIENT === "1",
	};
	try {
		if (!file) throw new Error("usage: windows-sign-handoff.ts <file>");
		if (!opts.signed && !opts.collect && !opts.lenient)
			throw new Error("set BRAMBLE_SIGN_SIGNED, BRAMBLE_SIGN_COLLECT or BRAMBLE_SIGN_LENIENT");
		console.log(`${handOff(file, opts)}: ${basename(file)}`);
	} catch (e) {
		console.error(`windows-sign-handoff: ${(e as Error).message}`);
		process.exit(1);
	}
}
