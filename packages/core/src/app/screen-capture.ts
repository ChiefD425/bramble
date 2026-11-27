import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import type { ScreenCaptureControl } from "../adapters/shell";
import { usePlatform } from "../context/PlatformContext";

/** How long "Allow for 10 minutes" lets capture through. The copy names it, so change both. */
export const SCREEN_CAPTURE_PAUSE_MS = 10 * 60_000;

// When the current pause ends, shared by the Settings row and the screenshot toast. The native
// side keeps the deadline that blocks again; this copy only decides what the UI says.
let pausedUntil: number | null = null;
let expiry: ReturnType<typeof setTimeout> | undefined;
const listeners = new Set<() => void>();

function setPausedUntil(until: number | null) {
	clearTimeout(expiry);
	pausedUntil = until !== null && until > Date.now() ? until : null;
	if (pausedUntil !== null)
		expiry = setTimeout(() => setPausedUntil(null), pausedUntil - Date.now());
	for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
	listeners.add(listener);
	return () => {
		listeners.delete(listener);
	};
}

/** Let screenshots through for 10 minutes. */
export async function pauseScreenCapture(control: ScreenCaptureControl): Promise<void> {
	setPausedUntil(await control.pause(SCREEN_CAPTURE_PAUSE_MS));
}

export interface ScreenCapture {
	/** Whether this device can block at all; false until the native side says so. */
	available: boolean;
	/** When the current pause ends (epoch ms), or null when there is none. */
	pausedUntil: number | null;
	/** Apply the switch now and end any pause. The caller persists the pref. */
	setBlocked(blocked: boolean): Promise<void>;
	pause(): Promise<void>;
}

export function useScreenCapture(): ScreenCapture {
	const { shell } = usePlatform();
	const control = shell.screenCapture;
	const [available, setAvailable] = useState(false);
	const until = useSyncExternalStore(subscribe, () => pausedUntil);

	useEffect(() => {
		if (!control) return;
		let live = true;
		control
			.available()
			.then((ok) => live && setAvailable(ok))
			.catch(() => {});
		// A reload of the page empties this copy while the native pause runs on.
		control
			.pausedUntil()
			.then((until) => setPausedUntil(until || null))
			.catch(() => {});
		return () => {
			live = false;
		};
	}, [control]);

	const setBlocked = useCallback(
		async (blocked: boolean) => {
			await control?.setBlocked(blocked);
			setPausedUntil(null);
		},
		[control],
	);
	const pause = useCallback(async () => {
		if (control) await pauseScreenCapture(control);
	}, [control]);

	return { available, pausedUntil: until, setBlocked, pause };
}
