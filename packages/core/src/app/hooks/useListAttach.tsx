import { useLingui } from "@lingui/react/macro";
import { useNavigate } from "@tanstack/react-router";
import { useCallback, useRef } from "react";
import type { AttachInput } from "../../vault/file-mutations";
import { useToast } from "../components/ui/toast";
import { fileToAttach, useAttach } from "../entry-modes/attachments";

/**
 * Attach a file from the vault list's menu (#260), through the entry's own flow. A row has no
 * room for progress or an error, so toasts report them. Undefined where files can't be added.
 */
export function useListAttach(): ((entryId: string) => void) | undefined {
	const attach = useAttach();
	const toast = useToast();
	const navigate = useNavigate();
	const { t } = useLingui();
	const pending = useRef<HTMLInputElement | null>(null);

	const run = useCallback(
		async (input: AttachInput) => {
			const busy = toast.show({ message: t`Encrypting…`, variant: "info", durationMs: 0 });
			try {
				await attach.attach(input);
				toast.dismiss(busy);
				toast.show({ message: t`Attached ${input.name}`, variant: "success" });
			} catch (err) {
				toast.dismiss(busy);
				toast.show({ message: attach.describeError(err), variant: "error" });
			}
		},
		[attach, toast, t],
	);

	const onAttach = useCallback(
		(entryId: string) => {
			if (attach.needsWindow) {
				// The popup would close under the picker: carry on from the entry, in a window.
				void navigate({ to: "/vault/$entryId", params: { entryId } }).then(() => attach.popOut());
				return;
			}
			if (attach.canPickFiles) {
				attach.pick().then(
					(picked) => picked && run({ ...picked, entryId }),
					(err: unknown) => toast.show({ message: (err as Error).message, variant: "error" }),
				);
				return;
			}
			// Made here, inside the menu's click, since a file input opens only on a user gesture,
			// and removed once used: a standing hidden one would sit in the list for nothing.
			pending.current?.remove(); // one whose picker was dismissed without a cancel event
			const input = document.createElement("input");
			input.type = "file";
			input.hidden = true;
			pending.current = input;
			const done = () => {
				input.remove();
				if (pending.current === input) pending.current = null;
			};
			input.addEventListener("cancel", done, { once: true });
			input.addEventListener(
				"change",
				() => {
					const file = input.files?.[0];
					done();
					if (file) void run(fileToAttach(file, entryId));
				},
				{ once: true },
			);
			document.body.append(input);
			attach.notifyPickerOpening();
			input.click();
		},
		[attach, navigate, run, toast],
	);

	return attach.available ? onAttach : undefined;
}
