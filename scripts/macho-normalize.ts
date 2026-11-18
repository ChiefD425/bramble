// What is left to compare in a Mach-O binary once its code signature is removed
// (docs/reproducible-builds.md). A released app is signed with Developer ID and a rebuild only
// carries the linker's ad hoc signature; `codesign --remove-signature` takes either away, but leaves
// __LINKEDIT's vmsize as large as the signer made it. So that one field is zeroed on both sides,
// in every slice of a universal binary, and everything else must match.

const FAT_MAGIC = 0xcafebabe;
const MH_MAGIC_64 = 0xfeedfacf;
const LC_SEGMENT_64 = 0x19;

/** A copy of `binary` with each slice's __LINKEDIT vmsize set to zero. Throws on anything else. */
export function zeroLinkeditVmsize(binary: Buffer): Buffer {
	const out = Buffer.from(binary);
	const slices: number[] = [];
	if (out.readUInt32BE(0) === FAT_MAGIC) {
		const count = out.readUInt32BE(4);
		for (let i = 0; i < count; i++) slices.push(out.readUInt32BE(8 + i * 20 + 8));
	} else slices.push(0);
	for (const at of slices) {
		if (out.readUInt32LE(at) !== MH_MAGIC_64) throw new Error("not a 64-bit Mach-O slice");
		const commands = out.readUInt32LE(at + 16);
		let cmd = at + 32;
		let found = false;
		for (let i = 0; i < commands; i++) {
			const kind = out.readUInt32LE(cmd);
			const size = out.readUInt32LE(cmd + 4);
			const name = out
				.subarray(cmd + 8, cmd + 24)
				.toString("latin1")
				.replace(/\0+$/, "");
			if (kind === LC_SEGMENT_64 && name === "__LINKEDIT") {
				out.writeBigUInt64LE(0n, cmd + 32);
				found = true;
			}
			cmd += size;
		}
		if (!found) throw new Error("a slice has no __LINKEDIT segment");
	}
	return out;
}
