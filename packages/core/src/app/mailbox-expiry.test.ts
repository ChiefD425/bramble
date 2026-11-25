import { describe, expect, it } from "vitest";
import { expiryStage } from "./mailbox-expiry";

const DAY = 86_400_000;
const ENDS = Date.UTC(2026, 11, 8);
const at = (daysLeft: number) => ENDS - daysLeft * DAY;

describe("expiryStage", () => {
	it("says nothing until two weeks out", () => {
		expect(expiryStage(ENDS, undefined, at(15))).toBeNull();
		expect(expiryStage(ENDS, undefined, at(14))).toBe("ending");
		expect(expiryStage(ENDS, undefined, at(1))).toBe("ending");
	});

	it("says it has ended from the moment it ends", () => {
		expect(expiryStage(ENDS, undefined, ENDS)).toBe("ended");
		expect(expiryStage(ENDS, undefined, at(-30))).toBe("ended");
	});

	it("says nothing for an account with no paid time yet", () => {
		expect(expiryStage(0, undefined, at(1))).toBeNull();
	});

	it("closed, comes back once from three days out", () => {
		const closed = { paidThrough: ENDS, at: at(10) };
		expect(expiryStage(ENDS, closed, at(5))).toBeNull();
		expect(expiryStage(ENDS, closed, at(3))).toBe("ending");
		const closedAgain = { paidThrough: ENDS, at: at(2) };
		expect(expiryStage(ENDS, closedAgain, at(1))).toBeNull();
	});

	it("can't be closed once ended", () => {
		expect(expiryStage(ENDS, { paidThrough: ENDS, at: at(1) }, at(-1))).toBe("ended");
	});

	it("forgets a close for an earlier end date", () => {
		expect(expiryStage(ENDS, { paidThrough: at(30), at: at(40) }, at(10))).toBe("ending");
	});
});
