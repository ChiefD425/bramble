/** @vitest-environment happy-dom */
import { i18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { type Platform, PlatformProvider } from "../../context/PlatformContext";
import { ScreenshotBlockedToast } from "./ScreenshotBlockedToast";
import { ToastProvider } from "./ui/toast";

beforeAll(() => {
	i18n.load("en", {});
	i18n.activate("en");
});
afterEach(cleanup);

function mount() {
	let emit = () => {};
	const unsubscribe = vi.fn();
	const control = {
		available: async () => true,
		setBlocked: vi.fn(async () => {}),
		pause: vi.fn(async (ms: number) => Date.now() + ms),
		pausedUntil: async () => 0,
		onBlockedScreenshot: (cb: () => void) => {
			emit = cb;
			return unsubscribe;
		},
	};
	const view = render(
		<I18nProvider i18n={i18n}>
			<PlatformProvider platform={{ shell: { screenCapture: control } } as unknown as Platform}>
				<ToastProvider>
					<ScreenshotBlockedToast />
				</ToastProvider>
			</PlatformProvider>
		</I18nProvider>,
	);
	return { emit: () => act(emit), control, unsubscribe, view };
}

describe("after a blocked screenshot", () => {
	it("says why it came out blank and offers the pause", async () => {
		const { emit, control } = mount();
		await emit();
		expect(screen.getByText("Screenshots are blocked")).toBeTruthy();
		fireEvent.click(screen.getByRole("button", { name: "Allow for 10 minutes" }));
		await waitFor(() => expect(control.pause).toHaveBeenCalledWith(600_000));
		expect(screen.queryByText("Screenshots are blocked")).toBeNull();
	});

	it("stops listening when unmounted", () => {
		const { unsubscribe, view } = mount();
		view.unmount();
		expect(unsubscribe).toHaveBeenCalled();
	});
});
