// node --test scripts/deb-reproducible.test.ts

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { installedSize, sortedMd5sums, withInstalledSize } from "./deb-reproducible.ts";

describe("installedSize", () => {
	it("rounds each file up to a KiB and counts dirs and links as one", () => {
		assert.equal(
			installedSize([
				{ kind: "file", size: 1 },
				{ kind: "file", size: 1024 },
				{ kind: "file", size: 1025 },
				{ kind: "dir", size: 4096 },
				{ kind: "link", size: 0 },
			]),
			1 + 1 + 2 + 1 + 1,
		);
	});

	it("does not depend on what the file system says a directory weighs", () => {
		assert.equal(
			installedSize([{ kind: "dir", size: 4096 }]),
			installedSize([{ kind: "dir", size: 96 }]),
		);
	});
});

describe("withInstalledSize", () => {
	it("replaces the field and nothing else", () => {
		const control = "Package: bramble\nVersion: 1.0\nInstalled-Size: 37519\nArchitecture: arm64\n";
		assert.equal(
			withInstalledSize(control, 37000),
			"Package: bramble\nVersion: 1.0\nInstalled-Size: 37000\nArchitecture: arm64\n",
		);
	});

	it("refuses a control file without one", () => {
		assert.throws(() => withInstalledSize("Package: bramble\n", 1));
	});
});

describe("sortedMd5sums", () => {
	it("sorts by path, whatever order the file system listed them in", () => {
		const a = "bb  usr/bin/bramble-proxy\naa  usr/bin/bramble-desktop\ncc  usr/share/x\n";
		const b = "cc  usr/share/x\nbb  usr/bin/bramble-proxy\naa  usr/bin/bramble-desktop\n";
		assert.equal(sortedMd5sums(a), sortedMd5sums(b));
		assert.equal(
			sortedMd5sums(a),
			"aa  usr/bin/bramble-desktop\nbb  usr/bin/bramble-proxy\ncc  usr/share/x\n",
		);
	});
});
