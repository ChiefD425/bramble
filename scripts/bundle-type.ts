// Tauri stamps each Linux package's copy of the app binary with the package type, which the updater
// reads to know how it was installed. A failed stamp is only a warning in Tauri, and the package then
// ships whatever the binary last said; seen when two bundlers shared one target directory. So the
// stamp is checked before anything is published.

import { readFileSync } from "node:fs";

export type BundleType = "DEB" | "RPM" | "APP";

export function assertBundleType(binary: string, want: BundleType): void {
	const bytes = readFileSync(binary);
	if (!bytes.includes(`__TAURI_BUNDLE_TYPE_VAR_${want}`)) {
		const found = /__TAURI_BUNDLE_TYPE_VAR_([A-Z]{3})/.exec(bytes.toString("latin1"))?.[1];
		throw new Error(`${binary} is stamped ${found ?? "with nothing"}, not ${want}; rebuild it`);
	}
}
