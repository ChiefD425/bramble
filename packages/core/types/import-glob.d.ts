// Vite's lazy glob, in the one shape core uses (app/whats-new.ts), for core's own typecheck. The
// clients' typechecks include core's sources with vite/client, which declares the real one, so
// this sits outside src/ where they don't look.
interface ImportMeta {
	glob<T>(
		pattern: string,
		options: { query: "?raw"; import: "default" },
	): Record<string, () => Promise<T>>;
}
