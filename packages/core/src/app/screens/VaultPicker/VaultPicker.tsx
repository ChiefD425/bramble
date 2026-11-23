import { Trans, useLingui } from "@lingui/react/macro";
import { Plus } from "lucide-react";
import { useState } from "react";
import { usePlatform } from "../../../context/PlatformContext";
import { useVaultActions } from "../../../hooks/useVault";
import { useVaultRegistry } from "../../../hooks/useVaultRegistry";
import { BrambleGlyph } from "../../components/BrambleGlyph";
import { Button } from "../../components/ui/button";
import { Modal } from "../../components/ui/modal";
import { TextField } from "../../components/ui/text-field";
import { VaultChoiceList } from "../../components/VaultChoiceList";

/** Launch-time vault chooser, shown when more than one vault exists (see routing guards). */
export function VaultPicker() {
	const { selectVault } = useVaultRegistry();
	const { shell } = usePlatform();
	// Choosing a vault to delete rather than to open (#261).
	const [deleting, setDeleting] = useState(false);
	const [doomed, setDoomed] = useState<{ id: string; label: string } | null>(null);

	return (
		<div className="relative h-screen overflow-y-auto bg-linear-to-br from-background via-background to-primary/5">
			<div className="min-h-full flex items-center justify-center p-6">
				<div className="w-full max-w-md">
					<div className="text-center mb-6">
						<BrambleGlyph className="w-14 h-14 text-foreground mb-3 inline-block" />
						<h1 className="text-xl bg-linear-to-r from-foreground to-foreground/70 bg-clip-text text-transparent">
							{deleting ? (
								<Trans>Choose a vault to delete</Trans>
							) : (
								<Trans>Choose a vault to unlock</Trans>
							)}
						</h1>
					</div>

					<div className="space-y-3">
						<VaultChoiceList
							deleting={deleting}
							onSelect={(id, label) => (deleting ? setDoomed({ id, label }) : selectVault(id))}
						/>
						{!deleting && (
							<Button
								variant="link"
								size="none"
								fullWidth
								onClick={() => void shell.openSetup()}
								className="flex gap-3 rounded-xl border border-dashed border-border/70 p-4 text-left hover:border-primary/50 active:scale-[0.99]"
							>
								<span className="flex-none w-11 h-11 rounded-full bg-primary/10 text-primary flex items-center justify-center">
									<Plus className="w-5 h-5" />
								</span>
								<span className="flex-1 text-sm">
									<Trans>Create new vault</Trans>
								</span>
							</Button>
						)}
						<Button
							variant="link"
							size="none"
							fullWidth
							onClick={() => setDeleting((d) => !d)}
							className="text-xs text-muted-foreground"
						>
							{deleting ? <Trans>Done</Trans> : <Trans>Delete a vault</Trans>}
						</Button>
					</div>
				</div>
			</div>
			{doomed && (
				<DeleteVaultDialog
					vault={doomed}
					onClose={() => setDoomed(null)}
					onDeleted={() => {
						setDoomed(null);
						setDeleting(false);
					}}
				/>
			)}
		</div>
	);
}

/**
 * Delete a closed vault from this device (#261), confirmed by typing its name. No password: it
 * may be one that won't open, or one whose password is gone, and nothing open is at stake.
 */
function DeleteVaultDialog({
	vault,
	onClose,
	onDeleted,
}: {
	vault: { id: string; label: string };
	onClose: () => void;
	onDeleted: () => void;
}) {
	const { deleteLockedVault } = useVaultActions();
	const { t } = useLingui();
	const [typed, setTyped] = useState("");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const matches = typed.trim() === vault.label;

	const confirm = async () => {
		setBusy(true);
		setError(null);
		try {
			if (await deleteLockedVault(vault.id)) onDeleted();
			else setError(t`Lock this vault first, or delete it from Settings.`);
		} catch (err) {
			setError((err as Error).message);
		} finally {
			setBusy(false);
		}
	};

	return (
		<Modal open onClose={() => !busy && onClose()} className="max-w-sm">
			<form
				className="p-5 space-y-4"
				onSubmit={(e) => {
					e.preventDefault();
					if (matches && !busy) void confirm();
				}}
			>
				<h2 className="text-base font-medium">
					<Trans>Delete {vault.label}?</Trans>
				</h2>
				<p className="text-xs text-muted-foreground">
					<Trans>
						Everything in it is deleted from this device and can't be recovered here. Copies on your
						other devices and in backups aren't affected.
					</Trans>
				</p>
				<TextField
					label={t`Type ${vault.label} to confirm`}
					value={typed}
					autoFocus
					autoComplete="off"
					onChange={(e) => setTyped(e.target.value)}
				/>
				{error && <p className="text-xs text-destructive">{error}</p>}
				<div className="flex justify-end gap-2">
					<Button variant="secondary" size="sm" onClick={onClose} disabled={busy}>
						<Trans>Cancel</Trans>
					</Button>
					<Button type="submit" variant="destructive" size="sm" disabled={!matches || busy}>
						{busy ? <Trans>Deleting…</Trans> : <Trans>Delete vault</Trans>}
					</Button>
				</div>
			</form>
		</Modal>
	);
}
