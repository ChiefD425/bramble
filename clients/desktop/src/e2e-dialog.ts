// Dev-only: stands in for @tauri-apps/plugin-dialog while the e2e bridge is armed (see
// scripts/vite-e2e-bridge.mjs). A native save panel can't be answered from the window, so the
// harness queues the path it would have picked. With nothing queued it is the real panel.

import { save as nativeSave } from "@tauri-apps/plugin-dialog";

export * from "@tauri-apps/plugin-dialog";

const queued: string[] = [];

/** The answer for the next save panel. */
export function saveTo(path: string): void {
	queued.push(path);
}

export const save: typeof nativeSave = async (options) => queued.shift() ?? nativeSave(options);
