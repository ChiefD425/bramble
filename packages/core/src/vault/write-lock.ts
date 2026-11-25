// One vault writer at a time, across every context an app runs: an extension's popup, options page
// and background share Web Locks, being one origin. Where Web Locks are missing, a promise chain
// does the same within this context. Not reentrant: never take it again inside `run`.

const LOCK = "bramble:vault-write";
let chain: Promise<unknown> = Promise.resolve();

export function withVaultWriteLock<T>(run: () => Promise<T>): Promise<T> {
	const locks = (globalThis.navigator as { locks?: LockManager } | undefined)?.locks;
	if (locks) return locks.request(LOCK, run) as Promise<T>;
	const next = chain.then(run);
	chain = next.catch(() => {});
	return next;
}
