/** @vitest-environment happy-dom */
import { act, cleanup } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Platform } from "../context/PlatformContext";
import { mountVaultActions } from "../test/vault-harness";
import { VAULT_REGISTRY_KEY } from "../vault/vault-registry";

afterEach(cleanup);

// Issue #27, the biometric path: loading the VEK fires mobile's unlock signal, and sync (P2P and
// the mailbox) follows whichever vault is RECORDED active then. Opening a second vault with Face
// ID must record it first, as the password, security-key and recovery paths do, or sync follows
// the previous vault while this vault's key is loaded.
describe("biometric unlock records the active vault before loading its key", () => {
	it("calls setActiveVault(id) before the VEK is unwrapped", async () => {
		const order: string[] = [];
		const registry = { vaults: [{ id: "v1", label: "", createdAt: 1 }] };
		const platform = {
			storage: {
				hasVaultHandle: vi.fn(async () => false),
				getMeta: vi.fn(async (k: string) => (k === VAULT_REGISTRY_KEY ? registry : undefined)),
				setMeta: vi.fn(async () => {}),
				readVaultBlob: vi.fn(async () => new Uint8Array()),
				writeVaultBlob: vi.fn(async () => {}),
			},
			crypto: {
				isLocked: vi.fn(async () => true),
				onExternalLock: vi.fn(() => () => {}),
				onExternalChange: vi.fn(() => () => {}),
				// Rejects to stop the unlock once the key would have loaded.
				unlockWithVek: vi.fn(async () => {
					order.push("unlockWithVek");
					throw new Error("stop after the key loads");
				}),
			},
			biometric: {
				unlock: vi.fn(async () => {
					order.push("biometric.unlock");
					return "vek";
				}),
				isEnabled: vi.fn(async () => true),
				isAvailable: vi.fn(async () => ({ available: true })),
				disable: vi.fn(async () => {}),
			},
			autofill: { clearIndex: vi.fn(async () => {}), setIndex: vi.fn(async () => {}) },
			shell: {
				setActiveVault: vi.fn(async (id: string | null) => {
					order.push(`setActiveVault:${id}`);
				}),
				getActiveVault: vi.fn(async () => "v1"),
				flushPendingCornerCapture: vi.fn(async () => {}),
			},
			clipboard: {},
		} as unknown as Platform;
		const getActions = mountVaultActions(platform);
		await act(async () => {});
		order.length = 0;

		await act(async () => {
			await expect(getActions().unlockWithBiometric(false)).rejects.toThrow();
		});

		expect(order.indexOf("setActiveVault:v1")).toBeGreaterThanOrEqual(0);
		expect(order.indexOf("setActiveVault:v1")).toBeLessThan(order.indexOf("unlockWithVek"));
	});
});
