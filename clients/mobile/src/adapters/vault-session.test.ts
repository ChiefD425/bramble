import { describe, expect, it, vi } from "vitest";

const { lock } = vi.hoisted(() => ({ lock: vi.fn(async () => {}) }));

vi.mock("@capacitor/core", () => ({ Capacitor: { isNativePlatform: () => true } }));
vi.mock("../native-crypto", () => ({ loadNativeCrypto: async () => ({ lock }) }));
vi.mock("../wasm-loader", () => ({ loadWasm: async () => ({ lock }) }));

const { lockForLifecycle, markLocked, onVaultStateChange } = await import("./vault-session");

// Autofill tells the two apart: an auto-lock leaves its own timer running, any other lock ends it.
describe("lock cause", () => {
	it("reports an auto-lock as auto and every other lock as user", async () => {
		const seen: unknown[] = [];
		const stop = onVaultStateChange((locked, cause) => seen.push([locked, cause]));
		await lockForLifecycle();
		markLocked();
		stop();
		expect(lock).toHaveBeenCalledTimes(1);
		expect(seen).toEqual([
			[true, "auto"],
			[true, "user"],
		]);
	});
});
