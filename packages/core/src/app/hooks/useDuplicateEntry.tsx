import { useLingui } from "@lingui/react/macro";
import { useNavigate } from "@tanstack/react-router";
import { useCallback } from "react";
import type { Entry } from "../../hooks/useVault";
import { duplicateEntry } from "../../vault/duplicate";
import { setPendingCreateEntry } from "../pending-create-entry";

/** Open a new entry seeded from `entry`, from its own page or the list's menu (#259). */
export function useDuplicateEntry(): (entry: Entry) => void {
	const navigate = useNavigate();
	const { t } = useLingui();
	return useCallback(
		(entry: Entry) => {
			setPendingCreateEntry(duplicateEntry(entry, t`${entry.name} (copy)`));
			void navigate({ to: "/vault/new/$type", params: { type: entry.type } });
		},
		[navigate, t],
	);
}
