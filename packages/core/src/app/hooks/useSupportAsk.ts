import { useEffect, useRef, useState } from "react";
import { usePlatform } from "../../context/PlatformContext";
import { usePrefs } from "../../hooks/usePrefs";
import { SUPPORT_URL, supportAskDue } from "../support-ask";

export interface SupportAsk {
	/** Ko-fi. */
	url: string;
	/** The card is on screen: this is what counts as asking. */
	onShown(): void;
	/** Donate: the card goes, and this install is left alone for 90 days. */
	onDonate(): void;
	/** The corner X. */
	onDismiss(): void;
}

/**
 * The donation card, once every two weeks, on an open where `hold` is false (no other card is
 * showing, coming, or was closed). It stays up from the moment it appears until it is answered.
 * Null on iOS and with the Settings switch off. See docs/support-ask.md.
 */
export function useSupportAsk(hold: boolean): SupportAsk | null {
	const { target } = usePlatform();
	const { prefs, loaded, update } = usePrefs();
	const url = SUPPORT_URL[target];
	const [phase, setPhase] = useState<"waiting" | "shown" | "answered">("waiting");
	const state = useRef(prefs.supportAsk);
	state.current = prefs.supportAsk;

	// The clock starts on the first vault list of a build that asks, so the first ask is two weeks
	// after that rather than at once. Nothing is stored where it never asks.
	const started = prefs.supportAsk.startedAt !== undefined;
	useEffect(() => {
		if (loaded && url && !started)
			void update("supportAsk", { ...state.current, startedAt: Date.now() });
	}, [loaded, url, started, update]);

	const due =
		loaded && prefs.supportAskEnabled && supportAskDue(prefs.supportAsk, Date.now()) && !hold;
	if (!url || phase === "answered" || (phase === "waiting" && !due)) return null;
	return {
		url,
		onShown: () => {
			if (phase !== "waiting") return;
			setPhase("shown");
			void update("supportAsk", { ...state.current, askedAt: Date.now() });
		},
		onDonate: () => {
			setPhase("answered");
			void update("supportAsk", { ...state.current, donatedAt: Date.now() });
		},
		onDismiss: () => setPhase("answered"),
	};
}
