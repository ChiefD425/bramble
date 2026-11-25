import { i18n } from "@lingui/core";
import { Trans, useLingui } from "@lingui/react/macro";
import { CalendarClock, ExternalLink, X } from "lucide-react";
import { useState } from "react";
import type { MailboxExpiry } from "../hooks/useMailboxExpiry";
import { paidDate } from "../mailbox-expiry";
import { Button, buttonClasses } from "./ui/button";
import { InlineConfirm } from "./ui/inline-confirm";

/**
 * The hosted mailbox's paid time is ending or has ended, styled like SupportCard. On iOS it states
 * the date and offers no way to buy. See docs/mailbox-service.md, "The paid-time card".
 */
export function MailboxExpiryCard({
	expiry,
	onBuy,
}: {
	expiry: MailboxExpiry;
	/** Buy more time was followed. */
	onBuy(): void;
}) {
	const { t } = useLingui();
	const date = paidDate(expiry.paidThrough, i18n.locale || "en");
	const ended = expiry.stage === "ended";
	const [stopping, setStopping] = useState(false);
	return (
		<div className="relative shrink-0 mt-3 rounded-lg border border-border bg-muted/40 p-3 space-y-2">
			{expiry.onClose && (
				<Button
					variant="ghost"
					size="none"
					onClick={expiry.onClose}
					aria-label={t`Dismiss`}
					className="absolute top-1.5 right-1.5 p-1.5 text-muted-foreground"
				>
					<X className="w-3.5 h-3.5" />
				</Button>
			)}
			<p className="flex items-center gap-1.5 pr-6 text-sm">
				<CalendarClock className="w-4 h-4 shrink-0 text-primary" />
				{ended ? <Trans>Mailbox time ended {date}</Trans> : <Trans>Mailbox time ends {date}</Trans>}
			</p>
			<p className="pr-6 text-xs text-muted-foreground">
				{ended ? (
					<Trans>Your devices sync only when they're online together.</Trans>
				) : (
					<Trans>After that, your devices sync only when they're online together.</Trans>
				)}
			</p>
			<div className="flex flex-wrap items-center gap-2">
				{/* An anchor: the extension opens it in a new tab, the apps in the browser. */}
				{expiry.buyUrl && !stopping && (
					<a
						href={expiry.buyUrl}
						target="_blank"
						rel="noreferrer noopener"
						onClick={onBuy}
						className={buttonClasses({ variant: "primary", size: "sm" })}
					>
						<Trans>Buy more time</Trans>
						<ExternalLink className="w-3.5 h-3.5" />
					</a>
				)}
				<InlineConfirm
					variant="destructiveOutline"
					layout="stacked"
					armed={stopping}
					onArmedChange={setStopping}
					className="w-full"
					prompt={<Trans>Every device stops syncing through it.</Trans>}
					note={
						expiry.buyUrl ? (
							<Trans>Your account stays. To delete it, use the account page.</Trans>
						) : undefined
					}
					confirmLabel={<Trans>Stop</Trans>}
					onConfirm={expiry.onStop}
					trigger={(arm) => (
						<Button variant="secondary" size="sm" onClick={arm} className="text-muted-foreground">
							<Trans>Stop using the mailbox</Trans>
						</Button>
					)}
				/>
			</div>
		</div>
	);
}
