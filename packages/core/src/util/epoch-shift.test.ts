import { describe, expect, it } from "vitest";
import { APPLE_EPOCH_OFFSET_MS, undoEpochShift } from "./epoch-shift";

const NOW = Date.UTC(2026, 10, 16);
const HOUR = 3_600_000;

describe("undoEpochShift", () => {
	it("pulls a date counted from 2001 back to the real one", () => {
		const real = Date.UTC(2012, 4, 5, 15, 40);
		expect(new Date(real + APPLE_EPOCH_OFFSET_MS).getUTCFullYear()).toBe(2043);
		expect(undoEpochShift(real + APPLE_EPOCH_OFFSET_MS, NOW)).toBe(real);
	});

	it("leaves a past date alone", () => {
		const real = Date.UTC(2024, 1, 6);
		expect(undoEpochShift(real, NOW)).toBe(real);
	});

	it("allows a clock a few hours fast", () => {
		expect(undoEpochShift(NOW + 5 * HOUR, NOW)).toBe(NOW + 5 * HOUR);
	});

	it("leaves a future date that the offset doesn't explain", () => {
		const far = NOW + 2 * APPLE_EPOCH_OFFSET_MS;
		expect(undoEpochShift(far, NOW)).toBe(far);
	});
});
