import { describe, expect, it } from "vitest";
import {
	loadReleaseNotes,
	normalizeWhatsNewState,
	parseReleaseNotes,
	whatsNewDue,
	whatsNewUrl,
} from "./whats-new";

const notes = (version: string, body: string) => `---\nversion: ${version}\n---\n\n${body}\n`;

describe("parseReleaseNotes", () => {
	it("reads the version, the headline and the items", () => {
		expect(parseReleaseNotes(notes("1.42.0", "Fill from the window.\n\n- One.\n- Two."))).toEqual({
			version: "1.42.0",
			headline: "Fill from the window.",
			items: ["One.", "Two."],
		});
	});

	it("joins a wrapped headline and a wrapped item", () => {
		const md = notes("1.0.0", "A headline\nthat wraps.\n\n- An item\n  that wraps.\n- Next.");
		expect(parseReleaseNotes(md)).toEqual({
			version: "1.0.0",
			headline: "A headline that wraps.",
			items: ["An item that wraps.", "Next."],
		});
	});

	it("reads items that follow the headline with no blank line between", () => {
		expect(parseReleaseNotes(notes("1.0.0", "A headline.\n- One.\n- Two."))).toEqual({
			version: "1.0.0",
			headline: "A headline.",
			items: ["One.", "Two."],
		});
	});

	it("takes items with no headline, and ignores paragraphs after the items", () => {
		expect(parseReleaseNotes(notes("1.0.0", "- Only item.\n\nNo account, no cloud."))).toEqual({
			version: "1.0.0",
			headline: undefined,
			items: ["Only item."],
		});
	});

	it("reads CRLF files and a quoted version", () => {
		const md = '---\r\nversion: "2.0.1"\r\n---\r\n\r\nHeadline.\r\n\r\n- Item.\r\n';
		expect(parseReleaseNotes(md)).toEqual({
			version: "2.0.1",
			headline: "Headline.",
			items: ["Item."],
		});
	});

	it("is null without a usable version or anything to show", () => {
		expect(parseReleaseNotes("Headline.\n\n- Item.")).toBeNull();
		expect(parseReleaseNotes(notes("next", "Headline."))).toBeNull();
		expect(parseReleaseNotes(notes("1.0.0", ""))).toBeNull();
	});
});

describe("whatsNewDue", () => {
	it("is due after an update, not on the version already seen or an older one", () => {
		expect(whatsNewDue({ seen: "1.41.0" }, "1.42.0")).toBe(true);
		expect(whatsNewDue({ seen: "1.42.0" }, "1.42.0")).toBe(false);
		expect(whatsNewDue({ seen: "1.43.0" }, "1.42.0")).toBe(false);
	});

	it("is due once for an install from before the feature, which has no record", () => {
		expect(whatsNewDue({}, "1.42.0")).toBe(true);
	});
});

describe("normalizeWhatsNewState", () => {
	it("keeps a version and drops anything else", () => {
		expect(normalizeWhatsNewState({ seen: "1.2.3", extra: 1 })).toEqual({ seen: "1.2.3" });
		expect(normalizeWhatsNewState({ seen: "soon" })).toEqual({});
		expect(normalizeWhatsNewState({ seen: 3 })).toEqual({});
		expect(normalizeWhatsNewState("1.2.3")).toEqual({});
		expect(normalizeWhatsNewState(undefined)).toEqual({});
	});
});

describe("whatsNewUrl", () => {
	it("names the target and version for the website to resolve", () => {
		expect(whatsNewUrl("chromium", "1.42.0")).toBe("https://bramble.sh/whats-new/chromium/1.42.0");
	});
});

describe("loadReleaseNotes", () => {
	const files = (entries: Record<string, string>) =>
		Object.fromEntries(
			Object.entries(entries).map(([k, v]) => [`./release-notes/${k}.md`, async () => v]),
		);

	it("reads the build's own release in the chosen language", async () => {
		const f = files({
			"en/chromium": notes("1.42.0", "English."),
			"de/chromium": notes("1.42.0", "Deutsch."),
		});
		expect((await loadReleaseNotes("chromium", "de", "1.42.0", f))?.headline).toBe("Deutsch.");
		expect((await loadReleaseNotes("chromium", "en", "1.42.0", f))?.headline).toBe("English.");
	});

	it("falls back to English when the translation is missing or for another release", async () => {
		const f = files({
			"en/android": notes("0.34.0", "English."),
			"de/android": notes("0.33.0", "Alt."),
		});
		expect((await loadReleaseNotes("android", "de", "0.34.0", f))?.headline).toBe("English.");
		expect((await loadReleaseNotes("android", "fr", "0.34.0", f))?.headline).toBe("English.");
	});

	it("is null when the notes are for another release or the target has none", async () => {
		const f = files({ "en/desktop": notes("0.21.0", "Old.") });
		expect(await loadReleaseNotes("desktop", "en", "0.22.0", f)).toBeNull();
		expect(await loadReleaseNotes("ios", "en", "1.28.0", f)).toBeNull();
	});

	it("reads the committed files through the real glob", async () => {
		expect(await loadReleaseNotes("chromium", "en", "0.0.1")).toBeNull();
	});
});

describe("the committed release notes", () => {
	const committed = import.meta.glob<string>("./release-notes/*/*.md", {
		query: "?raw",
		import: "default",
	});

	it("has an English file for every target", () => {
		for (const target of ["chromium", "firefox", "android", "ios", "desktop"])
			expect(Object.keys(committed)).toContain(`./release-notes/en/${target}.md`);
	});

	it("parses every file", async () => {
		for (const [path, load] of Object.entries(committed))
			expect(parseReleaseNotes(await load()), path).not.toBeNull();
	});
});
