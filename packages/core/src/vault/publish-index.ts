// What a vault hands its platform after every load and save: the autofill index, and the SSH
// keys where the platform has an agent. One function so the places that publish can't drift.

import type { AutofillAdapter } from "../adapters/autofill";
import type { Entry } from "../hooks/useVault";
import { toAutofillIndex } from "./autofill-index";
import { toSshKeys } from "./ssh-keys";

export async function publishToPlatform(
	adapter: Pick<AutofillAdapter, "setIndex" | "setSshKeys">,
	entries: Entry[],
	lease?: unknown,
): Promise<void> {
	await adapter.setIndex(toAutofillIndex(entries), lease);
	await adapter.setSshKeys?.(toSshKeys(entries), lease);
}
