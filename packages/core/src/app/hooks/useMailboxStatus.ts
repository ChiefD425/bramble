import { useEffect, useState } from "react";
import { usePlatform } from "../../context/PlatformContext";
import {
	type AccountRecord,
	type MailboxStatusRecord,
	MailboxStatusRecordSchema,
	mailboxStatusKey,
} from "../../sync/mailbox";
import { accountKeyOf } from "../../sync/mailbox/protocol";

/** The vault's last mailbox round, as the background records it. */
export function useMailboxStatus(vaultId: string | null | undefined): MailboxStatusRecord | null {
	const { storage } = usePlatform();
	const [record, setRecord] = useState<MailboxStatusRecord | null>(null);
	useEffect(() => {
		if (!vaultId) return;
		const key = mailboxStatusKey(vaultId);
		let live = true;
		const read = () =>
			void storage.getMeta<unknown>(key).then((value) => {
				const parsed = MailboxStatusRecordSchema.safeParse(value);
				if (live) setRecord(parsed.success ? parsed.data : null);
			});
		read();
		const off = storage.subscribeMeta?.(key, read);
		return () => {
			live = false;
			off?.();
		};
	}, [storage, vaultId]);
	return record;
}

/**
 * `record` if it was read for `number`. The record says which number it was read for; until a
 * round reads a new one, there is nothing to show for it.
 */
export function useAccountFor(
	record: AccountRecord | undefined,
	number: string | null,
): AccountRecord | undefined {
	const [key, setKey] = useState<string | null>(null);
	useEffect(() => {
		let live = true;
		setKey(null);
		if (number) void accountKeyOf(number).then((k) => live && setKey(k));
		return () => {
			live = false;
		};
	}, [number]);
	return record && key !== null && record.key === key ? record : undefined;
}
