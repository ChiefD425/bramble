// Release notes adapter: translates the "What's new" card's text (docs/whats-new.md),
// release-notes/en/<target>.md, into release-notes/<code>/<target>.md. Whole-file, so staleness
// comes from source-hash: a locale is rewritten when the English it came from changed. The
// front matter is copied, not translated, so a translation names the release its English does.

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { LOCALES, RELEASE_NOTES_DIR, SOURCE } from "./locales.mjs";
import { translateText } from "./ollama.mjs";
import { flushSources, recordSource, sourceChanged } from "./source-hash.mjs";

const RULES =
	"This is a release note shown inside the app. Keep the first paragraph as one paragraph, and " +
	"every line that starts with '- ' as one list item starting with '- ', in the same order. " +
	"Keep product and service names (Bramble, Firefox, Safari, 1Password, KeePass, KeePassXC, " +
	"Google Drive, Dropbox) as they are.";

/** The front matter block and the text under it. */
export function splitFrontMatter(md) {
	const m = md.match(/^---\n[\s\S]*?\n---\n/);
	return m ? { front: m[0], body: md.slice(m[0].length).trim() } : { front: "", body: md.trim() };
}

const items = (text) => text.split("\n").filter((l) => l.startsWith("- ")).length;

export async function run() {
	console.log("• Release notes (the What's new card)");
	const src = join(RELEASE_NOTES_DIR, SOURCE);
	if (!existsSync(src)) {
		console.log(`  no ${SOURCE}/ source — skipping`);
		return;
	}
	const files = readdirSync(src).filter((f) => f.endsWith(".md"));
	for (const { code, name } of LOCALES) {
		mkdirSync(join(RELEASE_NOTES_DIR, code), { recursive: true });
		let wrote = 0;
		for (const file of files) {
			const target = join(RELEASE_NOTES_DIR, code, file);
			const en = readFileSync(join(src, file), "utf8");
			if (existsSync(target) && !sourceChanged(target, en)) continue;
			const { front, body } = splitFrontMatter(en);
			let translated = await translateText(name, body, RULES);
			// A merged or split item would put a different list in front of this language's readers.
			if (items(translated) !== items(body)) translated = await translateText(name, body, RULES);
			if (items(translated) !== items(body)) {
				console.warn(`  ${code}/${file}: the list came back reshaped twice; left for English`);
				continue;
			}
			writeFileSync(target, `${front}\n${translated}\n`);
			recordSource(target, en);
			wrote++;
		}
		console.log(`  ${code}: ${wrote ? `wrote ${wrote} file(s)` : "up to date"}`);
	}
	flushSources();
}
