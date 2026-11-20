import { Plural, Trans, useLingui } from "@lingui/react/macro";
import { UnexportablePasskeyError } from "../../../../export/kdbx";
import { useVault } from "../../../../hooks/useVault";
import { FilePasswordDialog } from "../../../components/ui/file-password-dialog";

/**
 * Collects the password for a whole-vault KeePass export. The file is meant to be opened by
 * another manager, so it is deliberately NOT protected by the master password. It carries every
 * attachment, as KeePass attachments, and every passkey, as KeePassXC stores them. What it can't
 * keep is the entry type: KeePass only models a login. The .bramble export in the vault list's
 * bulk actions is the lossless route.
 */
export function KdbxExportDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
	const { t } = useLingui();
	const { exportKdbx, conflicts } = useVault();
	// Only the shown version goes into the file, so say when there are others it leaves out.
	const conflicted = [...conflicts.values()].filter((c) => c.versions > 0).length;

	const submit = (password: string) =>
		exportKdbx(password).catch((e: unknown) => {
			if (!(e instanceof UnexportablePasskeyError)) throw e;
			const name = e.entryName;
			throw new Error(
				t`A passkey on "${name}" is damaged, so it can't be exported. Remove it, then try again.`,
			);
		});

	return (
		<FilePasswordDialog
			open={open}
			onClose={onClose}
			title={<Trans>Export as KeePass (.kdbx)</Trans>}
			description={
				<Trans>
					Pick a password for the exported file. It's separate from your master password, and it's
					the only way to open the file: we don't keep a copy. Your attachments and passkeys go with
					it.
				</Trans>
			}
			detail={
				conflicted > 0 ? (
					<Plural
						value={conflicted}
						one="# entry has a sync conflict. Only the version you see is exported."
						other="# entries have a sync conflict. Only the version you see is exported."
					/>
				) : undefined
			}
			submitLabel={<Trans>Export</Trans>}
			busyLabel={<Trans>Exporting…</Trans>}
			onSubmit={submit}
		/>
	);
}
