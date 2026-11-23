import { Trans } from "@lingui/react/macro";
import { Heart } from "lucide-react";
import { useEffect } from "react";
import type { SupportAsk } from "../hooks/useSupportAsk";
import { BottomSheet } from "./ui/bottom-sheet";
import { Button, buttonClasses } from "./ui/button";

/** The every-two-weeks donation ask. See docs/support-ask.md. */
export function SupportSheet({ ask }: { ask: SupportAsk }) {
	const { onShown } = ask;
	useEffect(() => onShown(), [onShown]);
	return (
		<BottomSheet onClose={ask.onDismiss} labelledBy="support-ask-title">
			<div className="flex flex-col items-center gap-3 text-center">
				<span className="flex h-12 w-12 items-center justify-center rounded-full bg-primary/10">
					<Heart className="h-6 w-6 text-primary" />
				</span>
				<h2 id="support-ask-title" className="text-base">
					<Trans>Support Bramble</Trans>
				</h2>
				<p className="text-sm text-muted-foreground">
					<Trans>
						Bramble is free, with no ads and no investors. Donations pay for its development and
						security audits.
					</Trans>
				</p>
				<div className="mt-2 flex w-full flex-col gap-2">
					{/* An anchor: the extension opens it in a new tab, the apps in the browser. */}
					<a
						href={ask.url}
						target="_blank"
						rel="noreferrer noopener"
						onClick={ask.onDonate}
						className={buttonClasses({ variant: "primary", fullWidth: true })}
					>
						<Heart className="h-4 w-4" />
						<Trans>Donate</Trans>
					</a>
					<Button variant="ghost" fullWidth onClick={ask.onDismiss}>
						<Trans>Not now</Trans>
					</Button>
				</div>
			</div>
		</BottomSheet>
	);
}
