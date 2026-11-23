import { Plural, Trans, useLingui } from "@lingui/react/macro";
import { ChevronDown, ExternalLink, Newspaper, X } from "lucide-react";
import { useState } from "react";
import type { WhatsNewNotice } from "../hooks/useWhatsNew";
import { Button, buttonClasses } from "./ui/button";

/**
 * The card after an update. Styled like UpdateCard; see docs/whats-new.md. Unlike the other cards
 * it may shrink: the extension popup is 550px tall, so open changes scroll inside the card rather
 * than pushing its buttons off the bottom.
 */
export function WhatsNewCard({ notice }: { notice: WhatsNewNotice }) {
	const { t } = useLingui();
	const [open, setOpen] = useState(false);
	const { version, notes } = notice;
	const count = notes.items.length;
	return (
		<div className="relative min-h-0 mt-3 flex flex-col gap-2 rounded-lg border border-border bg-muted/40 p-3">
			<Button
				variant="ghost"
				size="none"
				onClick={notice.onClose}
				aria-label={t`Dismiss`}
				className="absolute top-1.5 right-1.5 p-1.5 text-muted-foreground"
			>
				<X className="w-3.5 h-3.5" />
			</Button>
			<p className="shrink-0 flex items-center gap-1.5 pr-6 text-sm">
				<Newspaper className="w-4 h-4 shrink-0 text-primary" />
				<Trans>What's new in {version}</Trans>
			</p>
			{notes.headline && (
				<p className="shrink-0 pr-6 text-xs text-muted-foreground">{notes.headline}</p>
			)}
			{open && (
				<ul
					id="whats-new-changes"
					className="min-h-0 max-h-40 overflow-y-auto list-disc pl-4 pr-1 space-y-1 text-xs"
				>
					{notes.items.map((item) => (
						<li key={item}>{item}</li>
					))}
				</ul>
			)}
			<div className="shrink-0 flex flex-wrap items-center gap-2">
				{count > 0 && (
					<Button
						variant="secondary"
						size="sm"
						aria-expanded={open}
						aria-controls="whats-new-changes"
						onClick={() => setOpen((v) => !v)}
					>
						{open ? (
							<Trans>Hide changes</Trans>
						) : (
							<Plural value={count} one="Show # change" other="Show # changes" />
						)}
						<ChevronDown
							className={`w-3.5 h-3.5 transition-transform ${open ? "rotate-180" : ""}`}
						/>
					</Button>
				)}
				{/* An anchor: the extension opens it in a new tab and mobile in the browser. Following
				    it ends the card like closing it does. */}
				<a
					href={notice.url}
					target="_blank"
					rel="noreferrer noopener"
					onClick={notice.onClose}
					className={buttonClasses({ variant: "primary", size: "sm" })}
				>
					<Trans>Read more</Trans>
					<ExternalLink className="w-3.5 h-3.5" />
				</a>
			</div>
		</div>
	);
}
