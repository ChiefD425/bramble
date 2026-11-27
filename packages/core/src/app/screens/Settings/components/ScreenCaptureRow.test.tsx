/** @vitest-environment happy-dom */
import { i18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { ScreenCaptureControl } from "../../../../adapters/shell";
import { type Platform, PlatformProvider } from "../../../../context/PlatformContext";
import { ScreenCaptureRow } from "./ScreenCaptureRow";

const h = vi.hoisted(() => ({
	blocked: true,
	loaded: true,
	update: vi.fn(async (_key: string, _value: unknown) => {}),
}));

vi.mock("../../../../hooks/usePrefs", () => ({
	usePrefs: () => ({
		prefs: { screenCaptureBlocked: h.blocked },
		loaded: h.loaded,
		update: h.update,
	}),
}));

beforeAll(() => {
	i18n.load("en", {});
	i18n.activate("en");
});
afterEach(async () => {
	// The pause is module state shared with the toast; end it so tests don't leak into each other.
	const end = screen.queryByRole("button", { name: "Block now" });
	if (end) {
		fireEvent.click(end);
		await waitFor(() => expect(screen.queryByRole("button", { name: "Block now" })).toBeNull());
	}
	cleanup();
	vi.useRealTimers();
	h.blocked = true;
	h.loaded = true;
	h.update.mockClear();
});

function control(available = true, pausedUntil = 0) {
	return {
		available: vi.fn(async () => available),
		setBlocked: vi.fn(async (_blocked: boolean) => {}),
		pause: vi.fn(async (ms: number) => Date.now() + ms),
		pausedUntil: vi.fn(async () => pausedUntil),
	};
}

function mount(screenCapture?: ScreenCaptureControl) {
	const platform = { target: "android", shell: { screenCapture } } as unknown as Platform;
	return render(
		<I18nProvider i18n={i18n}>
			<PlatformProvider platform={platform}>
				<ScreenCaptureRow />
			</PlatformProvider>
		</I18nProvider>,
	);
}

const toggle = () => screen.findByRole("button", { name: "Toggle block screenshots" });

describe("Block screenshots", () => {
	it("is absent where the shell can't block", async () => {
		mount();
		await act(async () => {});
		expect(screen.queryByText("Block screenshots")).toBeNull();
	});

	it("is absent where the device lacks the mechanism", async () => {
		const c = control(false);
		mount(c);
		await waitFor(() => expect(c.available).toHaveBeenCalled());
		expect(screen.queryByText("Block screenshots")).toBeNull();
	});

	it("turning it off saves the choice and lifts the block now", async () => {
		const c = control();
		mount(c);
		fireEvent.click(await toggle());
		await waitFor(() => expect(c.setBlocked).toHaveBeenCalledWith(false));
		expect(h.update).toHaveBeenCalledWith("screenCaptureBlocked", false);
	});

	it("waits for the saved setting before showing the switch", async () => {
		h.loaded = false;
		const c = control();
		mount(c);
		await waitFor(() => expect(c.available).toHaveBeenCalled());
		expect(screen.queryByText("Block screenshots")).toBeNull();
	});

	it("shows a pause that outlived a reload of the page", async () => {
		mount(control(true, Date.now() + 300_000));
		expect(await screen.findByText(/^Screenshots allowed until /)).toBeTruthy();
		expect(screen.getByRole("button", { name: "Block now" })).toBeTruthy();
	});

	it("offers no pause while it is off", async () => {
		h.blocked = false;
		mount(control());
		await toggle();
		expect(screen.queryByRole("button", { name: "Allow for 10 minutes" })).toBeNull();
	});

	it("allows screenshots for 10 minutes, then says when they are blocked again", async () => {
		const c = control();
		mount(c);
		fireEvent.click(await screen.findByRole("button", { name: "Allow for 10 minutes" }));
		await waitFor(() => expect(c.pause).toHaveBeenCalledWith(600_000));
		expect(await screen.findByText(/^Screenshots allowed until /)).toBeTruthy();
		fireEvent.click(screen.getByRole("button", { name: "Block now" }));
		await waitFor(() => expect(c.setBlocked).toHaveBeenCalledWith(true));
		expect(await screen.findByRole("button", { name: "Allow for 10 minutes" })).toBeTruthy();
		expect(screen.queryByText(/^Screenshots allowed until /)).toBeNull();
	});

	it("goes back to blocking on its own when the pause ends", async () => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
		mount(control());
		await act(async () => {});
		fireEvent.click(screen.getByRole("button", { name: "Allow for 10 minutes" }));
		await act(async () => {});
		expect(screen.getByText(/^Screenshots allowed until /)).toBeTruthy();
		await act(async () => {
			vi.advanceTimersByTime(600_000);
		});
		expect(screen.queryByText(/^Screenshots allowed until /)).toBeNull();
		expect(screen.getByRole("button", { name: "Allow for 10 minutes" })).toBeTruthy();
	});
});
