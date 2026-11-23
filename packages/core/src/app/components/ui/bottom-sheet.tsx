import { useLingui } from "@lingui/react/macro";
import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";

interface BottomSheetProps {
	onClose: () => void;
	/** The id of the sheet's heading, for the dialog's accessible name. */
	labelledBy: string;
	children: React.ReactNode;
}

/**
 * A dialog that rises from the bottom edge, over a dimmed backdrop. Esc and the backdrop close it,
 * as with Modal. Narrow on a wide window, and clear of the home indicator on a phone.
 */
export function BottomSheet({ onClose, labelledBy, children }: BottomSheetProps) {
	const { t } = useLingui();
	const panel = useRef<HTMLDivElement>(null);

	useEffect(() => {
		const onKey = (e: KeyboardEvent) => {
			if (e.key === "Escape") onClose();
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [onClose]);

	// Focus moves in, so a screen reader announces the sheet and a keyboard starts inside it.
	useEffect(() => {
		panel.current?.focus();
		const previous = document.body.style.overflow;
		document.body.style.overflow = "hidden";
		return () => {
			document.body.style.overflow = previous;
		};
	}, []);

	return createPortal(
		<div className="fixed inset-0 z-50 flex items-end justify-center">
			<button
				type="button"
				aria-label={t`Close`}
				tabIndex={-1}
				onClick={onClose}
				className="absolute inset-0 bg-black/50 backdrop-blur-sm motion-safe:animate-in motion-safe:fade-in"
			/>
			<div
				ref={panel}
				role="dialog"
				aria-modal="true"
				aria-labelledby={labelledBy}
				tabIndex={-1}
				className="relative w-full max-w-md max-h-full overflow-y-auto rounded-t-2xl border border-b-0 border-border bg-card px-5 pt-6 pb-[max(1.25rem,env(safe-area-inset-bottom))] shadow-xl outline-none motion-safe:animate-in motion-safe:slide-in-from-bottom motion-safe:duration-300"
			>
				{children}
			</div>
		</div>,
		document.body,
	);
}
