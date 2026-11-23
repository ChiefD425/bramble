// node --test scripts/release-notes.test.ts
//
// The committed What's new text becoming a release's summary (docs/whats-new.md).

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { composeNotes, whatsNewPath, whatsNewSummary } from "./release-notes.mjs";

const notes = (version: string) =>
	`---\nversion: ${version}\n---\n\nFill from the window.\n\n- One.\n- Two.\n`;

describe("whatsNewSummary", () => {
	it("is the text under the front matter when it is for this release", () => {
		assert.deepEqual(whatsNewSummary(notes("1.42.0"), "1.42.0"), {
			found: "1.42.0",
			summary: "Fill from the window.\n\n- One.\n- Two.",
		});
	});

	it("is null, naming the release it is for, when it is for another", () => {
		assert.deepEqual(whatsNewSummary(notes("1.41.0"), "1.42.0"), {
			found: "1.41.0",
			summary: null,
		});
	});

	it("is null for a missing file, no front matter, or no text", () => {
		assert.deepEqual(whatsNewSummary(undefined, "1.42.0"), { found: null, summary: null });
		assert.deepEqual(whatsNewSummary("- One.", "1.42.0"), { found: null, summary: null });
		assert.deepEqual(whatsNewSummary("---\nversion: 1.42.0\n---\n\n", "1.42.0"), {
			found: "1.42.0",
			summary: null,
		});
	});

	it("reads CRLF files", () => {
		const crlf = notes("1.42.0").replace(/\n/g, "\r\n");
		assert.equal(
			whatsNewSummary(crlf, "1.42.0").summary,
			"Fill from the window.\n\n- One.\n- Two.",
		);
	});

	it("points at the file the app bundles", () => {
		assert.equal(whatsNewPath("android"), "packages/core/src/app/release-notes/en/android.md");
	});
});

describe("composeNotes with the committed summary", () => {
	it("puts it above the full list as it is, with no draft and no editor", async () => {
		const body = await composeNotes({
			subjects: ["feat: fill from the window", "fix: a thing"],
			footer: "**Full Changelog**: x",
			summary: "Fill from the window.\n\n- One.",
		});
		assert.equal(
			body,
			"Fill from the window.\n\n- One.\n\n## All changes (2)\n\n### Features\n\n- fill from the window\n\n### Bug Fixes\n\n- a thing\n\n**Full Changelog**: x",
		);
	});
});
