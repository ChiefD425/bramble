/** @vitest-environment happy-dom */
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type Platform, PlatformProvider } from "../../context/PlatformContext";
import { PrefsProvider } from "../../hooks/usePrefs";
import { qualifyingReviewNudgeState } from "../review-nudge";
import { useReviewNudge } from "./useReviewNudge";

vi.mock("../../hooks/useVaultRegistry", () => ({
	useVaultRegistry: () => ({ activeId: "v1", vaults: [{ id: "v1" }], ready: true }),
}));

afterEach(cleanup);

function Ask({ hold }: { hold: boolean }) {
	useReviewNudge(10, { hold });
	return null;
}

async function mountIos(hold: boolean) {
	const store = new Map<string, unknown>([
		["pref.reviewNudge", qualifyingReviewNudgeState(Date.now())],
	]);
	const storage = {
		getMeta: vi.fn(async (k: string) => store.get(k)),
		setMeta: vi.fn(async (k: string, v: unknown) => void store.set(k, v)),
		removeMeta: vi.fn(async (k: string) => void store.delete(k)),
	};
	const requestStoreReview = vi.fn(async () => {});
	const platform = {
		storage,
		target: "ios",
		shell: { version: "1.28.0", requestStoreReview },
	} as unknown as Platform;
	const view = render(
		<PlatformProvider platform={platform}>
			<PrefsProvider>
				<Ask hold={hold} />
			</PrefsProvider>
		</PlatformProvider>,
	);
	await act(async () => {});
	return {
		requestStoreReview,
		rerender: async (next: boolean) => {
			view.rerender(
				<PlatformProvider platform={platform}>
					<PrefsProvider>
						<Ask hold={next} />
					</PrefsProvider>
				</PlatformProvider>,
			);
			await act(async () => {});
		},
	};
}

describe("useReviewNudge on iOS", () => {
	it("fires Apple's prompt on the turn it decides to ask", async () => {
		const { requestStoreReview } = await mountIos(false);
		expect(requestStoreReview).toHaveBeenCalledOnce();
	});

	it("holds it while the vault list has a card, and asks once it has none", async () => {
		const { requestStoreReview, rerender } = await mountIos(true);
		expect(requestStoreReview).not.toHaveBeenCalled();
		await rerender(false);
		expect(requestStoreReview).toHaveBeenCalledOnce();
	});
});
