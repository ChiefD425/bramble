// What is left to compare in a Windows PE file once its Authenticode signature is off
// (docs/reproducible-builds.md). Signing appends a certificate table, pointed at by the security
// entry of the data directories, pads the file to 8 bytes before it, and rewrites the header
// checksum. So: cut the file at the table, pad to 8 bytes as signing does, and zero the checksum
// and the security entry. An unsigned file goes through the same steps and must come out identical.

const IMAGE_DIRECTORY_ENTRY_SECURITY = 4;

/** Where the optional header and the security directory entry sit. */
function locate(pe: Buffer): { optional: number; security: number } {
	if (pe.length < 0x40 || pe.readUInt16LE(0) !== 0x5a4d) throw new Error("not a PE file (no MZ)");
	const header = pe.readUInt32LE(0x3c);
	if (header + 24 > pe.length || pe.readUInt32LE(header) !== 0x00004550)
		throw new Error("not a PE file (no PE signature)");
	const optional = header + 24;
	const magic = pe.readUInt16LE(optional);
	const directories = optional + (magic === 0x20b ? 112 : magic === 0x10b ? 96 : -1);
	if (directories < optional)
		throw new Error(`unknown optional header magic ${magic.toString(16)}`);
	return { optional, security: directories + IMAGE_DIRECTORY_ENTRY_SECURITY * 8 };
}

/** Whether the file carries a certificate table, signed by anyone. */
export function hasAuthenticode(pe: Buffer): boolean {
	const { security } = locate(pe);
	return pe.readUInt32LE(security) !== 0 && pe.readUInt32LE(security + 4) !== 0;
}

export function stripAuthenticode(pe: Buffer): Buffer {
	const { optional, security } = locate(pe);
	const tableAt = pe.readUInt32LE(security);
	const tableSize = pe.readUInt32LE(security + 4);

	let end = pe.length;
	if (tableAt !== 0) {
		if (tableAt + tableSize !== pe.length)
			throw new Error("the certificate table is not at the end of the file");
		end = tableAt;
	}
	// Signing pads the file with zeros to a multiple of 8 before the table; pad an unsigned one the
	// same way, since those zeros cannot be told apart from the file's own.
	const out = Buffer.alloc(Math.ceil(end / 8) * 8);
	pe.copy(out, 0, 0, end);
	out.writeUInt32LE(0, optional + 64); // CheckSum
	out.writeUInt32LE(0, security);
	out.writeUInt32LE(0, security + 4);
	return out;
}
