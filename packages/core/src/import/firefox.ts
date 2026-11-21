// Firefox's CSV export (about:logins → ⋯ → Export Passwords). Every row is a login; there are no
// folders, notes or one-time codes. docs/firefox-import.md records the format.

import type { EntryData } from "../hooks/useVault";
import { assertFormat, FIREFOX_CSV, headerLabels } from "./csv-format";
import { asText, hostLabel, parseCsvRows, summarize, toCustomFields } from "./shared";
import type { ImportResult } from "./types";

// Firefox keeps its own Mozilla account sign-in as a login on this origin, and exports it with
// the rest. Its "password" is the account's Sync key, not a password, and Firefox itself never
// shows it (LoginHelper.isUserFacingLogin), so it doesn't come across.
const ACCOUNT_ORIGIN = "chrome://FirefoxAccounts";

/** Epoch ms, or undefined for a blank or zero cell. */
function ms(cell: string): number | undefined {
	const n = Number(cell);
	return Number.isFinite(n) && n > 0 ? n : undefined;
}

/** Parse a Firefox CSV export (`url,username,password,httpRealm,formActionOrigin,…`). */
export function parseFirefox(raw: string | Uint8Array): ImportResult {
	const rows = parseCsvRows(asText(raw));
	const header = headerLabels(rows[0]);
	assertFormat(FIREFOX_CSV, header);

	const col = (name: string) => header.indexOf(name);
	const cols = {
		url: col("url"),
		username: col("username"),
		password: col("password"),
		realm: col("httprealm"),
		created: col("timecreated"),
		used: col("timelastused"),
		changed: col("timepasswordchanged"),
	};
	const at = (row: string[], i: number): string => (i === -1 ? "" : (row[i] ?? ""));

	const imported: EntryData[] = [];
	let skipped = 0;

	for (const row of rows.slice(1)) {
		const url = at(row, cols.url);
		if (url === ACCOUNT_ORIGIN) continue;
		const username = at(row, cols.username);
		const password = at(row, cols.password);
		if (!url && !username && !password) {
			skipped++;
			continue;
		}
		// Set only on a site's own sign-in dialog (HTTP authentication), which can sit beside a
		// form login for the same site; the realm tells the two apart.
		const realm = at(row, cols.realm);
		imported.push({
			type: "login",
			name: hostLabel(url) || username,
			urls: url ? [url] : [],
			username,
			password,
			customFields: toCustomFields([{ key: "HTTP realm", value: realm }]),
			createdAt: ms(at(row, cols.created)),
			updatedAt: ms(at(row, cols.changed)),
			lastUsedAt: ms(at(row, cols.used)),
		});
	}

	return summarize(imported, skipped, []);
}
