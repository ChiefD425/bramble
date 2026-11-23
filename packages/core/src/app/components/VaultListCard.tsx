import type { AppUpdateNotice } from "../hooks/useAppUpdate";
import { useCardSlot } from "../hooks/useCardSlot";
import type { ReviewNudge } from "../hooks/useReviewNudge";
import type { WhatsNewNotice } from "../hooks/useWhatsNew";
import { DefaultManagerCard } from "./DefaultManagerCard";
import { ReviewNudgeCard } from "./ReviewNudgeCard";
import { UpdateCard } from "./UpdateCard";
import { WhatsNewCard } from "./WhatsNewCard";

export interface VaultListCards {
	appUpdate: AppUpdateNotice | null;
	whatsNew: WhatsNewNotice | null | undefined;
	reviewNudge: ReviewNudge | null;
	defaultManager: { onAccept(): void; onDismiss(): void } | null;
}

/**
 * The card under the vault list: the first that applies, and none for the rest of an open once
 * one is closed or acted on. The update comes first, as it may carry a security fix, and the
 * notes on this version wait for the next. See docs/whats-new.md.
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
	const { appUpdate, whatsNew, reviewNudge, defaultManager } = cards;
	if (appUpdate)
		return <UpdateCard update={{ ...appUpdate, onDismiss: closing(appUpdate.onDismiss) }} />;
	if (whatsNew)
		return <WhatsNewCard notice={{ ...whatsNew, onClose: closing(whatsNew.onClose) }} />;
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
