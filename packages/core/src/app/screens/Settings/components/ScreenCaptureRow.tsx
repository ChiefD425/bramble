import { useLingui } from "@lingui/react/macro";
import { CameraOff } from "lucide-react";
import { usePlatform } from "../../../../context/PlatformContext";
import { usePrefs } from "../../../../hooks/usePrefs";
import { Button } from "../../../components/ui/button";
import { Toggle } from "../../../components/ui/toggle";
import { useScreenCapture } from "../../../screen-capture";
import { Row } from "./primitives";

const mac = typeof navigator !== "undefined" && /Mac/.test(navigator.userAgent);

/** "Block screenshots", with a 10-minute pause. See docs/screen-capture-blocking.md. */
export function ScreenCaptureRow() {
	const { prefs, loaded, update } = usePrefs();
	const { target } = usePlatform();
	const capture = useScreenCapture();
	const { t, i18n } = useLingui();

	if (!capture.available || !loaded) return null;

	const blocked = prefs.screenCaptureBlocked;
	const paused = blocked && capture.pausedUntil !== null;
	const until = paused
		? new Date(capture.pausedUntil ?? 0).toLocaleTimeString(i18n.locale, {
				hour: "numeric",
				minute: "2-digit",
			})
		: "";
	// macOS's ScreenCaptureKit ignores the window setting, and most capture tools now use it.
	const about =
		target !== "desktop"
			? t`Keeps Bramble out of screenshots, screen recordings and AI assistants.`
			: mac
				? t`Asks macOS to keep Bramble out of screenshots and screen sharing. Many apps ignore it.`
				: t`Keeps Bramble out of screenshots, screen sharing and Recall.`;

	return (
		<div className="space-y-2">
			<Row
				icon={<CameraOff className="w-4 h-4 text-primary" />}
				title={t`Block screenshots`}
				subtitle={paused ? t`Screenshots allowed until ${until}` : about}
			>
				<Toggle
					checked={blocked}
					onChange={(on) => {
						void capture.setBlocked(on);
						void update("screenCaptureBlocked", on);
					}}
					label={t`Toggle block screenshots`}
				/>
			</Row>
			{blocked && (
				<div className="pl-12">
					{paused ? (
						<Button size="sm" onClick={() => void capture.setBlocked(true)}>
							{t`Block now`}
						</Button>
					) : (
						<Button size="sm" onClick={() => void capture.pause()}>
							{t`Allow for 10 minutes`}
						</Button>
					)}
				</div>
			)}
		</div>
	);
}
