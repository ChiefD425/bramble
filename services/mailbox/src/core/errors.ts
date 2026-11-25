// What an unexpected error may say in a log: its innermost cause, nothing of the request.

/** The innermost cause's message: Drizzle's query errors quote the SQL with its parameters, which
 * hold mailbox ids and keys; the database's own error names only tables and columns. */
export function rootMessage(err: unknown): string {
	let inner = err;
	while (inner instanceof Error && inner.cause instanceof Error) inner = inner.cause;
	return inner instanceof Error ? inner.message : String(inner);
}
