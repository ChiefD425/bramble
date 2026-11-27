// node --test scripts/pe-normalize.test.ts

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { hasAuthenticode, stripAuthenticode } from "./pe-normalize.ts";
import { SECURITY, sign, unsigned } from "./pe-test-fixtures.ts";

describe("stripAuthenticode", () => {
	it("makes a signed file and its unsigned original equal", () => {
		for (const length of [0x400, 0x403, 0x407]) {
			const pe = unsigned(length);
			assert.deepEqual(stripAuthenticode(sign(pe)), stripAuthenticode(pe));
		}
	});

	it("still sees a change to the signed bytes", () => {
		const pe = unsigned(0x400);
		const signed = sign(pe);
		signed[0x300] ^= 1;
		assert.notDeepEqual(stripAuthenticode(signed), stripAuthenticode(pe));
	});

	it("refuses a table that is not at the end, and what is not a PE file", () => {
		const signed = sign(unsigned(0x400));
		signed.writeUInt32LE(0x200, SECURITY);
		assert.throws(() => stripAuthenticode(signed), /not at the end/);
		assert.throws(() => stripAuthenticode(Buffer.alloc(0x200)), /not a PE/);
	});
});

describe("hasAuthenticode", () => {
	it("tells a signed file from an unsigned one", () => {
		const pe = unsigned(0x400);
		assert.equal(hasAuthenticode(pe), false);
		assert.equal(hasAuthenticode(sign(pe)), true);
		assert.throws(() => hasAuthenticode(Buffer.from("not an exe")), /not a PE/);
	});
});
