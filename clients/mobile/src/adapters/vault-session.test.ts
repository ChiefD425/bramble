import { describe, expect, it, vi } from "vitest";

const { lock } = vi.hoisted(() => ({ lock: vi.fn(async () => {}) }));

vi.mock("@capacitor/core", () => ({ Capacitor: { isNativePlatform: () => true } }));
vi.mock("../native-crypto", () => ({ loadNativeCrypto: async () => ({ lock }) }));
vi.mock("../wasm-loader", () => ({ loadWasm: async () => ({ lock }) }));

const { lockForLifecycle, markLocked, onExternalLock, onVaultStateChange } = await import(
	"./vault-session"
);

// Autofill tells the two apart: an auto-lock leaves its own timer running, any other lock ends it.
describe("lock cause", () => {
	it("reports an auto-lock as auto and every other lock as user", async () => {
		const seen: unknown[] = [];
		const stop = onVaultStateChange((locked, cause) => seen.push([locked, cause]));
		await lockForLifecycle("away");
		markLocked();
		stop();
		expect(lock).toHaveBeenCalledTimes(1);
		expect(seen).toEqual([
			[true, "auto"],
			[true, "user"],
		]);
	});

	// The app's own unlock screen tells them apart: leaving the app returns to the screen it left.
	it("hands the UI the cause of an auto-lock", async () => {
		const seen: unknown[] = [];
		const stop = onExternalLock((cause) => seen.push(cause));
		await lockForLifecycle("away");
		await lockForLifecycle("idle");
		stop();
		expect(seen).toEqual(["away", "idle"]);
	});
});
