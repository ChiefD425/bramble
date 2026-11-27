import { Trans, useLingui } from "@lingui/react/macro";
import {
	useElementScrollRestoration,
	useLocation,
	useNavigate,
	useSearch,
} from "@tanstack/react-router";
import { Loader2 } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { usePlatform } from "../../context/PlatformContext";
import { usePrefs } from "../../hooks/usePrefs";
import { isLogin, useVault } from "../../hooks/useVault";
import { useVaultRegistry } from "../../hooks/useVaultRegistry";
import { reusedPasswordIds } from "../../vault/password-reuse";
import { allTags } from "../../vault/tags";
import { useToast } from "../components/ui/toast";
import { VaultListCard } from "../components/VaultListCard";
import { useAppUpdate } from "../hooks/useAppUpdate";
import { useCardSlot } from "../hooks/useCardSlot";
import { useDefaultPasswordManager } from "../hooks/useDefaultPasswordManager";
import { useDuplicateEntry } from "../hooks/useDuplicateEntry";
import { useListAttach } from "../hooks/useListAttach";
import { useMailboxExpiry } from "../hooks/useMailboxExpiry";
import { useReviewNudge } from "../hooks/useReviewNudge";
import { useSupportAsk } from "../hooks/useSupportAsk";
import { useWhatsNew } from "../hooks/useWhatsNew";
import { toListItem } from "../screens/VaultHome/list-item";
import {
	VAULT_LIST_SCROLL_ID,
	VaultHome,
	type VaultListItem,
} from "../screens/VaultHome/VaultHome";
import { DEFAULT_SEARCH, type VaultSearch } from "../screens/VaultHome/vault-search";

/**
 * Where the list was when leaving the app locked it. The router records a list's offset when a
 * navigation leaves it, but a lock unmounts the list before navigating to the unlock screen.
 * The unlock returns to the same href in the same vault, which reopens the list here, once.
 */
let lockedAt: { vault: string | undefined; href: string; offset: number } | undefined;

/** Vault list route: projects entries into rows via their entry-mode descriptors. */
export function VaultHomeRoute() {
	const navigate = useNavigate();
	const href = useLocation({ select: (l) => l.href });
	const { activeId } = useVaultRegistry();
	const scrollEntry = useElementScrollRestoration({ id: VAULT_LIST_SCROLL_ID });
	const { prefs, loaded: prefsLoaded, update } = usePrefs();
	// Per-field `??` (not spread): a `.catch`ed param can be present-but-undefined.
	const raw = useSearch({ from: "/_app/vault" });
	const search = useMemo<VaultSearch>(
		() => ({
			q: raw.q ?? DEFAULT_SEARCH.q,
			type: raw.type ?? DEFAULT_SEARCH.type,
			sort: raw.sort ?? prefs.vaultSort,
			archived: raw.archived ?? DEFAULT_SEARCH.archived,
			attachments: raw.attachments ?? DEFAULT_SEARCH.attachments,
			health: raw.health ?? DEFAULT_SEARCH.health,
		}),
		[raw.q, raw.type, raw.sort, prefs.vaultSort, raw.archived, raw.attachments, raw.health],
	);
	const { entries, files, conflicts, ready, isLocked, lockedAway, deleteEntry, touchEntry } =
		useVault();
	// Read when the list unmounts: true only if leaving the app locked it, the one lock whose
	// unlock comes back here.
	const locking = useRef(false);
	locking.current = isLocked && lockedAway;
	const { shell } = usePlatform();
	const { show } = useToast();
	const { t } = useLingui();
	// Hide stored breach flags when breach checking is off.
	const showBreaches = prefs.breachCheckEnabled;

	// Logins matching the current tab, floated to the top (extension only; else []).
	const [matchedIds, setMatchedIds] = useState<ReadonlySet<string>>(() => new Set());
	useEffect(() => {
		let cancelled = false;
		// Archived logins are excluded: the tab match tints and floats a row as the
		// credential for this site, which is exactly the claim archiving withdraws.
		const logins = entries
			.filter(isLogin)
			.filter((e) => e.archivedAt === undefined)
			.map((e) => ({ id: e.id, urls: e.urls, subdomainMatch: e.subdomainMatch }));
		if (logins.length === 0) {
			setMatchedIds((prev) => (prev.size === 0 ? prev : new Set()));
			return;
		}
		shell
			.matchCurrentTab(logins)
			.then((ids) => {
				if (!cancelled)
					setMatchedIds((prev) => {
						const next = new Set(ids);
						return prev.size === next.size && ids.every((id) => prev.has(id)) ? prev : next;
					});
			})
			.catch(() => {});
		return () => {
			cancelled = true;
		};
	}, [shell, entries]);

	const appUpdate = useAppUpdate();
	const whatsNew = useWhatsNew();
	const slot = useCardSlot();
	const mailboxExpiry = useMailboxExpiry();
	// After the update, What's new (which may still be loading: undefined) and the mailbox's paid
	// time, on an open no card has been closed in.
	const supportAsk = useSupportAsk(
		slot.closed || !!appUpdate || whatsNew !== null || !!mailboxExpiry,
	);
	// The store-review ask. Called unconditionally (it counts sessions whether or not it ever
	// asks) and usually null. Entries are the whole vault, archived included: an archived entry
	// is still one this person put there, which is all the signal is measuring. iOS's own prompt
	// waits while the list has a card, may get one (the notes still loading), or closed one.
	const reviewNudge = useReviewNudge(entries.length, {
		hold: slot.closed || !!appUpdate || whatsNew !== null || !!mailboxExpiry || !!supportAsk,
	});
	const defaultManager = useDefaultPasswordManager();
	const offerDefaultManager =
		prefsLoaded && !prefs.defaultManagerPromptDismissed && defaultManager?.state === "browser";

	// The vault's tag vocabulary, for the search bar's `#` suggestions. Taken from ALL
	// entries, archived included: an archived entry is still tagged, and the archive view
	// shares the same search box.
	const tags = useMemo(() => allTags(entries), [entries]);

	// Project each entry into a list row via its mode descriptor (type-agnostic).
	const items = useMemo<VaultListItem[]>(() => {
		const withFiles = new Set(files.map((f) => f.entryId));
		const reused = reusedPasswordIds(entries);
		return entries.map((entry) =>
			toListItem(
				entry,
				showBreaches,
				conflicts.get(entry.id),
				withFiles.has(entry.id),
				reused.has(entry.id),
			),
		);
	}, [entries, files, showBreaches, conflicts]);

	// replace: typing shouldn't stack history entries. A sort is also kept for the next open.
	const onSearchChange = (patch: Partial<VaultSearch>) => {
		if (patch.sort) void update("vaultSort", patch.sort);
		return navigate({ to: "/vault", search: (prev) => ({ ...prev, ...patch }), replace: true });
	};

	const onSelectEntry = useCallback(
		(entryId: string) => navigate({ to: "/vault/$entryId", params: { entryId } }),
		[navigate],
	);
	const onEditEntry = useCallback(
		(entryId: string) => navigate({ to: "/vault/$entryId/edit", params: { entryId } }),
		[navigate],
	);
	const onUseEntry = useCallback((entryId: string) => void touchEntry(entryId), [touchEntry]);
	const duplicate = useDuplicateEntry();
	const onDuplicateEntry = useCallback(
		(entryId: string) => {
			const entry = entries.find((e) => e.id === entryId);
			if (entry) duplicate(entry);
		},
		[entries, duplicate],
	);
	const onAttachEntry = useListAttach();
	const onFillEntry = useMemo(() => {
		if (!shell.fillLogin) return undefined;
		return (entryId: string) => {
			void touchEntry(entryId);
			void shell.fillLogin?.(entryId).then((filled) => {
				if (!filled) show({ message: t`No login form on this page`, variant: "error" });
			});
		};
	}, [shell, touchEntry, show, t]);

	// Until the vault has finished decrypting, `entries` is []; showing VaultHome
	// here would flash "Your vault is empty" on a large vault. Show a loader instead.
	// Prefs too, or the list would open in one order and re-sort into the remembered one.
	if (!ready || !prefsLoaded) {
		return (
			<main className="flex-1 min-h-0 flex flex-col items-center justify-center gap-3 text-muted-foreground">
				<Loader2 className="w-6 h-6 animate-spin" />
				<p className="text-sm">
					<Trans>Opening…</Trans>
				</p>
			</main>
		);
	}

	// Locking: unmount rather than render the list empty, which would scroll it to the top.
	if (isLocked) return null;

	return (
		<VaultHome
			items={items}
			search={search}
			onSearchChange={onSearchChange}
			matchedIds={matchedIds}
			onCreate={(type) => navigate({ to: "/vault/new/$type", params: { type } })}
			onSelectEntry={onSelectEntry}
			onEditEntry={onEditEntry}
			onDeleteEntry={deleteEntry}
			onDuplicateEntry={onDuplicateEntry}
			onAttachEntry={onAttachEntry}
			entries={entries}
			onUseEntry={onUseEntry}
			onFillEntry={onFillEntry}
			tags={tags}
			statsCollapsed={prefs.statsCollapsed}
			onToggleStats={() => void update("statsCollapsed", !prefs.statsCollapsed)}
			initialScrollOffset={
				lockedAt && lockedAt.vault === activeId && lockedAt.href === href
					? lockedAt.offset
					: scrollEntry?.scrollY
			}
			onLeave={(offset) => {
				lockedAt = locking.current ? { vault: activeId, href, offset } : undefined;
			}}
			nudge={
				<VaultListCard
					cards={{
						appUpdate,
						whatsNew,
						mailboxExpiry,
						supportAsk,
						reviewNudge,
						defaultManager: offerDefaultManager
							? {
									onAccept: () => defaultManager?.set(true),
									onDismiss: () => void update("defaultManagerPromptDismissed", true),
								}
							: null,
					}}
				/>
			}
		/>
	);
}
