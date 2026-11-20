/** @vitest-environment happy-dom */
import { render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { PopOutHandoff } from "../../adapters/shell";
import { type Platform, PlatformProvider } from "../../context/PlatformContext";
import type { AppRouter } from "../router";
import { PopOutProvider, usePopOut } from "./usePopOut";

vi.mock("../../hooks/useVaultRegistry", () => ({
	useVaultRegistry: () => ({ activeId: "v1" }),
}));

function controls() {
	const sent = vi.fn(async () => {});
	let reuse: ((handoff: PopOutHandoff) => boolean) | undefined;
	const platform = {
		target: "chromium",
		shell: {
			popOut: sent,
			isDetached: () => false,
			onPopOutReuse: (cb: (handoff: PopOutHandoff) => boolean) => {
				reuse = cb;
				return () => {};
			},
		},
	} as unknown as Platform;
	const navigate = vi.fn(async () => {});
	const router = { state: { location: { href: "/vault" } }, navigate } as unknown as AppRouter;
	let captured: ReturnType<typeof usePopOut> | null = null;
	function Probe() {
		captured = usePopOut();
		return null;
	}
	render(
		<PlatformProvider platform={platform}>
			<PopOutProvider router={router}>
				<Probe />
			</PopOutProvider>
		</PlatformProvider>,
	);
	return {
		pop: captured as unknown as ReturnType<typeof usePopOut>,
		sent,
		navigate,
		reuse: (handoff: PopOutHandoff) => reuse?.(handoff),
	};
}

describe("popOut", () => {
	it("hands over no draft when used directly as a click handler", () => {
		const { pop, sent } = controls();
		// What `onClick={popOut}` does: React passes the click event, which no browser can send.
		(pop.popOut as (e: unknown) => void)({ type: "click", view: globalThis });
		expect(sent).toHaveBeenCalledWith({ path: "/vault", draft: undefined, vaultId: "v1" });
	});

	it("hands over an explicit draft only through popOutWith", () => {
		const { pop, sent } = controls();
		pop.popOutWith({ webauthn: "unlock" });
		expect(sent).toHaveBeenCalledWith({
			path: "/vault",
			draft: { webauthn: "unlock" },
			vaultId: "v1",
		});
	});
});

describe("another view pops out while this window is open", () => {
	const backups = { path: "/settings?tab=backups", vaultId: "v1" };

	it("moves to the route it hands over", () => {
		const { reuse, navigate } = controls();
		expect(reuse(backups)).toBe(true);
		expect(navigate).toHaveBeenCalledWith({ href: "/settings?tab=backups" });
	});

	it("keeps an open form, so the route gets a new window", () => {
		const { pop, reuse, navigate } = controls();
		pop.registerDraftGetter(() => ({ name: "Half-typed" }));
		expect(reuse(backups)).toBe(false);
		expect(navigate).not.toHaveBeenCalled();
	});

	it("leaves a route in another vault to a new window", () => {
		const { reuse, navigate } = controls();
		expect(reuse({ ...backups, vaultId: "v2" })).toBe(false);
		expect(navigate).not.toHaveBeenCalled();
	});

	it("leaves a draft to a new window", () => {
		const { reuse, navigate } = controls();
		expect(reuse({ ...backups, draft: { name: "x" } })).toBe(false);
		expect(navigate).not.toHaveBeenCalled();
	});
});
