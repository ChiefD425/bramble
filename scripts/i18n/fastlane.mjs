// iOS fastlane metadata adapter: generates metadata/<appStore>/ dirs from the
// en-US source so `deliver` uploads localized App Store listings. Idempotent: a
// target is rewritten only when the English it was translated from has changed
// (see source-hash.mjs), so manual fixes survive but an edit to en-US propagates.
// The search fields (SEARCH) are the exception: each store's are written for what
// people there type, so they are seeded once and never overwritten.

import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { APP_STORE_MIRRORS, FASTLANE_DIR, LOCALES, SOURCE } from "./locales.mjs";
import { fitToLimit, translateText } from "./ollama.mjs";
import { flushSources, recordSource, sourceChanged } from "./source-hash.mjs";

const SOURCE_DIR = "en-US";
// Prose files worth translating.
const PROSE = new Set(["description.txt", "promotional_text.txt", "release_notes.txt", "subtitle.txt"]);
// Brand name and URLs are copied verbatim.
const VERBATIM = new Set(["name.txt", "privacy_url.txt", "support_url.txt"]);
// keywords.txt: comma-separated, hard 100-char App Store cap — special handling.
const KEYWORDS = "keywords.txt";
// What App Store search indexes. Per-locale once written; see docs/i18n.md.
const SEARCH = new Set(["name.txt", "subtitle.txt", KEYWORDS]);
// App Store hard character limits; fields over these are rejected at upload.
const LIMITS = { "keywords.txt": 100, "subtitle.txt": 30, "promotional_text.txt": 170 };

export async function run() {
	console.log("• iOS fastlane metadata");
	const src = join(FASTLANE_DIR, SOURCE_DIR);
	if (!existsSync(src)) {
		console.log(`  no source dir ${SOURCE_DIR} — skipping`);
		return;
	}
	const files = readdirSync(src).filter((f) => f.endsWith(".txt"));
	for (const { code, name, appStore } of LOCALES) {
		const dir = join(FASTLANE_DIR, appStore);
		mkdirSync(dir, { recursive: true });
		let wrote = 0;
		for (const file of files) {
			const target = join(dir, file);
			const en = readFileSync(join(src, file), "utf8");
			if (SEARCH.has(file) && existsSync(target)) continue;
			// Present AND still matching the English it came from: leave it (a manual fix wins).
			if (existsSync(target) && !sourceChanged(target, en)) continue;
			let value;
			if (VERBATIM.has(file)) value = en;
			else if (file === KEYWORDS) value = await translateKeywords(name, en);
			else if (PROSE.has(file)) value = await translateText(name, en);
			else value = en; // unknown file: copy through
			writeFileSync(target, value);
			if (!SEARCH.has(file)) recordSource(target, en);
			wrote++;
		}
		console.log(`  ${appStore}: ${wrote ? `wrote ${wrote} file(s)` : "up to date"}`);
	}
	flushSources();
	await fitPass();
	linkMirrors();
}

// Each mirror holds its `own` files (seeded from `from` when missing) and a relative symlink to
// `from` for everything else. A real file where a link belongs is reported, not replaced.
function linkMirrors() {
	for (const { appStore, from, own } of APP_STORE_MIRRORS) {
		const dir = join(FASTLANE_DIR, appStore);
		mkdirSync(dir, { recursive: true });
		for (const file of readdirSync(join(FASTLANE_DIR, from)).filter((f) => f.endsWith(".txt"))) {
			const target = join(dir, file);
			const link = `../${from}/${file}`;
			if (own.includes(file)) {
				if (!existsSync(target)) writeFileSync(target, readFileSync(join(FASTLANE_DIR, from, file)));
				continue;
			}
			const stat = lstatSync(target, { throwIfNoEntry: false });
			if (!stat) symlinkSync(link, target);
			else if (!stat.isSymbolicLink() || readlinkSync(target) !== link) {
				console.warn(`  ${appStore}/${file} should be a symlink to ${link}; left as is`);
			}
		}
		console.log(`  ${appStore}: mirrors ${from} (own: ${own.join(", ")})`);
	}
}

// Second AI pass: shorten any field that overruns its App Store cap. Idempotent
// (only touches files already over the limit), with a deterministic fallback so a
// field is never left over-length.
async function fitPass() {
	console.log("  fitting fields to App Store limits…");
	for (const { name, appStore } of LOCALES) {
		for (const [file, limit] of Object.entries(LIMITS)) {
			const path = join(FASTLANE_DIR, appStore, file);
			if (!existsSync(path)) continue;
			const original = readFileSync(path, "utf8").trim();
			if (original.length <= limit) continue;
			const kind = file === KEYWORDS ? "keywords" : "text";
			let fitted = await fitToLimit(name, original, limit, kind);
			if (fitted.length > limit) fitted = hardTrim(fitted, limit, kind);
			writeFileSync(path, fitted);
			console.log(`    ${appStore}/${file}: ${original.length} -> ${fitted.length}`);
		}
	}
}

// Last-resort trim if the model can't get under the cap: drop trailing keywords,
// or cut prose at a word boundary.
function hardTrim(text, limit, kind) {
	if (kind === "keywords") {
		const parts = text.split(",");
		while (parts.length > 1 && parts.join(",").length > limit) parts.pop();
		return parts.join(",").slice(0, limit);
	}
	const cut = text.slice(0, limit);
	const sp = cut.lastIndexOf(" ");
	return (sp > limit * 0.6 ? cut.slice(0, sp) : cut).trim();
}

async function translateKeywords(language, csv) {
	const out = await translateText(
		language,
		csv,
		"This is a comma-separated App Store keyword list. Translate each keyword, keep it comma-separated, drop none, and keep brand/standard terms untranslated.",
	);
	const clean = out.replace(/\s*,\s*/g, ",").trim();
	if (clean.length > 100) {
		console.warn(`    keywords too long (${clean.length}>100) for ${language}; trim manually`);
	}
	return clean;
}
