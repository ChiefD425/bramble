// Web store listing adapter: generates store/<store>/<code>/*.txt from the en
// source so the Chrome Web Store and AMO listings can localize. Idempotent: a
// target is rewritten only when the English it was translated from has changed
// (see source-hash.mjs), so manual fixes survive but an edit to en propagates.
//
// Chrome: the name + short description already localize from the package _locales
// (see chrome-manifest.mjs); only the dashboard-only detailed_description lives here.
// Firefox/AMO: summary (<=250) + description; both can be pushed via the AMO API.

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { LOCALES, STORE_DIR } from "./locales.mjs";
import { fitToLimit, translateText } from "./ollama.mjs";
import { flushSources, recordSource, sourceChanged } from "./source-hash.mjs";

const SOURCE = "en";
const STORES = ["chrome", "firefox"];
// Hard character caps a store rejects at submit; enforced in a second fit pass.
const LIMITS = {
	chrome: {},
	firefox: { "summary.txt": 250 },
};

export async function run() {
	console.log("• Web store listings (Chrome + Firefox)");
	for (const store of STORES) {
		const src = join(STORE_DIR, store, SOURCE);
		if (!existsSync(src)) {
			console.log(`  ${store}: no ${SOURCE}/ source — skipping`);
			continue;
		}
		const files = readdirSync(src).filter((f) => f.endsWith(".txt"));
		for (const { code, name } of LOCALES) {
			const dir = join(STORE_DIR, store, code);
			mkdirSync(dir, { recursive: true });
			let wrote = 0;
			for (const file of files) {
				const target = join(dir, file);
				const en = readFileSync(join(src, file), "utf8");
				if (existsSync(target) && !sourceChanged(target, en)) continue;
				writeFileSync(target, await translateText(name, en));
				recordSource(target, en);
				wrote++;
			}
			console.log(`  ${store}/${code}: ${wrote ? `wrote ${wrote} file(s)` : "up to date"}`);
		}
	}
	flushSources();
	await fitPass();
}

// Second AI pass: shorten any field over its store cap, with a hard word-boundary
// trim as a deterministic fallback. Idempotent (only touches over-length files).
async function fitPass() {
	const capped = STORES.filter((s) => Object.keys(LIMITS[s]).length);
	if (!capped.length) return;
	console.log("  fitting fields to store limits…");
	for (const store of capped) {
		for (const { code, name } of LOCALES) {
			for (const [file, limit] of Object.entries(LIMITS[store])) {
				const path = join(STORE_DIR, store, code, file);
				if (!existsSync(path)) continue;
				const original = readFileSync(path, "utf8").trim();
				if (original.length <= limit) continue;
				let fitted = await fitToLimit(name, original, limit, "text");
				if (fitted.length > limit) {
					const cut = fitted.slice(0, limit);
					const sp = cut.lastIndexOf(" ");
					fitted = (sp > limit * 0.6 ? cut.slice(0, sp) : cut).trim();
				}
				writeFileSync(path, fitted);
				console.log(`    ${store}/${code}/${file}: ${original.length} -> ${fitted.length}`);
			}
		}
	}
}
