// node --test scripts/pe-normalize.test.ts

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { stripAuthenticode } from "./pe-normalize.ts";

const HEADER = 0x80;
const OPTIONAL = HEADER + 24;
const SECURITY = OPTIONAL + 112 + 4 * 8;

/** A minimal PE32+ image of `length` bytes, the body filled with a pattern. */
function unsigned(length: number): Buffer {
	const pe = Buffer.alloc(length);
	for (let i = 0x200; i < length; i++) pe[i] = (i * 7) & 0xff || 1;
	pe.writeUInt16LE(0x5a4d, 0);
	pe.writeUInt32LE(HEADER, 0x3c);
	pe.writeUInt32LE(0x00004550, HEADER);
	pe.writeUInt16LE(0x20b, OPTIONAL);
	pe.writeUInt32LE(0x1234, OPTIONAL + 64);
	return pe;
}

/** What signing does: pad to 8, append a table, point the security entry at it, new checksum. */
function sign(pe: Buffer): Buffer {
	const padded = Buffer.alloc(Math.ceil(pe.length / 8) * 8);
	pe.copy(padded);
	const table = Buffer.alloc(1032, 0xab);
	const out = Buffer.concat([padded, table]);
	out.writeUInt32LE(padded.length, SECURITY);
	out.writeUInt32LE(table.length, SECURITY + 4);
	out.writeUInt32LE(0xbeef, OPTIONAL + 64);
	return out;
}

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
