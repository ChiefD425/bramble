// The card after an update. See docs/whats-new.md.

import type { Target } from "../flags";
import { installedVersion, isNewer } from "./app-update";

/** The version the card was last closed for. Device-scoped (usePrefs). */
export const PREF_WHATS_NEW = "pref.whatsNew";

export interface ReleaseNotes {
	/** The release this text is for. */
	version: string;
	headline?: string;
	items: string[];
}

export interface WhatsNewState {
	/** The version the card was last closed for, or the one a fresh install started on. */
	seen?: string;
}

const VERSION = /^\d+(\.\d+){0,2}$/;

/** Field by field, like normalizeAppUpdateState: stored values may come from another build. */
export function normalizeWhatsNewState(raw: unknown): WhatsNewState {
	if (!raw || typeof raw !== "object") return {};
	const seen = (raw as Record<string, unknown>).seen;
	return typeof seen === "string" && VERSION.test(seen) ? { seen } : {};
}

/**
 * The first vault on a device marks a fresh install, which starts on the installed version: a new
 * user is never told what changed since a version they never had. Called by the vault registry,
 * the one place every way of getting a vault (create, pair, restore) goes through, in every root.
 */
export async function markFreshInstall(
	storage: {
		getMeta<V>(k: string): Promise<V | undefined>;
		setMeta<V>(k: string, v: V): Promise<void>;
	},
	shellVersion: string,
): Promise<void> {
	const installed = installedVersion(shellVersion);
	if (!installed || (await storage.getMeta(PREF_WHATS_NEW)) !== undefined) return;
	await storage.setMeta<WhatsNewState>(PREF_WHATS_NEW, { seen: installed });
}

/** No record means an install from before this feature, which gets the card once. */
export function whatsNewDue(state: WhatsNewState, installed: string): boolean {
	return state.seen === undefined || isNewer(installed, state.seen);
}

/**
 * `release-notes/<locale>/<target>.md`: a `version:` front matter, a headline paragraph, then
 * `- ` items. A line under an item that does not start a new one continues it. Null when there is
 * no version or nothing to show.
 */
export function parseReleaseNotes(md: string): ReleaseNotes | null {
	const text = md.replace(/\r\n/g, "\n");
	const front = text.match(/^---\n([\s\S]*?)\n---\n?/);
	const version = front?.[1]?.match(/^version:\s*["']?([^"'\s]+)["']?\s*$/m)?.[1];
	if (!front || !version || !VERSION.test(version)) return null;

	let headline: string | undefined;
	const items: string[] = [];
	for (const block of text.slice(front[0].length).split(/\n\s*\n/)) {
		const lines = block
			.split("\n")
			.map((l) => l.trim())
			.filter(Boolean);
		if (lines.length === 0) continue;
		// A translation can drop the blank line between the headline and the first item.
		const first = lines.findIndex((l) => l.startsWith("- "));
		const lead = first === -1 ? lines : lines.slice(0, first);
		if (lead.length && headline === undefined && items.length === 0) headline = lead.join(" ");
		if (first === -1 || (lead.length && items.length)) continue;
		for (const line of lines.slice(first)) {
			if (line.startsWith("- ")) items.push(line.slice(2).trim());
			else if (items.length) items[items.length - 1] += ` ${line}`;
		}
	}
	if (!headline && items.length === 0) return null;
	return { version, headline, items };
}

/** Where Read more goes: the website resolves it to the blog post that lists this release. */
export function whatsNewUrl(target: Target, version: string): string {
	return `https://bramble.sh/whats-new/${target}/${version}`;
}

/** Each file a lazy chunk, read only when there is a card to show. */
type NoteFiles = Record<string, () => Promise<string>>;

const NOTES: NoteFiles = import.meta.glob<string>("./release-notes/*/*.md", {
	query: "?raw",
	import: "default",
});

async function readNotes(
	files: NoteFiles,
	locale: string,
	target: Target,
): Promise<ReleaseNotes | null> {
	const load = files[`./release-notes/${locale}/${target}.md`];
	return load ? parseReleaseNotes(await load()) : null;
}

/**
 * The notes this build carries for its own version, in `locale` when that translation is of the
 * same version, else in English. Null when the build's notes are for another release.
 */
export async function loadReleaseNotes(
	target: Target,
	locale: string,
	installed: string,
	files: NoteFiles = NOTES,
): Promise<ReleaseNotes | null> {
	const en = await readNotes(files, "en", target);
	if (en?.version !== installed) return null;
	if (locale === "en") return en;
	const translated = await readNotes(files, locale, target);
	return translated?.version === installed ? translated : en;
}
