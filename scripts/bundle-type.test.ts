// node --test scripts/bundle-type.test.ts

import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { assertBundleType } from "./bundle-type.ts";

describe("assertBundleType", () => {
	const dir = mkdtempSync(join(tmpdir(), "bundle-type-"));
	const binary = (marker: string) => {
		const path = join(dir, marker);
		writeFileSync(
			path,
			Buffer.concat([Buffer.alloc(64, 1), Buffer.from(marker), Buffer.alloc(64)]),
		);
		return path;
	};

	it("accepts the package's own stamp", () => {
		assertBundleType(binary("__TAURI_BUNDLE_TYPE_VAR_DEB"), "DEB");
	});

	it("names the stamp it found instead", () => {
		assert.throws(
			() => assertBundleType(binary("__TAURI_BUNDLE_TYPE_VAR_RPM"), "DEB"),
			/stamped RPM, not DEB/,
		);
		assert.throws(
			() => assertBundleType(binary("__TAURI_BUNDLE_TYPE_VAR_UNK"), "APP"),
			/stamped UNK, not APP/,
		);
	});

	it("cleans up", () => rmSync(dir, { recursive: true, force: true }));
});
