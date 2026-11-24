import { Trans, useLingui } from "@lingui/react/macro";
import { ExternalLink, Heart, X } from "lucide-react";
import { useEffect } from "react";
import type { SupportAsk } from "../hooks/useSupportAsk";
import { Button, buttonClasses } from "./ui/button";

/** The every-two-weeks donation ask, styled like WhatsNewCard. See docs/support-ask.md. */
export function SupportCard({ ask }: { ask: SupportAsk }) {
	const { t } = useLingui();
	const { onShown } = ask;
	useEffect(() => onShown(), [onShown]);
	return (
		<div className="relative shrink-0 mt-3 rounded-lg border border-border bg-muted/40 p-3 space-y-2">
			<Button
				variant="ghost"
				size="none"
				onClick={ask.onDismiss}
				aria-label={t`Dismiss`}
				className="absolute top-1.5 right-1.5 p-1.5 text-muted-foreground"
			>
				<X className="w-3.5 h-3.5" />
			</Button>
			<p className="flex items-center gap-1.5 pr-6 text-sm">
				<Heart className="w-4 h-4 shrink-0 text-primary" />
				<Trans>Support Bramble</Trans>
			</p>
			<p className="pr-6 text-xs text-muted-foreground">
				<Trans>
					Bramble is free, with no ads and no investors. Donations pay for its development and
					security audits.
				</Trans>
			</p>
			{/* An anchor: the extension opens it in a new tab, the apps in the browser. */}
			<a
				href={ask.url}
				target="_blank"
				rel="noreferrer noopener"
				onClick={ask.onDonate}
				className={buttonClasses({ variant: "primary", size: "sm" })}
			>
				<Trans>Donate</Trans>
				<ExternalLink className="w-3.5 h-3.5" />
			</a>
		</div>
	);
}
