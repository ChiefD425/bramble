import { useLingui } from "@lingui/react";
import { useEffect, useState } from "react";
import { usePlatform } from "../../context/PlatformContext";
import { usePrefs } from "../../hooks/usePrefs";
import { installedVersion } from "../app-update";
import { loadReleaseNotes, type ReleaseNotes, whatsNewDue, whatsNewUrl } from "../whats-new";

export interface WhatsNewNotice {
	version: string;
	notes: ReleaseNotes;
	/** Read more. */
	url: string;
	/** Closing the card or following Read more: either ends it for this version. */
	onClose(): void;
}

/**
 * The card after an update: this build's notes for its own version, until they are closed. Null
 * on a fresh install, a dev build, and a release that went out without notes; undefined while the
 * notes load, so iOS's review prompt can wait for the answer. See docs/whats-new.md.
 */
export function useWhatsNew(): WhatsNewNotice | null | undefined {
	const { target, shell } = usePlatform();
	const { prefs, loaded, update } = usePrefs();
	const { i18n } = useLingui();
	const installed = installedVersion(shell.version);
	const due = loaded && !!installed && whatsNewDue(prefs.whatsNew, installed);
	const key = `${target}/${i18n.locale}/${installed}`;
	const [found, setFound] = useState<{ key: string; notes: ReleaseNotes | null }>();

	useEffect(() => {
		if (!due || !installed) return;
		let cancelled = false;
		const settle = (notes: ReleaseNotes | null) => {
			if (!cancelled) setFound({ key, notes });
		};
		void loadReleaseNotes(target, i18n.locale, installed).then(settle, () => settle(null));
		return () => {
			cancelled = true;
		};
	}, [due, target, i18n.locale, installed, key]);

	if (!loaded) return undefined;
	if (!due || !installed) return null;
	if (found?.key !== key) return undefined;
	if (!found.notes) return null;
	return {
		version: installed,
		notes: found.notes,
		url: whatsNewUrl(target, installed),
		onClose: () => void update("whatsNew", { seen: installed }),
	};
}
