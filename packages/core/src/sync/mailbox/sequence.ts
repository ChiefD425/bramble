// Per-sender sequence tracking (docs/mailbox-service.md, "Gaps and self-healing"): the highest
// contiguous number merged from each sender, and what arrived past it. A number still missing
// once the inbox is drained is a gap the recipient asks a snapshot to heal.

import type { SenderTrack, SnapshotParts } from "./state";

function advance(t: SenderTrack): SenderTrack {
	const above = new Set(t.above);
	let through = t.through;
	while (above.has(through + 1)) {
		through++;
		above.delete(through);
	}
	return { epoch: t.epoch, through, above: [...above].sort((a, b) => a - b) };
}

/** An unknown sender or a new epoch starts just below this number: the catch-up covers earlier. */
export function recordDelta(
	track: SenderTrack | undefined,
	epoch: string,
	seq: number,
): SenderTrack {
	const base = track?.epoch === epoch ? track : { epoch, through: seq - 1, above: [] };
	if (seq <= base.through || base.above.includes(seq)) return base;
	return advance({ ...base, above: [...base.above, seq] });
}

export function recordSnapshot(
	track: SenderTrack | undefined,
	epoch: string,
	seq: number,
): SenderTrack {
	const base = track?.epoch === epoch ? track : { epoch, through: seq, above: [] };
	const through = Math.max(base.through, seq);
	return advance({ epoch, through, above: base.above.filter((n) => n > through) });
}

export const hasGap = (track: SenderTrack | undefined): boolean => (track?.above.length ?? 0) > 0;

/** Count a snapshot part; `complete` once every part of that (epoch, seq) arrived. */
export function recordPart(
	pending: SnapshotParts | undefined,
	p: { epoch: string; seq: number; part: number; parts: number },
): { pending: SnapshotParts | undefined; complete: boolean } {
	const same = pending?.epoch === p.epoch && pending.seq === p.seq && pending.parts === p.parts;
	const got = new Set(same ? pending.got : []);
	if (p.part <= p.parts) got.add(p.part);
	for (let k = 1; k <= p.parts; k++) {
		if (!got.has(k)) {
			const sorted = [...got].sort((a, b) => a - b);
			return {
				pending: { epoch: p.epoch, seq: p.seq, parts: p.parts, got: sorted },
				complete: false,
			};
		}
	}
	return { pending: undefined, complete: true };
}
