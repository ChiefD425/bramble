// Minimal PE32+ images for the tests of pe-normalize.ts and windows-sign-handoff.ts.

const HEADER = 0x80;
const OPTIONAL = HEADER + 24;
export const SECURITY = OPTIONAL + 112 + 4 * 8;

/** A minimal PE32+ image of `length` bytes, the body filled with a pattern seeded by `seed`. */
export function unsigned(length: number, seed = 7): Buffer {
	const pe = Buffer.alloc(length);
	for (let i = 0x200; i < length; i++) pe[i] = (i * seed) & 0xff || 1;
	pe.writeUInt16LE(0x5a4d, 0);
	pe.writeUInt32LE(HEADER, 0x3c);
	pe.writeUInt32LE(0x00004550, HEADER);
	pe.writeUInt16LE(0x20b, OPTIONAL);
	pe.writeUInt32LE(0x1234, OPTIONAL + 64);
	return pe;
}

/** What signing does: pad to 8, append a table, point the security entry at it, new checksum. */
export function sign(pe: Buffer): Buffer {
	const padded = Buffer.alloc(Math.ceil(pe.length / 8) * 8);
	pe.copy(padded);
	const table = Buffer.alloc(1032, 0xab);
	const out = Buffer.concat([padded, table]);
	out.writeUInt32LE(padded.length, SECURITY);
	out.writeUInt32LE(table.length, SECURITY + 4);
	out.writeUInt32LE(0xbeef, OPTIONAL + 64);
	return out;
}
