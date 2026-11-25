import type { AppUpdateNotice } from "../hooks/useAppUpdate";
import { useCardSlot } from "../hooks/useCardSlot";
import type { MailboxExpiry } from "../hooks/useMailboxExpiry";
import type { ReviewNudge } from "../hooks/useReviewNudge";
import type { SupportAsk } from "../hooks/useSupportAsk";
import type { WhatsNewNotice } from "../hooks/useWhatsNew";
import { DefaultManagerCard } from "./DefaultManagerCard";
import { MailboxExpiryCard } from "./MailboxExpiryCard";
import { ReviewNudgeCard } from "./ReviewNudgeCard";
import { SupportCard } from "./SupportCard";
import { UpdateCard } from "./UpdateCard";
import { WhatsNewCard } from "./WhatsNewCard";

export interface VaultListCards {
	appUpdate: AppUpdateNotice | null;
	whatsNew: WhatsNewNotice | null | undefined;
	mailboxExpiry: MailboxExpiry | null;
	supportAsk: SupportAsk | null;
	reviewNudge: ReviewNudge | null;
	defaultManager: { onAccept(): void; onDismiss(): void } | null;
}

/**
 * The card under the vault list: the first that applies, and none for the rest of an open once
 * one is closed or acted on. The update comes first, as it may carry a security fix, and the
 * notes on this version wait for the next. The mailbox's paid time running out comes next: once
 * it has ended that card can't be closed, so it holds back the rest until it is acted on. The
 * donation card (docs/support-ask.md) comes once a fortnight, so it goes ahead of the cards that
 * wait to be acted on, which could otherwise hold it back for good. See docs/whats-new.md.
 */
export function VaultListCard({ cards }: { cards: VaultListCards }) {
	const slot = useCardSlot();
	if (slot.closed) return null;
	const closing =
		<A extends unknown[]>(fn: (...args: A) => void) =>
		(...args: A) => {
			fn(...args);
			slot.close();
		};
	const { appUpdate, whatsNew, mailboxExpiry, supportAsk, reviewNudge, defaultManager } = cards;
	if (appUpdate)
		return <UpdateCard update={{ ...appUpdate, onDismiss: closing(appUpdate.onDismiss) }} />;
	if (whatsNew)
		return <WhatsNewCard notice={{ ...whatsNew, onClose: closing(whatsNew.onClose) }} />;
	if (mailboxExpiry)
		return (
			<MailboxExpiryCard
				expiry={{
					...mailboxExpiry,
					onClose: mailboxExpiry.onClose && closing(mailboxExpiry.onClose),
					onStop: async () => {
						await mailboxExpiry.onStop();
						slot.close();
					},
				}}
				onBuy={slot.close}
			/>
		);
	if (supportAsk)
		return (
			<SupportCard
				ask={{
					...supportAsk,
					onDonate: closing(supportAsk.onDonate),
					onDismiss: closing(supportAsk.onDismiss),
				}}
			/>
		);
	if (reviewNudge)
		return (
			<ReviewNudgeCard
				nudge={{
					...reviewNudge,
					onRated: closing(reviewNudge.onRated),
					onDismiss: closing(reviewNudge.onDismiss),
				}}
			/>
		);
	if (defaultManager)
		return (
			<DefaultManagerCard
				onAccept={closing(defaultManager.onAccept)}
				onDismiss={closing(defaultManager.onDismiss)}
			/>
		);
	return null;
}
