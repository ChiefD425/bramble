// The shared core reads import.meta.env (Vite's) to tell a sandbox build of the apps. Here, under
// Node and on Workers, it doesn't exist; this says so, so the core's files typecheck as imported.
interface ImportMeta {
	readonly env?: { readonly MODE?: string };
}
