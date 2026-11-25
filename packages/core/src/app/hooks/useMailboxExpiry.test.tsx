/** @vitest-environment happy-dom */
import { act, cleanup, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type Platform, PlatformProvider } from "../../context/PlatformContext";
import type { Target } from "../../flags";
import { mailboxStatusKey } from "../../sync/mailbox";
import { accountKeyOf } from "../../sync/mailbox/protocol";
import { useMailboxExpiry } from "./useMailboxExpiry";

const DAY = 86_400_000;
const NUMBER = "1234567890123456789012345";

const prefs = vi.hoisted(() => ({
	value: {} as Record<string, unknown>,
	update: vi.fn(async () => {}),
}));
vi.mock("../../hooks/usePrefs", () => ({
	usePrefs: () => ({ prefs: prefs.value, loaded: true, update: prefs.update }),
}));
// A stand-in for the real SHA-256, which isn't a microtask: with it, one tick settles every read the
// hook makes, however loaded the machine is.
vi.mock("../../sync/mailbox/protocol", async (load) => ({
	...(await load<typeof import("../../sync/mailbox/protocol")>()),
	accountKeyOf: async (number: string) => `key:${number}`,
}));
vi.mock("../../hooks/useVaultRegistry", () => ({
	useVaultRegistry: () => ({ activeId: "v1", vaults: [{ id: "v1" }], ready: true }),
}));

afterEach(() => {
	cleanup();
	prefs.update.mockClear();
});

interface Setup {
	left?: number;
	/** Overrides `left` with a fixed end. */
	paidThrough?: number;
	target?: Target;
	mailbox?: unknown;
	mailboxOff?: boolean;
	frozen?: boolean;
	readFor?: string;
	status?: string;
	store?: Map<string, unknown>;
}

/** Every pending read done: the storage and the key are microtasks, which a macrotask drains. */
const settle = () => act(() => new Promise<void>((resolve) => setTimeout(resolve, 0)));

async function mount({
	left = 10 * DAY,
	paidThrough,
	target = "chromium",
	mailbox = { kind: "hosted" },
	mailboxOff = false,
	frozen = false,
	readFor = NUMBER,
	status = "synced",
	store = new Map(),
}: Setup = {}) {
	prefs.value = { mailbox, mailboxOff, mailboxAccount: NUMBER };
	const now = Date.now();
	store.set(mailboxStatusKey("v1"), {
		status,
		at: now,
		account: {
			paidThrough: paidThrough ?? now + left,
			frozen,
			usedBytes: 0,
			quotaBytes: 1e9,
			at: now,
			key: await accountKeyOf(readFor),
		},
	});
	const storage = {
		getMeta: vi.fn(async (k: string) => store.get(k)),
		setMeta: vi.fn(async (k: string, v: unknown) => void store.set(k, v)),
	};
	const platform = { storage, target } as unknown as Platform;
	const wrapper = ({ children }: { children: ReactNode }) => (
		<PlatformProvider platform={platform}>{children}</PlatformProvider>
	);
	const hook = renderHook(() => useMailboxExpiry(), { wrapper });
	await settle();
	return { hook, store };
}

describe("useMailboxExpiry", () => {
	it("offers the card from two weeks out, with where to buy", async () => {
		const { hook } = await mount();
		expect(hook.result.current?.stage).toBe("ending");
		expect(hook.result.current?.buyUrl).toContain("/account");
		cleanup();
		const later = await mount({ left: 20 * DAY });
		expect(later.hook.result.current).toBeNull();
	});

	it("once the time has ended, can't be closed", async () => {
		const { hook } = await mount({ left: -DAY });
		expect(hook.result.current?.stage).toBe("ended");
		expect(hook.result.current?.onClose).toBeUndefined();
	});

	it("offers no way to buy on iOS", async () => {
		const { hook } = await mount({ target: "ios" });
		expect(hook.result.current?.stage).toBe("ending");
		expect(hook.result.current?.buyUrl).toBeNull();
	});

	it("stays away where it doesn't apply", async () => {
		const cases: Setup[] = [
			{ mailboxOff: true },
			{ mailbox: null },
			{ mailbox: { kind: "custom", url: "https://mailbox.example.com" } },
			{ frozen: true },
			{ readFor: "9999999999999999999999999" },
			{ status: "other_vault" },
			{ status: "off" },
		];
		for (const setup of cases) {
			const { hook } = await mount(setup);
			expect([setup, hook.result.current]).toEqual([setup, null]);
			cleanup();
		}
	});

	it("closed, stays closed on this device until more time is bought", async () => {
		const store = new Map<string, unknown>();
		const ends = Date.now() + 10 * DAY;
		const first = await mount({ store, paidThrough: ends });
		await act(async () => first.hook.result.current?.onClose?.());
		await settle();
		expect(first.hook.result.current).toBeNull();
		cleanup();
		const next = await mount({ store, paidThrough: ends });
		expect(next.hook.result.current).toBeNull();
		cleanup();
		// More time bought, but still inside two weeks: a new date, so it shows.
		const moved = await mount({ store, paidThrough: ends + DAY });
		expect(moved.hook.result.current?.stage).toBe("ending");
	});

	it("stopping turns the mailbox off for the group", async () => {
		const { hook } = await mount();
		await act(async () => hook.result.current?.onStop());
		expect(prefs.update).toHaveBeenCalledWith("mailbox", null);
	});
});
