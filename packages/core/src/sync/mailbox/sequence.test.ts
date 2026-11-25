import { describe, expect, it } from "vitest";
import { hasGap, recordDelta, recordPart, recordSnapshot } from "./sequence";

const E = "E".repeat(22);
const F = "F".repeat(22);

describe("sequence tracking", () => {
	it("the first delta sets the baseline", () => {
		expect(recordDelta(undefined, E, 40)).toEqual({ epoch: E, through: 40, above: [] });
	});

	it("a skipped number is a gap until it arrives", () => {
		let t = recordDelta(recordDelta(recordDelta(undefined, E, 1), E, 2), E, 4);
		expect(t).toEqual({ epoch: E, through: 2, above: [4] });
		expect(hasGap(t)).toBe(true);
		t = recordDelta(t, E, 3);
		expect(t).toEqual({ epoch: E, through: 4, above: [] });
		expect(hasGap(t)).toBe(false);
	});

	it("a repeat or older number changes nothing", () => {
		const t = { epoch: E, through: 5, above: [7] };
		expect(recordDelta(t, E, 5)).toEqual(t);
		expect(recordDelta(t, E, 2)).toEqual(t);
		expect(recordDelta(t, E, 7)).toEqual(t);
	});

	it("a new epoch starts over", () => {
		expect(recordDelta({ epoch: E, through: 9, above: [12] }, F, 3)).toEqual({
			epoch: F,
			through: 3,
			above: [],
		});
	});

	it("a snapshot covers through its number", () => {
		expect(recordSnapshot({ epoch: E, through: 2, above: [5] }, E, 6)).toEqual({
			epoch: E,
			through: 6,
			above: [],
		});
		expect(recordSnapshot(undefined, E, 9)).toEqual({ epoch: E, through: 9, above: [] });
	});

	it("a snapshot below the gap keeps it", () => {
		const t = recordSnapshot({ epoch: E, through: 2, above: [5] }, E, 3);
		expect(t).toEqual({ epoch: E, through: 3, above: [5] });
		expect(hasGap(t)).toBe(true);
	});

	it("a split snapshot completes only when every part arrived", () => {
		const p = { epoch: E, seq: 4, parts: 3 };
		let r = recordPart(undefined, { ...p, part: 2 });
		expect(r.complete).toBe(false);
		r = recordPart(r.pending, { ...p, part: 2 });
		r = recordPart(r.pending, { ...p, part: 1 });
		expect(r.complete).toBe(false);
		r = recordPart(r.pending, { ...p, part: 3 });
		expect(r).toEqual({ pending: undefined, complete: true });
		expect(recordPart(undefined, { ...p, part: 1, parts: 1 }).complete).toBe(true);
		const other = recordPart({ epoch: E, seq: 3, parts: 2, got: [1] }, { ...p, part: 1 });
		expect(other.pending?.got).toEqual([1]);
		expect(other.pending?.seq).toBe(4);
	});
});
