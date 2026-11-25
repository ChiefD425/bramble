import { defineConfig } from "vitest/config";

// `pnpm -r run test` starts this suite alongside the app suites on the same CI runner. One
// worker keeps it from starving them (its files take a few seconds run one after another).
// The Worker's own suite runs in workerd: vitest.workers.config.ts.
export default defineConfig({
	test: { fileParallelism: false, exclude: ["src/worker/**", "node_modules/**"] },
});
