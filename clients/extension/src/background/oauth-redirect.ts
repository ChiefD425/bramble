// Where a provider whose client only accepts loopback redirects (Google's Desktop app client)
// sends the user back, per browser. See docs/cloud-storage-backups.md "Google Drive".
//
// Firefox's launchWebAuthFlow takes `http://127.0.0.1/mozoauth2/<subdomain>` (Firefox 86+).
// Chromium's takes only its chromiumapp.org URL, so the consent page opens in a tab instead and
// the code is read off the tab's URL once it is sent to the loopback. Nothing listens there: the
// page never loads, and `<all_urls>` is what lets the background see the tab's URL.

/** Firefox's identity redirect is on allizom.org; Chromium's on chromiumapp.org. */
export function isGeckoRedirect(identityRedirect: string): boolean {
	return new URL(identityRedirect).hostname.endsWith(".allizom.org");
}

export function loopbackRedirectUri(identityRedirect: string, port: number): string {
	if (isGeckoRedirect(identityRedirect)) {
		const subdomain = new URL(identityRedirect).hostname.split(".")[0];
		return `http://127.0.0.1/mozoauth2/${subdomain}`;
	}
	return `http://127.0.0.1:${port}/`;
}

/** A random port above the well-known and registered ranges. */
export function randomPort(): number {
	return 49152 + (crypto.getRandomValues(new Uint16Array(1))[0]! % 16384);
}

interface Event<L> {
	addListener(l: L): void;
	removeListener(l: L): void;
}

type UpdatedListener = (tabId: number, change: { url?: string }, tab: { url?: string }) => void;

/** The slice of `chrome.tabs` this needs. */
export interface TabsLike {
	create(props: { url: string }): Promise<{ id?: number }>;
	remove(tabId: number): Promise<void>;
	onUpdated: Event<UpdatedListener>;
	onRemoved: Event<(tabId: number) => void>;
}

/** How long a consent tab may stay open, 2FA included, before the connect gives up. */
const CONSENT_TIMEOUT_MS = 15 * 60_000;

/**
 * Open `url` in a tab and resolve with the URL the tab is sent to under `redirectUri`, then close
 * the tab. Undefined if the user closes it first, or after `timeoutMs`.
 */
export function captureRedirectFromTab(
	tabs: TabsLike,
	url: string,
	redirectUri: string,
	timeoutMs = CONSENT_TIMEOUT_MS,
): Promise<string | undefined> {
	return new Promise((resolve, reject) => {
		let tabId: number | undefined;
		let finished = false;
		const finish = (result: { url?: string; close: boolean; error?: unknown }) => {
			if (finished) return;
			finished = true;
			clearTimeout(timer);
			tabs.onUpdated.removeListener(onUpdated);
			tabs.onRemoved.removeListener(onRemoved);
			if (result.close && tabId !== undefined) void tabs.remove(tabId).catch(() => {});
			if (result.error) reject(result.error);
			else resolve(result.url);
		};
		const onUpdated: UpdatedListener = (id, change, tab) => {
			const at = change.url ?? tab.url;
			if (id === tabId && at?.startsWith(redirectUri)) finish({ url: at, close: true });
		};
		const onRemoved = (id: number) => {
			if (id === tabId) finish({ close: false });
		};
		const timer = setTimeout(() => finish({ close: true }), timeoutMs);
		tabs.onUpdated.addListener(onUpdated);
		tabs.onRemoved.addListener(onRemoved);
		tabs.create({ url }).then(
			(tab) => {
				tabId = tab.id;
			},
			(error: unknown) => finish({ close: false, error }),
		);
	});
}
