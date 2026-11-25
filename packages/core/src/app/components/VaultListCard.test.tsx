/** @vitest-environment happy-dom */
import { i18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { CardSlotProvider } from "../hooks/useCardSlot";
import type { MailboxExpiry } from "../hooks/useMailboxExpiry";
import { MailboxExpiryCard } from "./MailboxExpiryCard";
import { VaultListCard, type VaultListCards } from "./VaultListCard";

beforeAll(() => {
	i18n.load("en", {});
	i18n.activate("en");
});

afterEach(cleanup);

const ENDS = Date.UTC(2026, 11, 8, 12);

/** Every card on offer at once, each going away once acted on, as their hooks' state does. */
function Cards({ only }: { only?: (keyof VaultListCards)[] }) {
	const [gone, setGone] = useState<Set<string>>(new Set());
	const end = (k: string) => () => setGone((g) => new Set(g).add(k));
	const offer = (k: keyof VaultListCards) => !gone.has(k) && (!only || only.includes(k));
	return (
		<VaultListCard
			cards={{
				appUpdate: offer("appUpdate")
					? { version: "0.34.0", url: "https://example.com/a.apk", onDismiss: end("appUpdate") }
					: null,
				whatsNew: offer("whatsNew")
					? {
							version: "1.42.0",
							notes: { version: "1.42.0", headline: "Headline.", items: ["One."] },
							url: "https://bramble.sh/whats-new/chromium/1.42.0",
							onClose: end("whatsNew"),
						}
					: null,
				mailboxExpiry: offer("mailboxExpiry")
					? {
							stage: "ending",
							paidThrough: ENDS,
							buyUrl: "https://bramble.sh/account",
							onClose: end("mailboxExpiry"),
							onStop: async () => end("mailboxExpiry")(),
						}
					: null,
				supportAsk: offer("supportAsk")
					? {
							url: "https://ko-fi.com/bramble_sh",
							onShown: () => {},
							onDonate: end("supportAsk"),
							onDismiss: end("supportAsk"),
						}
					: null,
				reviewNudge: offer("reviewNudge")
					? {
							reviewUrl: "https://example.com/r",
							onRated: end("reviewNudge"),
							onDismiss: end("reviewNudge"),
						}
					: null,
				defaultManager: offer("defaultManager")
					? { onAccept: end("defaultManager"), onDismiss: end("defaultManager") }
					: null,
			}}
		/>
	);
}

function mount(only?: (keyof VaultListCards)[]) {
	return render(
		<I18nProvider i18n={i18n}>
			<CardSlotProvider>
				<Cards only={only} />
			</CardSlotProvider>
		</I18nProvider>,
	);
}

const showing = () => ({
	update: !!screen.queryByText(/is available/),
	whatsNew: !!screen.queryByText(/What's new in/),
	mailbox: !!screen.queryByText(/Mailbox time end/),
	support: !!screen.queryByText("Support Bramble"),
	review: !!screen.queryByText(/Say something nice/),
	defaultManager: !!screen.queryByText(/default password manager/),
});

describe("VaultListCard", () => {
	it("shows one card, the update first, then what's new, the review ask, the default manager", () => {
		mount();
		expect(showing()).toEqual({
			update: true,
			whatsNew: false,
			mailbox: false,
			support: false,
			review: false,
			defaultManager: false,
		});
		cleanup();
		mount(["whatsNew", "reviewNudge", "defaultManager"]);
		expect(showing()).toEqual({
			update: false,
			whatsNew: true,
			mailbox: false,
			support: false,
			review: false,
			defaultManager: false,
		});
		cleanup();
		mount(["reviewNudge", "defaultManager"]);
		expect(showing()).toEqual({
			update: false,
			whatsNew: false,
			mailbox: false,
			support: false,
			review: true,
			defaultManager: false,
		});
		cleanup();
		mount(["defaultManager"]);
		expect(showing().defaultManager).toBe(true);
	});

	it("leaves the spot empty for the rest of the open once a card is closed", () => {
		mount();
		fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
		expect(showing()).toEqual({
			update: false,
			whatsNew: false,
			mailbox: false,
			support: false,
			review: false,
			defaultManager: false,
		});
		expect(screen.queryByRole("button")).toBeNull();
	});

	it("counts Read more, a review and accepting as acting on the card", () => {
		mount(["whatsNew", "reviewNudge"]);
		fireEvent.click(screen.getByRole("link", { name: /read more/i }));
		expect(screen.queryByText(/Say something nice/)).toBeNull();
		cleanup();
		mount(["reviewNudge", "defaultManager"]);
		fireEvent.click(screen.getByRole("link", { name: /leave a review/i }));
		expect(showing().defaultManager).toBe(false);
		cleanup();
		mount(["defaultManager"]);
		fireEvent.click(screen.getByRole("button", { name: /make default/i }));
		expect(screen.queryByRole("button")).toBeNull();
	});

	it("still runs the card's own action", () => {
		const onClose = vi.fn();
		render(
			<I18nProvider i18n={i18n}>
				<CardSlotProvider>
					<VaultListCard
						cards={{
							appUpdate: null,
							whatsNew: {
								version: "1.42.0",
								notes: { version: "1.42.0", items: [] },
								url: "https://bramble.sh/whats-new/chromium/1.42.0",
								onClose,
							},
							mailboxExpiry: null,
							supportAsk: null,
							reviewNudge: null,
							defaultManager: null,
						}}
					/>
				</CardSlotProvider>
			</I18nProvider>,
		);
		fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
		expect(onClose).toHaveBeenCalledOnce();
	});

	it("starts empty-handed again on the next open", () => {
		mount();
		fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
		cleanup();
		mount(["whatsNew"]);
		expect(showing().whatsNew).toBe(true);
	});

	it("puts the donation card after what's new and ahead of the review ask", () => {
		mount(["supportAsk", "reviewNudge", "defaultManager"]);
		expect(showing()).toEqual({
			update: false,
			whatsNew: false,
			mailbox: false,
			support: true,
			review: false,
			defaultManager: false,
		});
		cleanup();
		mount(["whatsNew", "supportAsk"]);
		expect(showing().support).toBe(false);
	});

	it("leaves the spot empty once the donation card is dismissed or followed", () => {
		mount(["supportAsk", "reviewNudge"]);
		fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
		expect(showing().review).toBe(false);
		cleanup();
		mount(["supportAsk", "reviewNudge"]);
		fireEvent.click(screen.getByRole("link", { name: /Donate/ }));
		expect(showing().review).toBe(false);
		expect(showing().support).toBe(false);
	});

	it("puts the mailbox's paid time after what's new and ahead of the donation card", () => {
		mount(["mailboxExpiry", "supportAsk", "reviewNudge"]);
		expect(showing()).toEqual({
			update: false,
			whatsNew: false,
			mailbox: true,
			support: false,
			review: false,
			defaultManager: false,
		});
		cleanup();
		mount(["whatsNew", "mailboxExpiry"]);
		expect(showing().mailbox).toBe(false);
	});

	it("leaves the spot empty once the mailbox card is closed, followed or stopped", async () => {
		mount(["mailboxExpiry", "supportAsk"]);
		fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
		expect(showing().support).toBe(false);
		cleanup();
		mount(["mailboxExpiry", "supportAsk"]);
		fireEvent.click(screen.getByRole("link", { name: /Buy more time/ }));
		expect(showing().support).toBe(false);
		cleanup();
		mount(["mailboxExpiry", "supportAsk"]);
		fireEvent.click(screen.getByRole("button", { name: "Stop using the mailbox" }));
		expect(screen.getByText("Every device stops syncing through it.")).toBeTruthy();
		expect(screen.queryByRole("link", { name: /Buy more time/ })).toBeNull();
		fireEvent.click(screen.getByRole("button", { name: "Stop" }));
		await waitFor(() => expect(showing().mailbox).toBe(false));
		expect(showing().support).toBe(false);
	});
});

describe("the mailbox card", () => {
	const expiry = (over: Partial<MailboxExpiry>): MailboxExpiry => ({
		stage: "ending",
		paidThrough: ENDS,
		buyUrl: "https://bramble.sh/account#123",
		onClose: () => {},
		onStop: async () => {},
		...over,
	});
	const show = (e: MailboxExpiry) =>
		render(
			<I18nProvider i18n={i18n}>
				<MailboxExpiryCard expiry={e} onBuy={() => {}} />
			</I18nProvider>,
		);

	it("gives the date and where to buy more", () => {
		show(expiry({}));
		expect(screen.getByText("Mailbox time ends Dec 8, 2026")).toBeTruthy();
		expect(screen.getByRole("link", { name: /Buy more time/ }).getAttribute("href")).toBe(
			"https://bramble.sh/account#123",
		);
	});

	it("can't be closed once the time has ended", () => {
		show(expiry({ stage: "ended", onClose: undefined }));
		expect(screen.getByText("Mailbox time ended Dec 8, 2026")).toBeTruthy();
		expect(screen.queryByRole("button", { name: "Dismiss" })).toBeNull();
		expect(screen.getByRole("button", { name: "Stop using the mailbox" })).toBeTruthy();
	});

	it("states the date and nothing more where buying isn't offered", () => {
		show(expiry({ buyUrl: null }));
		expect(screen.queryByRole("link")).toBeNull();
		fireEvent.click(screen.getByRole("button", { name: "Stop using the mailbox" }));
		expect(screen.queryByText(/account page/)).toBeNull();
	});
});
