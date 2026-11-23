import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { written, meta } = vi.hoisted(() => ({
	written: [] as string[],
	meta: new Map<string, unknown>(),
}));

vi.mock("@capacitor/clipboard", () => ({
	Clipboard: {
		write: vi.fn(async ({ string }: { string: string }) => {
			written.push(string);
		}),
	},
}));
vi.mock("./storage", () => ({
	mobileStorage: { getMeta: async (k: string) => meta.get(k) },
}));

const { mobileClipboard } = await import("./clipboard");

beforeEach(() => {
	vi.useFakeTimers();
	written.length = 0;
	meta.clear();
});
afterEach(() => vi.useRealTimers());

// Settings' "Clipboard auto-clear" was shown on phones but a fixed 30 s applied regardless.
describe("clipboard auto-clear", () => {
	it("clears after the time chosen in Settings", async () => {
		meta.set("pref.clipboardClearSeconds", 60);
		await mobileClipboard.copy("s3cret");
		await vi.advanceTimersByTimeAsync(30_000);
		expect(written).toEqual(["s3cret"]);
		await vi.advanceTimersByTimeAsync(30_000);
		expect(written).toEqual(["s3cret", ""]);
	});

	it("falls back to 30 seconds when nothing is chosen", async () => {
		await mobileClipboard.copy("s3cret");
		await vi.advanceTimersByTimeAsync(30_000);
		expect(written).toEqual(["s3cret", ""]);
	});

	it("leaves a newer copy alone until its own time is up", async () => {
		meta.set("pref.clipboardClearSeconds", 60);
		await mobileClipboard.copy("first");
		await vi.advanceTimersByTimeAsync(45_000);
		await mobileClipboard.copy("second");
		await vi.advanceTimersByTimeAsync(45_000);
		expect(written).toEqual(["first", "second"]);
		await vi.advanceTimersByTimeAsync(15_000);
		expect(written).toEqual(["first", "second", ""]);
	});
});
