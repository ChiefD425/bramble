// node --test website/functions/whats-new/_location.test.ts

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { whatsNewLocation } from "./_location.ts";

const RELEASES = "https://github.com/bramble-sh/bramble/releases";
const POSTS = {
	"1.41.0-chromium": "/blog/whats-new-2026-11-20",
	"0.32.0-android": "/blog/whats-new-2026-11-20",
};

describe("whatsNewLocation", () => {
	it("goes to the blog post that lists the release", () => {
		assert.equal(
			whatsNewLocation("chromium", "1.41.0", POSTS, RELEASES),
			"/blog/whats-new-2026-11-20",
		);
	});

	it("goes to the GitHub release until there is a post", () => {
		assert.equal(
			whatsNewLocation("desktop", "0.21.0", POSTS, RELEASES),
			`${RELEASES}/tag/0.21.0-desktop`,
		);
	});

	it("goes to the blog for iOS, which has no GitHub release", () => {
		assert.equal(whatsNewLocation("ios", "1.28.0", POSTS, RELEASES), "/blog");
	});

	it("goes to the blog for anything it does not recognise", () => {
		assert.equal(whatsNewLocation("safari", "1.0.0", POSTS, RELEASES), "/blog");
		assert.equal(whatsNewLocation("chromium", "../../evil", POSTS, RELEASES), "/blog");
	});

	it("takes only a path on this site from the index", () => {
		const odd = { "1.0.0-firefox": "https://elsewhere.example/" };
		assert.equal(
			whatsNewLocation("firefox", "1.0.0", odd, RELEASES),
			`${RELEASES}/tag/1.0.0-firefox`,
		);
	});
});
