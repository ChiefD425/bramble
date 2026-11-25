import { useEffect, useState } from "react";
import { useCan, usePlatform } from "../../context/PlatformContext";
import { usePrefs } from "../../hooks/usePrefs";
import { useVaultRegistry } from "../../hooks/useVaultRegistry";
import { accountPageUrl } from "../../sync/mailbox/protocol";
import {
	type ExpiryClosed,
	expiryStage,
	isExpiryClosed,
	mailboxExpiryClosedKey,
} from "../mailbox-expiry";
import { useAccountFor, useMailboxStatus } from "./useMailboxStatus";

export interface MailboxExpiry {
	stage: "ending" | "ended";
	paidThrough: number;
	/** Where to add time; null on iOS, which shows the date and nothing more. */
	buyUrl: string | null;
	/** The corner X, while the time hasn't ended yet. */
	onClose?: () => void;
	/** Stops the mailbox for the whole group, which ends the card on every device. */
	onStop(): Promise<void>;
}

/**
 * The vault list's card for the hosted mailbox's paid time, from 14 days out (docs/mailbox-service.md,
 * "The paid-time card"). Not where this device has the mailbox off, nor for a frozen account, which
 * the Mailbox card explains.
 */
export function useMailboxExpiry(): MailboxExpiry | null {
	const { storage } = usePlatform();
	const { prefs, loaded, update } = usePrefs();
	const { activeId } = useVaultRegistry();
	const purchase = useCan("mailboxPurchase");
	const status = useMailboxStatus(activeId);
	const number = prefs.mailboxAccount;
	const account = useAccountFor(status?.account, number);
	const [closed, setClosed] = useState<ExpiryClosed | undefined | null>(null);

	useEffect(() => {
		setClosed(null);
		if (!activeId) return;
		let live = true;
		void storage.getMeta<unknown>(mailboxExpiryClosedKey(activeId)).then((raw) => {
			if (live) setClosed(isExpiryClosed(raw) ? raw : undefined);
		});
		return () => {
			live = false;
		};
	}, [storage, activeId]);

	const applies =
		loaded &&
		prefs.mailbox?.kind === "hosted" &&
		!prefs.mailboxOff &&
		status?.status !== "off" &&
		status?.status !== "other_vault";
	if (!applies || !activeId || !number || !account || "unknown" in account || account.frozen)
		return null;
	if (closed === null) return null;
	const stage = expiryStage(account.paidThrough, closed, Date.now());
	if (!stage) return null;
	const paidThrough = account.paidThrough;
	return {
		stage,
		paidThrough,
		buyUrl: purchase ? accountPageUrl(number) : null,
		onClose:
			stage === "ending"
				? () => {
						const next = { paidThrough, at: Date.now() };
						setClosed(next);
						void storage.setMeta(mailboxExpiryClosedKey(activeId), next);
					}
				: undefined,
		onStop: () => update("mailbox", null),
	};
}
