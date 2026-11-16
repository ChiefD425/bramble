/** 1970 to Foundation's 2001 reference date. */
export const APPLE_EPOCH_OFFSET_MS = 978_307_200_000;

const CLOCK_SKEW_MS = 86_400_000;

/**
 * Undo a date counted from 2001 but read from 1970, which lands 31 years ahead (1Password's
 * iOS credential export). Nothing is dated in the future, so only a future date that the
 * offset brings back into the past is moved.
 */
export function undoEpochShift(ms: number, now = Date.now()): number {
	const latest = now + CLOCK_SKEW_MS;
	return ms > latest && ms - APPLE_EPOCH_OFFSET_MS <= latest ? ms - APPLE_EPOCH_OFFSET_MS : ms;
}
