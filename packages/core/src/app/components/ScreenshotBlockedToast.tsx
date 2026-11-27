import { useLingui } from "@lingui/react/macro";
import { CameraOff } from "lucide-react";
import { useEffect } from "react";
import { usePlatform } from "../../context/PlatformContext";
import { pauseScreenCapture } from "../screen-capture";
import { useToast } from "./ui/toast";

/** iOS saves a blank screenshot without a word, so say why and offer the pause. Renders nothing. */
export function ScreenshotBlockedToast() {
	const { shell } = usePlatform();
	const { show } = useToast();
	const { t } = useLingui();

	useEffect(() => {
		const control = shell.screenCapture;
		if (!control?.onBlockedScreenshot) return;
		return control.onBlockedScreenshot(() => {
			show({
				message: t`Screenshots are blocked`,
				icon: CameraOff,
				// Long, since the screenshot's own preview covers part of the screen at first.
				durationMs: 8000,
				action: {
					label: t`Allow for 10 minutes`,
					onClick: () => void pauseScreenCapture(control),
				},
			});
		});
	}, [shell, show, t]);

	return null;
}
