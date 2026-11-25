// Closed deltas (docs/mailbox-service.md, "Messages"): for every entry a post touches, everything
// this device holds for it, so merging a run of deltas reaches the same state as merging the
// whole. Records are grouped per entry id, per file id (what no entry claims) and per setting.

import type { EncryptedEntry } from "../../vault-format";
import { causalKey } from "../causal";
import type { EntriesPayload, FileRecord, Tombstone } from "../entries-payload";
import { formatHlc } from "../hlc";
import { LIMITS } from "./limits";
import { sha256Hex } from "./protocol";

/** Per closure group, a fingerprint of what this device held for it when it last posted. */
export type PostedIndex = Record<string, string>;

interface Group {
	lines: string[];
	entries: EncryptedEntry[];
	conflicts: EncryptedEntry[];
	tombstones: Tombstone[];
	files: FileRecord[];
	fileTombstones: Tombstone[];
	fileCascades: Tombstone[];
	settings: NonNullable<EntriesPayload["settings"]>;
}

function groupsOf(payload: EntriesPayload): Map<string, Group> {
	const groups = new Map<string, Group>();
	const at = (key: string): Group => {
		let g = groups.get(key);
		if (!g) {
			g = {
				lines: [],
				entries: [],
				conflicts: [],
				tombstones: [],
				files: [],
				fileTombstones: [],
				fileCascades: [],
				settings: {},
			};
			groups.set(key, g);
		}
		return g;
	};
	for (const e of payload.entries) {
		const g = at(`e:${e.id}`);
		g.entries.push(e);
		g.lines.push(`e|${causalKey(e)}`);
	}
	for (const e of payload.conflicts ?? []) {
		const g = at(`e:${e.id}`);
		g.conflicts.push(e);
		g.lines.push(`c|${causalKey(e)}`);
	}
	for (const t of payload.tombstones) {
		const g = at(`e:${t.id}`);
		g.tombstones.push(t);
		g.lines.push(`t|${causalKey(t)}`);
	}
	const owner = new Map<string, string>();
	for (const f of payload.files ?? []) {
		const key = f.entryId === undefined ? `f:${f.id}` : `e:${f.entryId}`;
		owner.set(f.id, key);
		const g = at(key);
		g.files.push(f);
		g.lines.push(`f|${f.id}|${formatHlc(f.hlc)}|${f.hash}|${f.metaBlob}`);
	}
	for (const t of payload.fileTombstones ?? []) {
		const g = at(`f:${t.id}`);
		g.fileTombstones.push(t);
		g.lines.push(`ft|${t.id}|${causalKey(t)}`);
	}
	for (const c of payload.fileCascades ?? []) {
		const g = at(owner.get(c.id) ?? `f:${c.id}`);
		g.fileCascades.push(c);
		g.lines.push(`fc|${c.id}|${causalKey(c)}`);
	}
	for (const [key, record] of Object.entries(payload.settings ?? {})) {
		const g = at(`s:${key}`);
		g.settings[key] = record;
		g.lines.push(`s|${JSON.stringify(record)}`);
	}
	return groups;
}

const fingerprint = async (g: Group) => (await sha256Hex(g.lines.sort().join("\n"))).slice(0, 32);
const sizeOf = (p: EntriesPayload) => new TextEncoder().encode(JSON.stringify(p)).length;

/** One payload from several groups; optional fields only when non-empty, as a merge writes them. */
function toPayload(groups: Group[]): EntriesPayload {
	const all = <T>(get: (g: Group) => T[]) => groups.flatMap(get);
	const out: EntriesPayload = {
		entries: all((g) => g.entries),
		tombstones: all((g) => g.tombstones),
	};
	const conflicts = all((g) => g.conflicts);
	const files = all((g) => g.files);
	const fileTombstones = all((g) => g.fileTombstones);
	const fileCascades = all((g) => g.fileCascades);
	const settings = Object.assign({}, ...groups.map((g) => g.settings));
	if (conflicts.length > 0) out.conflicts = conflicts;
	if (files.length > 0) out.files = files;
	if (fileTombstones.length > 0) out.fileTombstones = fileTombstones;
	if (fileCascades.length > 0) out.fileCascades = fileCascades;
	if (Object.keys(settings).length > 0) out.settings = settings;
	return out;
}

/**
 * The groups whose fingerprint differs from `posted`, packed into closed parts, and the index to
 * keep once they are posted. Nothing changed: `parts` is empty. A snapshot is
 * `cutDelta(payload, {})`.
 */
export async function cutDelta(
	payload: EntriesPayload,
	posted: PostedIndex,
	budget: number = LIMITS.partBudget,
): Promise<{ parts: EntriesPayload[]; index: PostedIndex }> {
	const groups = groupsOf(payload);
	const index: PostedIndex = {};
	for (const [key, g] of groups) index[key] = await fingerprint(g);

	const parts: EntriesPayload[] = [];
	let pending: Group[] = [];
	let pendingBytes = 0;
	for (const key of [...groups.keys()].sort()) {
		if (posted[key] === index[key]) continue;
		const group = groups.get(key) as Group;
		const bytes = sizeOf(toPayload([group]));
		if (bytes > budget) throw new Error("one entry's history is larger than a mailbox message");
		// Each group's own encoding bounds its share of the joined part, so the sum is a safe bound.
		if (pendingBytes + bytes > budget) {
			parts.push(toPayload(pending));
			pending = [];
			pendingBytes = 0;
		}
		pending.push(group);
		pendingBytes += bytes;
	}
	if (pending.length > 0) parts.push(toPayload(pending));
	return { parts, index };
}
