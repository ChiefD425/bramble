import type { PasskeyImportResult } from "../adapters/crypto";
import type { ArchivedAttachment } from "../backup/archive";
import type { RandomAccessSource } from "../backup/zip";
import type { EntryData, EntryType } from "../hooks/useVault";
import type { FileSource, SealedFile } from "../vault/file-mutations";

/** Password managers whose plaintext/container exports Bramble can read. */
export type ImportProvider =
	| "bitwarden"
	| "onepassword"
	| "protonpass"
	| "keepass"
	| "apple"
	| "google"
	| "lastpass"
	| "enpass"
	| "aliasvault"
	| "roboform"
	| "dashlane";

/** Normalized parse result. `imported` is id-less (the vault assigns ids); `warnings` flags lossy mappings. */
export interface ImportResult {
	imported: EntryData[];
	byType: Partial<Record<EntryType, number>>;
	skipped: number;
	warnings: string[];
	/** Files the import brings (KeePass, 1Password and Bramble backups carry them), each on one
	 * of `imported`. */
	attachments?: ImportAttachment[];
	/** What a Bramble backup holds that can't come in: items that wouldn't open, and attachments
	 * that wouldn't open or aren't in the file. Counted so nothing goes missing silently. */
	leftOut?: { items: number; attachments: number };
	/** Items a Bramble backup holds that the vault still has (by id), so they don't come in. */
	alreadyHere?: number;
}

/** A file an import brings, on one of its entries (that entry object, from `imported`), or on
 * an entry the vault already holds (its id; only a Bramble backup of this vault knows those). */
export interface ImportAttachment {
	entry: EntryData | string;
	name: string;
	mime: string;
	source: FileSource | SealedSource;
	size: number;
}

/**
 * A backup's attachment, already sealed under the open vault's key once its file key was moved
 * over: its record's fields, and where its sealed bytes are in the backup. Copied into the
 * vault's store as it is, never opened and sealed again.
 */
export interface SealedSource {
	kind: "sealed";
	sealed: SealedFile;
	archive: RandomAccessSource;
	at: ArchivedAttachment;
}

/** An import's file, placed: on one of the items being imported, or, for an item the vault
 * already holds, on that entry, so re-importing a file brings the attachments a copy lacks. */
export interface PlacedAttachment extends Omit<ImportAttachment, "entry"> {
	onto: { item: EntryData } | { entryId: string };
}

/** Narrow async services available to importers; ordinary parsers ignore this context. */
export interface ImportParserContext {
	passkeyImportPkcs8(pkcs8StandardB64: string): Promise<PasskeyImportResult>;
}

/** String for text formats, bytes for containers. Crypto-backed parsers may be asynchronous. */
export type ImportParser = (
	raw: string | Uint8Array,
	context: ImportParserContext,
) => ImportResult | Promise<ImportResult>;
