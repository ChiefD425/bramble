import { useEffect, useRef, useState } from "react";
import { useSyncedSettings } from "../../hooks/synced-settings";
import { usePrefs } from "../../hooks/usePrefs";
import { useVault } from "../../hooks/useVault";
import { useVaultRegistry } from "../../hooks/useVaultRegistry";
import { checkPasswordBreach } from "../../util/pwned";
import {
	type BreachSweep,
	dueForBreachCheck,
	newBreachSweep,
	sweepBreaches,
} from "../breach-sweep";

/**
 * While breach checks are on, checks the open vault's logins that are due: on unlock, and again
 * when new ones arrive (an import, a save from a page, a sync).
 */
export function useBreachSweep(): void {
	const { entries, setEntriesBreach } = useVault();
	const { activeId } = useVaultRegistry();
	const { prefs, loaded } = usePrefs();
	// Unlocked AND the open vault loaded, so a save can't land in the vault being switched away from.
	const { ready: vaultOpen } = useSyncedSettings();
	// A new key starts a session; locking, switching vaults or turning checks off ends one.
	const sessionKey = loaded && prefs.breachCheckEnabled && vaultOpen ? (activeId ?? "") : null;

	const latest = useRef({ entries, save: setEntriesBreach });
	latest.current = { entries, save: setEntriesBreach };
	const [sweep, setSweep] = useState<BreachSweep | null>(null);

	useEffect(() => {
		if (sessionKey === null) return;
		const session = newBreachSweep();
		setSweep(session);
		return () => {
			session.cancelled = true;
			setSweep(null);
		};
	}, [sessionKey]);

	useEffect(() => {
		if (!sweep || sweep.running || sweep.halted) return;
		if (!dueForBreachCheck(entries, Date.now()).some((e) => !sweep.tried.has(e.id))) return;
		void sweepBreaches(sweep, {
			due: () => dueForBreachCheck(latest.current.entries, Date.now()),
			check: checkPasswordBreach,
			save: (results) => latest.current.save(results),
		});
	}, [sweep, entries]);
}
