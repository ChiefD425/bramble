// node --test scripts/verify-release.test.ts

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	canonicalManifest,
	compareTrees,
	crxZip,
	inReleaseZip,
	parseTag,
	storeAdded,
} from "./verify-release.ts";

describe("parseTag", () => {
	it("reads the version and target of an extension tag", () => {
		assert.deepEqual(parseTag("1.37.0-firefox"), { version: "1.37.0", target: "firefox" });
		assert.deepEqual(parseTag("1.40.0-chromium"), { version: "1.40.0", target: "chromium" });
	});

	it("refuses tags that are not extension releases", () => {
		assert.throws(() => parseTag("0.19.0-desktop"));
		assert.throws(() => parseTag("1.37.0-firefox-rc"));
	});
});

describe("compareTrees", () => {
	it("is empty when both trees hold the same bytes", () => {
		const tree = new Map([
			["a.js", "1"],
			["wasm/x.wasm", "2"],
		]);
		assert.deepEqual(compareTrees(tree, new Map(tree)), []);
	});

	it("names files missing, extra, and different", () => {
		const rebuilt = new Map([
			["a.js", "1"],
			["b.js", "2"],
		]);
		const published = new Map([
			["a.js", "X"],
			["c.js", "3"],
		]);
		assert.deepEqual(compareTrees(rebuilt, published), [
			{ path: "a.js", problem: "differs" },
			{ path: "b.js", problem: "missing" },
			{ path: "c.js", problem: "extra" },
		]);
	});
});

describe("what each published copy leaves out or adds", () => {
	it("leaves the zip's exclusions out of the zip comparison", () => {
		assert.equal(inReleaseZip("wasm/vault_crypto.d.ts"), false);
		assert.equal(inReleaseZip("wasm/package.json"), false);
		assert.equal(inReleaseZip("wasm/.gitignore"), false);
		assert.equal(inReleaseZip("wasm/vault_crypto_bg.wasm"), true);
		assert.equal(inReleaseZip("package.json"), true);
	});

	it("allows only the stores' own signature folders", () => {
		assert.equal(storeAdded("META-INF/cose.sig"), true);
		assert.equal(storeAdded("_metadata/verified_contents.json"), true);
		assert.equal(storeAdded("background.js"), false);
	});
});

describe("canonicalManifest", () => {
	it("ignores formatting and the Chrome Web Store's update_url", () => {
		const ours = Buffer.from('{\n\t"version": "1.0.0",\n\t"name": "Bramble"\n}\n');
		const store = Buffer.from(
			'{"name":"Bramble","update_url":"https://clients2.google.com/service/update2/crx","version":"1.0.0"}',
		);
		assert.equal(canonicalManifest(ours), canonicalManifest(store));
	});

	it("still sees any other change", () => {
		const ours = Buffer.from('{"version":"1.0.0","permissions":["storage"]}');
		const store = Buffer.from('{"version":"1.0.0","permissions":["storage","tabs"]}');
		assert.notEqual(canonicalManifest(ours), canonicalManifest(store));
	});
});

describe("crxZip", () => {
	it("returns the zip after a CRX3 header", () => {
		const header = Buffer.from("proto-header");
		const zip = Buffer.from("PK\u0003\u0004rest");
		const prefix = Buffer.alloc(12);
		prefix.write("Cr24", 0, "latin1");
		prefix.writeUInt32LE(3, 4);
		prefix.writeUInt32LE(header.length, 8);
		assert.deepEqual(crxZip(Buffer.concat([prefix, header, zip])), zip);
	});

	it("refuses anything that is not CRX3", () => {
		assert.throws(() => crxZip(Buffer.from("PK\u0003\u0004")));
		const v2 = Buffer.alloc(12);
		v2.write("Cr24", 0, "latin1");
		v2.writeUInt32LE(2, 4);
		assert.throws(() => crxZip(v2));
	});
});
