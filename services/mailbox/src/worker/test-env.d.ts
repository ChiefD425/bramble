// Bindings only the tests have (vitest.workers.config.ts), beside the generated Env.
declare namespace Cloudflare {
	/** What `exports` from cloudflare:workers holds in the tests. */
	interface GlobalProps {
		mainModule: typeof import("./index");
	}
	interface Env {
		TEST_MIGRATIONS: import("cloudflare:test").D1Migration[];
	}
}
