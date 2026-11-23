import { useLingui } from "@lingui/react/macro";
import { Command } from "lucide-react";
import { type KeyboardEvent, useEffect, useState } from "react";
import { usePlatform } from "../../../../context/PlatformContext";
import {
	DEFAULT_QUICK_ACCESS_SHORTCUT,
	formatShortcut,
	shortcutFromKey,
} from "../../../../util/shortcut";
import { Button } from "../../../components/ui/button";
import { Toggle } from "../../../components/ui/toggle";
import { Row } from "./primitives";

const mac = typeof navigator !== "undefined" && /Mac/.test(navigator.userAgent);

/** Desktop: change Quick Access's global shortcut, or turn it off (#227). */
export function QuickAccessShortcutRow() {
	const { shell } = usePlatform();
	const api = shell.quickAccessShortcut;
	const { t } = useLingui();
	// undefined while reading; null when off.
	const [shortcut, setShortcut] = useState<string | null | undefined>(undefined);
	const [recording, setRecording] = useState(false);
	const [error, setError] = useState<string | null>(null);

	useEffect(() => {
		if (!api) return;
		let live = true;
		api
			.get()
			.then((current) => live && setShortcut(current))
			.catch(() => live && setShortcut(null));
		return () => {
			live = false;
		};
	}, [api]);

	if (!api) return null;

	const save = async (next: string | null) => {
		setError(null);
		try {
			await api.set(next);
			setShortcut(next);
		} catch {
			setError(t`That shortcut is taken or can't be used. Try another.`);
		}
	};

	const record = (e: KeyboardEvent) => {
		e.preventDefault();
		if (e.key === "Escape") {
			setRecording(false);
			return;
		}
		const next = shortcutFromKey(e.nativeEvent, mac);
		if (!next) return; // modifiers only so far, or a key that would fire while typing
		setRecording(false);
		void save(next);
	};

	return (
		<Row
			icon={<Command className="w-4 h-4 text-primary" />}
			title={t`Quick Access shortcut`}
			subtitle={t`Opens Quick Access from any app. Choose the button, then press the keys you want.`}
		>
			<div className="flex flex-col items-end gap-1">
				<div className="flex items-center gap-2">
					{shortcut && (
						<Button
							variant="secondary"
							size="sm"
							className="font-mono"
							aria-label={
								recording ? t`Press the new shortcut` : t`Change the Quick Access shortcut`
							}
							onClick={() => setRecording(true)}
							onKeyDown={recording ? record : undefined}
							onBlur={() => setRecording(false)}
						>
							{recording ? t`Press keys…` : formatShortcut(shortcut, mac)}
						</Button>
					)}
					<Toggle
						checked={!!shortcut}
						onChange={(on) => void save(on ? DEFAULT_QUICK_ACCESS_SHORTCUT : null)}
						disabled={shortcut === undefined}
						label={t`Toggle the Quick Access shortcut`}
					/>
				</div>
				{error && <span className="text-xs text-destructive text-right">{error}</span>}
			</div>
		</Row>
	);
}
