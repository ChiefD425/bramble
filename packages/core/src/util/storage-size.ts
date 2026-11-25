/** Bytes in decimal units, as the hosted quota is counted: 1,000,000,000 bytes is "1 GB". */
export function formatStorage(bytes: number, locale: string): string {
	const [unit, size] =
		bytes >= 1e9 ? ["gigabyte", 1e9] : bytes >= 1e6 ? ["megabyte", 1e6] : ["kilobyte", 1e3];
	return new Intl.NumberFormat(locale, {
		style: "unit",
		unit,
		unitDisplay: "short",
		maximumFractionDigits: 1,
	} as Intl.NumberFormatOptions).format(bytes / (size as number));
}
