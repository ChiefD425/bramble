// node --test scripts/macho-normalize.test.ts

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { zeroLinkeditVmsize } from "./macho-normalize.ts";

/** A minimal 64-bit Mach-O: a header and two segment commands, __TEXT and __LINKEDIT. */
function slice(linkeditVmsize: bigint): Buffer {
	const header = Buffer.alloc(32);
	header.writeUInt32LE(0xfeedfacf, 0);
	header.writeUInt32LE(2, 16);
	const segment = (name: string, vmsize: bigint) => {
		const cmd = Buffer.alloc(72);
		cmd.writeUInt32LE(0x19, 0);
		cmd.writeUInt32LE(72, 4);
		cmd.write(name, 8, "latin1");
		cmd.writeBigUInt64LE(vmsize, 32);
		return cmd;
	};
	return Buffer.concat([header, segment("__TEXT", 0x4000n), segment("__LINKEDIT", linkeditVmsize)]);
}

function fat(...slices: Buffer[]): Buffer {
	const head = Buffer.alloc(8 + slices.length * 20);
	head.writeUInt32BE(0xcafebabe, 0);
	head.writeUInt32BE(slices.length, 4);
	let offset = 4096;
	const body: Buffer[] = [];
	for (const [i, s] of slices.entries()) {
		head.writeUInt32BE(offset, 8 + i * 20 + 8);
		head.writeUInt32BE(s.length, 8 + i * 20 + 12);
		body.push(s, Buffer.alloc(4096 - s.length));
		offset += 4096;
	}
	return Buffer.concat([head, Buffer.alloc(4096 - head.length), ...body]);
}

describe("zeroLinkeditVmsize", () => {
	it("makes binaries that differ only in __LINKEDIT's vmsize equal, thin or universal", () => {
		assert.deepEqual(zeroLinkeditVmsize(slice(0x474000n)), zeroLinkeditVmsize(slice(0x458000n)));
		assert.deepEqual(
			zeroLinkeditVmsize(fat(slice(0x474000n), slice(0x10000n))),
			zeroLinkeditVmsize(fat(slice(0x458000n), slice(0x20000n))),
		);
	});

	it("leaves every other field alone", () => {
		const a = slice(0x474000n);
		const b = Buffer.from(a);
		b.writeBigUInt64LE(0x8000n, 32 + 32); // __TEXT's vmsize
		assert.notDeepEqual(zeroLinkeditVmsize(a), zeroLinkeditVmsize(b));
	});

	it("does not touch the input", () => {
		const a = slice(0x474000n);
		zeroLinkeditVmsize(a);
		assert.equal(a.readBigUInt64LE(32 + 72 + 32), 0x474000n);
	});

	it("refuses what is not a 64-bit Mach-O", () => {
		assert.throws(() => zeroLinkeditVmsize(Buffer.alloc(64)));
	});
});
