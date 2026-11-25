// node --test scripts/website-headers.test.ts
//
// The website's response headers live in website/public/_headers, which Cloudflare Pages applies
// and the dev server doesn't, so the rule is checked here.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

/** The file's rules: each path with the headers indented under it. */
function rules(text: string): Map<string, Map<string, string>> {
	const out = new Map<string, Map<string, string>>();
	let current: Map<string, string> | undefined;
	for (const line of text.split("\n")) {
		if (!line.trim() || line.trimStart().startsWith("#")) continue;
		if (!/^\s/.test(line)) {
			current = new Map();
			out.set(line.trim(), current);
			continue;
		}
		const at = line.indexOf(":");
		current?.set(line.slice(0, at).trim().toLowerCase(), line.slice(at + 1).trim());
	}
	return out;
}

describe("website headers", () => {
	it("every website page refuses to be framed", () => {
		const all = rules(readFileSync("website/public/_headers", "utf8")).get("/*");
		assert.equal(all?.get("x-frame-options"), "DENY");
		assert.equal(all?.get("content-security-policy"), "frame-ancestors 'none'");
	});
});
