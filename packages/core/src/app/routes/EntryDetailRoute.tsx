import { useLingui } from "@lingui/react/macro";
import { useNavigate, useParams } from "@tanstack/react-router";
import { useEffect, useRef } from "react";
import { usePrefs } from "../../hooks/usePrefs";
import { useVault } from "../../hooks/useVault";
import { checkPasswordBreach, isBreachCheckDue } from "../../util/pwned";
import { duplicateEntry } from "../../vault/duplicate";
import { useRouteBack } from "../hooks/useRouteBack";
import { setPendingCreateEntry } from "../pending-create-entry";
import { EntryDetail } from "../screens/EntryDetail/EntryDetail";

/** Route for a single entry's detail view; lazily refreshes login breach status. */
export function EntryDetailRoute() {
	const { t } = useLingui();
	const navigate = useNavigate();
	const back = useRouteBack();
	const { entryId } = useParams({ from: "/_app/vault/$entryId" });
	const {
		entries,
		conflicts,
		deleteEntry,
		setEntriesArchived,
		touchEntry,
		setEntriesBreach,
		readConflictVersions,
		resolveConflict,
	} = useVault();
	const { prefs, loaded: prefsLoaded } = usePrefs();
	const entry = entries.find((e) => e.id === entryId);
	const refreshAttemptedRef = useRef<string | null>(null);

	// Lazily refresh stale/missing breach status, once per entry per mount.
	// refreshAttemptedRef stops the write-back from re-triggering the effect.
	useEffect(() => {
		// Breach status is login-only.
		if (entry?.type !== "login" || !prefsLoaded) return;
		if (!prefs.breachCheckEnabled) return;
		if (refreshAttemptedRef.current === entry.id) return;
		if (!isBreachCheckDue(entry.breach, Date.now())) return;
		refreshAttemptedRef.current = entry.id;
		const { id, password } = entry;
		void (async () => {
			const breach = await checkPasswordBreach(password);
			if (!breach) return;
			// Dropped if the vault locked meanwhile; the next unlock checks it again.
			await setEntriesBreach([{ id, password, breach }]).catch(() => {});
		})();
	}, [entry, prefsLoaded, prefs.breachCheckEnabled, setEntriesBreach]);

	if (!entry) return null;

	// Hide a stored breach result while breach checking is off.
	const viewEntry =
		prefs.breachCheckEnabled || entry.type !== "login" ? entry : { ...entry, breach: undefined };

	return (
		<div className="flex-1 overflow-y-auto">
			<EntryDetail
				entry={viewEntry}
				onEdit={() => navigate({ to: "/vault/$entryId/edit", params: { entryId } })}
				onDelete={async () => {
					await deleteEntry(entryId);
					// Back, not a push: the list reopens where it was.
					if (back) back();
					else navigate({ to: "/vault" });
				}}
				onSetArchived={(archived) => setEntriesArchived([entryId], archived)}
				onDuplicate={() => {
					setPendingCreateEntry(duplicateEntry(entry, t`${entry.name} (copy)`));
					navigate({ to: "/vault/new/$type", params: { type: entry.type } });
				}}
				// The tag filter lives in `q`, so picking a tag is just a search: one source of
				// truth, and the resulting URL is the same one typing `#tag` would produce.
				onSelectTag={(tag) => navigate({ to: "/vault", search: { q: `#${tag}` } })}
				onUse={() => void touchEntry(entryId)}
				conflict={conflicts.get(entryId)}
				onReadConflictVersions={() => readConflictVersions(entryId)}
				onResolveConflict={(choice) => resolveConflict(entryId, choice)}
				breachChecks={prefs.breachCheckEnabled}
			/>
		</div>
	);
}
