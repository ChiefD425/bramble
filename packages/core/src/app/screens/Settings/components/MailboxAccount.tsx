// The hosted mailbox's account on the Mailbox card (docs/mailbox-service.md, "Buying from the
// apps"): signing in with a number, its paid time and storage, and everywhere but iOS, where to
// get a number and add time. iOS shows no price and no link to the website.

import { i18n } from "@lingui/core";
import { Trans, useLingui } from "@lingui/react/macro";
import { type ReactNode, useState } from "react";
import { useCan, usePlatform } from "../../../../context/PlatformContext";
import { usePrefs } from "../../../../hooks/usePrefs";
import type { AccountRecord } from "../../../../sync/mailbox";
import { accountPageUrl, parseAccountNumber } from "../../../../sync/mailbox/protocol";
import { formatStorage } from "../../../../util/storage-size";
import { Button, buttonClasses } from "../../../components/ui/button";
import { TextField } from "../../../components/ui/text-field";
import { useAccountFor } from "../../../hooks/useMailboxStatus";
import { EXPIRY_NOTICE_DAYS, paidDate } from "../../../mailbox-expiry";

const DAY_MS = 86_400_000;

const external = { target: "_blank", rel: "noreferrer noopener" } as const;

function NumberForm({
	submitLabel,
	onSave,
	disabledReason,
}: {
	submitLabel: ReactNode;
	onSave(number: string): void;
	/** Shown under the field, which is then disabled with its button. */
	disabledReason?: ReactNode;
}) {
	const { t } = useLingui();
	const [value, setValue] = useState("");
	const [bad, setBad] = useState(false);
	const submit = () => {
		const parsed = parseAccountNumber(value);
		setBad(!parsed);
		if (parsed) onSave(parsed);
	};
	return (
		<div className="space-y-2">
			<TextField
				label={t`Account number`}
				value={value}
				inputMode="numeric"
				autoComplete="off"
				onChange={(e) => setValue(e.target.value)}
				error={bad ? <Trans>An account number is 25 digits</Trans> : undefined}
				disabled={!!disabledReason}
			/>
			{disabledReason && <p className="text-xs text-muted-foreground">{disabledReason}</p>}
			<Button size="sm" onClick={submit} disabled={!!disabledReason}>
				{submitLabel}
			</Button>
		</div>
	);
}

/**
 * Before the group has a mailbox: Bramble's, signed in to with an account number. Disabled, with
 * `disabledReason` under the field, while there's no group to sign in for.
 */
export function HostedSignIn({ disabledReason }: { disabledReason?: ReactNode }) {
	const { update } = usePrefs();
	const purchase = useCan("mailboxPurchase");
	const signIn = async (number: string) => {
		await update("mailboxAccount", number);
		await update("mailbox", { kind: "hosted" });
	};
	return (
		<div className="space-y-3 rounded-md border border-border p-3">
			<div className="text-sm font-medium">
				<Trans>Bramble Mailbox</Trans>
			</div>
			{purchase && (
				<p className="text-sm text-muted-foreground">
					<Trans>$2 a month, at least 6 months at a time.</Trans>{" "}
					<a href={accountPageUrl()} {...external} className="underline">
						<Trans>Get an account number</Trans>
					</a>
				</p>
			)}
			<NumberForm
				submitLabel={<Trans>Sign in</Trans>}
				onSave={(n) => void signIn(n)}
				disabledReason={disabledReason}
			/>
			{!disabledReason && (
				<Button
					variant="ghost"
					size="sm"
					onClick={() => void update("mailbox", { kind: "hosted" })}
				>
					<Trans>My other devices already use it</Trans>
				</Button>
			)}
		</div>
	);
}

function PaidLines({ record }: { record: Exclude<AccountRecord, { unknown: true }> }) {
	const locale = i18n.locale || "en";
	const date = paidDate(record.paidThrough, locale);
	const used = formatStorage(record.usedBytes, locale);
	const quota = formatStorage(record.quotaBytes, locale);
	const left = record.paidThrough - Date.now();
	let paid: ReactNode;
	if (record.frozen) paid = <Trans>Posting is paused for this account</Trans>;
	else if (record.paidThrough === 0) paid = <Trans>No paid time yet</Trans>;
	else if (left <= 0) paid = <Trans>Paid time ended {date}</Trans>;
	else if (left <= EXPIRY_NOTICE_DAYS * DAY_MS)
		paid = (
			<span className="text-amber-600">
				<Trans>Paid time ends {date}</Trans>
			</span>
		);
	else paid = <Trans>Paid through {date}</Trans>;
	return (
		<div className="space-y-0.5 text-sm">
			<div>{paid}</div>
			<div className="text-muted-foreground">
				<Trans>
					{used} of {quota} used
				</Trans>
			</div>
		</div>
	);
}

/** The group's account: its number, its paid time and storage, and changing the number. */
export function HostedAccount({ record }: { record: AccountRecord | undefined }) {
	const { clipboard } = usePlatform();
	const { prefs, update } = usePrefs();
	const purchase = useCan("mailboxPurchase");
	const [shown, setShown] = useState(false);
	const [changing, setChanging] = useState(false);
	const number = prefs.mailboxAccount;
	const current = useAccountFor(record, number);
	const save = (next: string) => {
		setChanging(false);
		void update("mailboxAccount", next);
	};
	if (!number || changing) return <NumberForm submitLabel={<Trans>Save</Trans>} onSave={save} />;
	return (
		<div className="space-y-2">
			<div className="flex items-center justify-between gap-2">
				<span className="font-mono text-sm">
					{shown ? number : `••••• ••••• ••••• ••••• ${number.slice(-5)}`}
				</span>
				<div className="flex gap-1">
					<Button variant="ghost" size="sm" onClick={() => setShown(!shown)}>
						{shown ? <Trans>Hide</Trans> : <Trans>Show</Trans>}
					</Button>
					<Button variant="ghost" size="sm" onClick={() => void clipboard.copy(number)}>
						<Trans>Copy</Trans>
					</Button>
				</div>
			</div>
			{current &&
				("unknown" in current ? (
					<p className="text-sm text-destructive">
						<Trans>The mailbox doesn't recognize this account number</Trans>
					</p>
				) : (
					<PaidLines record={current} />
				))}
			<div className="flex flex-wrap gap-2">
				{purchase && (
					<a
						href={accountPageUrl(number)}
						{...external}
						className={buttonClasses({ variant: "secondary", size: "sm" })}
					>
						<Trans>Add time</Trans>
					</a>
				)}
				<Button variant="secondary" size="sm" onClick={() => setChanging(true)}>
					<Trans>Change account number</Trans>
				</Button>
			</div>
		</div>
	);
}
