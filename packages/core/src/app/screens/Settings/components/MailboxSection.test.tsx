/** @vitest-environment happy-dom */
import { i18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { type Platform, PlatformProvider } from "../../../../context/PlatformContext";
import { SyncedSettingsContext } from "../../../../hooks/synced-settings";
import { PrefsProvider } from "../../../../hooks/usePrefs";
import type { SyncedSettings } from "../../../../sync";
import type { MailboxConfig } from "../../../../sync/mailbox";
import { accountKeyOf, accountPageUrl } from "../../../../sync/mailbox/protocol";
import { MailboxCheckIn, MailboxSection } from "./MailboxSection";

const flags = vi.hoisted(() => ({ hosted: false }));
vi.mock("../../../../flags", async (load) => {
	const real = await load<typeof import("../../../../flags")>();
	return {
		...real,
		can: (cap: Parameters<typeof real.can>[0], target: Parameters<typeof real.can>[1]) =>
			cap === "mailboxHosted" ? flags.hosted : real.can(cap, target),
	};
});
vi.mock("../../../../hooks/useVaultRegistry", () => ({
	useVaultRegistry: () => ({ activeId: "vault-a", vaults: [{ id: "vault-a" }], ready: true }),
}));
vi.mock("../../../../hooks/useVault", () => ({ useVaultState: () => ({ entries: [] }) }));

const CUSTOM: MailboxConfig = { kind: "custom", url: "https://mail.example" };

function mount(
	opts: {
		config?: MailboxConfig;
		account?: string;
		meta?: Record<string, unknown>;
		target?: "chromium" | "ios";
		connected?: boolean;
	} = {},
) {
	const meta = { ...opts.meta };
	const setMeta = vi.fn(async (key: string, value: unknown) => {
		meta[key] = value;
	});
	const copy = vi.fn(async () => {});
	const platform = {
		target: opts.target ?? "chromium",
		clipboard: { copy },
		storage: {
			getMeta: async (key: string) => meta[key],
			setMeta,
			removeMeta: async () => {},
			subscribeMeta: () => () => {},
		},
		shell: {
			mailboxSyncNow: vi.fn(async () => "synced"),
			mailboxMembers: vi.fn(async () => null),
		},
	} as unknown as Platform;
	const hlc = { wall: 1, counter: 0, node: "n" };
	const settings: SyncedSettings = {
		...(opts.config ? { "pref.mailbox": { hlc, value: opts.config } } : {}),
		...(opts.account ? { "pref.mailboxAccount": { hlc, value: opts.account } } : {}),
	};
	const set = vi.fn(async () => {});
	const wrapper = ({ children }: { children: ReactNode }) => (
		<I18nProvider i18n={i18n}>
			<PlatformProvider platform={platform}>
				<SyncedSettingsContext.Provider value={{ settings, ready: true, set }}>
					<PrefsProvider>{children}</PrefsProvider>
				</SyncedSettingsContext.Provider>
			</PlatformProvider>
		</I18nProvider>
	);
	render(<MailboxSection connected={opts.connected ?? true} />, { wrapper });
	return { set, setMeta, copy };
}

beforeAll(() => {
	i18n.load("en", {});
	i18n.activate("en");
});
afterEach(() => {
	cleanup();
	flags.hosted = false;
});

describe("MailboxSection", () => {
	it("opens Advanced while hosted is off, and saving a server sets the synced setting", async () => {
		const { set } = mount();
		fireEvent.change(screen.getByLabelText("Mailbox server"), {
			target: { value: "https://Mail.Example/" },
		});
		fireEvent.click(screen.getByRole("button", { name: "Use this server" }));
		await waitFor(() => expect(set).toHaveBeenCalledWith("pref.mailbox", CUSTOM));
	});

	it("refuses a server URL with a path, under the URL field", async () => {
		const { set } = mount();
		fireEvent.change(screen.getByLabelText("Mailbox server"), {
			target: { value: "https://mail.example/sync" },
		});
		fireEvent.click(screen.getByRole("button", { name: "Use this server" }));
		expect(await screen.findByText(/Enter just the server's address/)).toBeTruthy();
		expect(set).not.toHaveBeenCalled();
	});

	it("renders no hosted block while hosted is off", () => {
		mount();
		expect(screen.queryByRole("button", { name: "Sign in" })).toBeNull();
	});

	it("shows the status line from the status record", async () => {
		mount({ config: CUSTOM, meta: { "mailbox.status:vault-a": { status: "waiting", at: 1 } } });
		expect(await screen.findByText("Waiting for another device to add this one")).toBeTruthy();
	});

	it("remembers this device's opt-out when reopened", async () => {
		mount({ config: CUSTOM, meta: { "pref.mailboxOff:vault-a": true } });
		const toggle = await screen.findByRole("button", { name: "Use the mailbox on this device" });
		await waitFor(() => expect(toggle.getAttribute("aria-pressed")).toBe("false"));
	});

	it("the device switch sets the per-device override", async () => {
		const { setMeta } = mount({ config: CUSTOM });
		fireEvent.click(await screen.findByRole("button", { name: "Use the mailbox on this device" }));
		await waitFor(() => expect(setMeta).toHaveBeenCalledWith("pref.mailboxOff:vault-a", true));
	});
});

describe("the hosted mailbox's account", () => {
	const A = "12345 67890 12345 67890 12345";
	const DAY = 86_400_000;
	const HOSTED: MailboxConfig = { kind: "hosted" };
	let KEY_A = "";
	beforeAll(async () => {
		KEY_A = await accountKeyOf(A);
	});
	const withAccount = (account: Record<string, unknown>, status = "synced") => ({
		"mailbox.status:vault-a": { status, at: 1, account: { at: 1, key: KEY_A, ...account } },
	});
	const paid = (daysLeft: number, more: Record<string, unknown> = {}) =>
		withAccount({
			paidThrough: Date.now() + daysLeft * DAY,
			frozen: false,
			usedBytes: 12_000_000,
			quotaBytes: 1_000_000_000,
			...more,
		});
	beforeEach(() => {
		flags.hosted = true;
	});

	it("offers the hosted mailbox with its price and where to get a number", () => {
		mount();
		expect(screen.getByText("Bramble Mailbox")).toBeTruthy();
		expect(screen.getByText(/\$2 a month, at least 6 months at a time\./)).toBeTruthy();
		const link = screen.getByRole("link", { name: "Get an account number" });
		expect(link.getAttribute("href")).toBe(accountPageUrl());
		expect(screen.getByRole("button", { name: "Sign in" })).toBeTruthy();
	});

	it("before this vault syncs with another device, shows the sign-in disabled and says why", () => {
		mount({ connected: false });
		const field = screen.getByLabelText("Account number") as HTMLInputElement;
		expect(field.disabled).toBe(true);
		expect(screen.getByText("Connect a device to enable the mailbox.")).toBeTruthy();
		expect((screen.getByRole("button", { name: "Sign in" }) as HTMLButtonElement).disabled).toBe(
			true,
		);
		expect(screen.queryByRole("button", { name: "My other devices already use it" })).toBeNull();
		// Somewhere to buy a number while waiting.
		expect(screen.getByRole("link", { name: "Get an account number" })).toBeTruthy();
		fireEvent.click(screen.getByRole("button", { name: "Advanced" }));
		expect((screen.getByLabelText("Mailbox server") as HTMLInputElement).disabled).toBe(true);
	});

	it("before this vault syncs with another device, a mailbox already chosen shows disabled too", () => {
		mount({ connected: false, config: HOSTED, account: A });
		expect(screen.queryByRole("button", { name: "Sync now" })).toBeNull();
		expect((screen.getByLabelText("Account number") as HTMLInputElement).disabled).toBe(true);
	});

	it("on iOS, signing in is all there is", async () => {
		const states: Parameters<typeof mount>[0][] = [
			{},
			{ config: HOSTED },
			{ config: HOSTED, account: A, meta: paid(100) },
			{ config: HOSTED, account: A, meta: paid(10) },
			{ config: HOSTED, account: A, meta: paid(0, { paidThrough: 0 }) },
			{ config: HOSTED, account: A, meta: paid(-3) },
			{ config: HOSTED, account: A, meta: paid(100, { frozen: true }) },
			{ config: HOSTED, account: A, meta: withAccount({ unknown: true }, "account_unknown") },
		];
		for (const state of states) {
			mount({ ...state, target: "ios" });
			await screen.findAllByText(/Mailbox/);
			expect(document.body.textContent).not.toContain("$");
			for (const a of document.querySelectorAll("a"))
				expect(a.getAttribute("href") ?? "").not.toContain("bramble.sh");
			expect(screen.queryByText("Add time")).toBeNull();
			expect(screen.queryByText("Get an account number")).toBeNull();
			cleanup();
		}
	});

	it("signing in saves the number formatted and turns the hosted mailbox on", async () => {
		const { set } = mount();
		fireEvent.change(screen.getByLabelText("Account number"), {
			target: { value: "1234567890123456789012345" },
		});
		fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
		await waitFor(() => expect(set).toHaveBeenCalledWith("pref.mailboxAccount", A));
		await waitFor(() => expect(set).toHaveBeenCalledWith("pref.mailbox", HOSTED));
	});

	it("a number one digit short is refused where it was typed", async () => {
		const { set } = mount();
		fireEvent.change(screen.getByLabelText("Account number"), {
			target: { value: "123456789012345678901234" },
		});
		fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
		expect(await screen.findByText("An account number is 25 digits")).toBeTruthy();
		expect(set).not.toHaveBeenCalled();
	});

	it("shows paid time and storage", async () => {
		mount({ config: HOSTED, account: A, meta: paid(100) });
		expect(await screen.findByText(/^Paid through /)).toBeTruthy();
		expect(screen.getByText("12 MB of 1 GB used")).toBeTruthy();
		expect(screen.getByText("••••• ••••• ••••• ••••• 12345")).toBeTruthy();
	});

	it("warns from 14 days out", async () => {
		mount({ config: HOSTED, account: A, meta: paid(10) });
		expect(await screen.findByText(/^Paid time ends /)).toBeTruthy();
		expect(screen.getByRole("link", { name: "Add time" })).toBeTruthy();
		cleanup();
		mount({ config: HOSTED, account: A, meta: paid(10), target: "ios" });
		expect(await screen.findByText(/^Paid time ends /)).toBeTruthy();
		expect(screen.queryByRole("link")).toBeNull();
	});

	it("never-paid, ended and frozen accounts say so", async () => {
		mount({ config: HOSTED, account: A, meta: paid(0, { paidThrough: 0 }) });
		expect(await screen.findByText("No paid time yet")).toBeTruthy();
		cleanup();
		mount({ config: HOSTED, account: A, meta: paid(-3) });
		expect(await screen.findByText(/^Paid time ended /)).toBeTruthy();
		cleanup();
		mount({ config: HOSTED, account: A, meta: paid(100, { frozen: true }) });
		expect(await screen.findByText("Posting is paused for this account")).toBeTruthy();
	});

	it("a record read for another number is never shown", async () => {
		const other = await accountKeyOf("66666 77777 88888 99999 00000");
		mount({ config: HOSTED, account: A, meta: paid(100, { key: other }) });
		await screen.findByText("••••• ••••• ••••• ••••• 12345");
		// Past the card's own hashing of the number, so a match would have been drawn by now.
		await new Promise((resolve) => setTimeout(resolve, 50));
		expect(screen.queryByText(/^Paid through /)).toBeNull();
		expect(screen.queryByText(/ used$/)).toBeNull();
	});

	it("Add time carries the number in the fragment", async () => {
		mount({ config: HOSTED, account: A, meta: paid(100) });
		const link = await screen.findByRole("link", { name: "Add time" });
		expect(link.getAttribute("href")).toBe(accountPageUrl(A));
	});

	it("other_vault reads plainly", async () => {
		mount({ config: HOSTED, meta: { "mailbox.status:vault-a": { status: "other_vault", at: 1 } } });
		expect(
			await screen.findByText(
				"This device uses the mailbox for another vault. Turn it off there to use it here.",
			),
		).toBeTruthy();
	});

	it("the new statuses read plainly", async () => {
		mount({
			config: HOSTED,
			meta: { "mailbox.status:vault-a": { status: "account_required", at: 1 } },
		});
		expect(await screen.findByText("Add an account number to start the mailbox")).toBeTruthy();
		cleanup();
		mount({ config: HOSTED, account: A, meta: withAccount({ unknown: true }, "account_unknown") });
		expect(
			(await screen.findAllByText("The mailbox doesn't recognize this account number")).length,
		).toBeGreaterThan(0);
	});
});

describe("MailboxCheckIn", () => {
	const today = Math.floor(Date.now() / 86_400_000);
	const row = (member: Parameters<typeof MailboxCheckIn>[0]["member"]) => {
		render(
			<I18nProvider i18n={i18n}>
				<MailboxCheckIn member={member} />
			</I18nProvider>,
		);
	};

	it("shows today's check-in as today", () => {
		row({ sigKey: "K", status: "active", lastCheckedDay: today });
		expect(screen.getByText("Mailbox check-in: today")).toBeTruthy();
	});

	it("shows an older check-in as its date", () => {
		row({ sigKey: "K", status: "active", lastCheckedDay: 20_000 });
		expect(screen.getByText(/^Mailbox check-in: /).textContent).not.toContain("today");
	});

	it("marks an eligible member as not using the mailbox, and shows nothing without one", () => {
		row({ sigKey: "K", status: "eligible", lastCheckedDay: null });
		expect(screen.getByText("Not using the mailbox")).toBeTruthy();
		cleanup();
		row(undefined);
		expect(document.body.textContent).toBe("");
	});
});
