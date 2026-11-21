// 1Password Interchange Format (.1pif), the export of 1Password 7 and earlier: a folder holding
// data.1pif, one JSON item per record between `***<uuid>***` lines, and attachments/<item uuid>/
// beside it. The Mac apps write `typeName` + `secureContents`, the Windows apps `category` +
// `overview` + `details`; both are read. docs/onepassword-1pif-import.md records the format.

import { z } from "zod";
import type { CardEntryData, EntryData, LoginEntryData } from "../hooks/useVault";
import { cardBrand } from "../util/card";
import { mimeFor } from "../vault/mime";
import { normalizeTags } from "../vault/tags";
import { hostLabel, type RawField, summarize, toCustomFields } from "./shared";
import type { ImportAttachment, ImportResult } from "./types";

export const PIF_FORMAT_ERROR = "This doesn't look like a 1Password .1pux or .1pif export.";

// Every part is read on its own, so one odd part costs only itself, never the field or the
// item around it. An empty field has no value key at all.
const text = z.string().nullish().catch(undefined);
const formFieldSchema = z.object({
	name: text,
	id: text,
	value: z.unknown().optional(),
	// T text, E email, P password, C checkbox, R radio, B button, I submit, …
	type: text,
	designation: text,
});
const sectionFieldSchema = z.object({
	// Kind: string, concealed, date, monthYear, address, …
	k: text,
	// Name: `ccnum`, `TOTP_<uuid>`, or a generated id.
	n: text,
	// Label.
	t: text,
	v: z.unknown().optional(),
});
const contentsSchema = z.object({
	fields: z.array(formFieldSchema).nullish().catch(undefined),
	sections: z
		.array(
			z.object({ title: text, fields: z.array(sectionFieldSchema).nullish().catch(undefined) }),
		)
		.nullish()
		.catch(undefined),
	URLs: z
		.array(z.object({ url: z.string().nullish() }))
		.nullish()
		.catch(undefined),
	notesPlain: z.string().nullish().catch(undefined),
	password: z.string().nullish().catch(undefined),
});
const itemSchema = z.object({
	uuid: z.string().nullish(),
	typeName: z.string().nullish(),
	category: z.string().nullish(),
	trashed: z.boolean().nullish(),
	// Mac
	title: z.string().nullish(),
	location: z.string().nullish(),
	folderUuid: z.string().nullish(),
	createdAt: z.number().nullish(),
	updatedAt: z.number().nullish(),
	openContents: z.object({ tags: z.array(z.string()).nullish() }).nullish(),
	secureContents: z.record(z.string(), z.unknown()).nullish(),
	// Windows
	overview: z
		.object({
			title: z.string().nullish(),
			url: z.string().nullish(),
			URLs: z.array(z.object({ u: z.string().nullish() })).nullish(),
			tags: z.array(z.string()).nullish(),
		})
		.nullish(),
	details: z.record(z.string(), z.unknown()).nullish(),
	folder: z.string().nullish(),
	parent: z.string().nullish(),
	smart: z.boolean().nullish(),
	created: z.number().nullish(),
	updated: z.number().nullish(),
});

type PifItem = z.infer<typeof itemSchema>;
type FormField = z.infer<typeof formFieldSchema>;
type SectionField = z.infer<typeof sectionFieldSchema>;

/** An item's secure contents: the typed parts, and every raw key for the 1Password 3 shape. */
interface Contents extends z.infer<typeof contentsSchema> {
	raw: Record<string, unknown>;
	sectionFields: SectionField[];
	/** Each section field's section title. */
	sectionOf: Map<SectionField, string>;
}

const LOGIN = new Set(["webforms.WebForm", "001"]);
const PASSWORD = new Set(["passwords.Password", "005"]);
const CARD = new Set(["wallet.financial.CreditCard", "002"]);
const FOLDER = "system.folder.Regular";

// The record separator. 1Password writes one fixed uuid; any is accepted.
const SEPARATOR = /^\*\*\*[0-9a-f-]+\*\*\*[ \t]*$/im;

// Items untouched since 1Password 3 still come out in its shape: values as flat keys of the
// secure contents, with no sections. These keys are structure, not values.
const NOT_A_VALUE = new Set([
	"fields",
	"sections",
	"URLs",
	"notesPlain",
	"passwordHistory",
	"customIcon",
	"backupKeys",
	"htmlForm",
	"htmlAction",
	"htmlMethod",
	"htmlName",
	"htmlID",
]);
const SECRET_KEY = /pass|pin|cvv|secret|key/i;

/** Control characters (below a space) escaped, as JSON requires inside a string. */
const escapeControls = (text: string) =>
	Array.from(text, (c) =>
		c < " " ? `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}` : c,
	).join("");

/** One record. Some exports leave raw control characters in strings, which JSON forbids. */
function readRecord(text: string): PifItem | undefined {
	let json: unknown;
	try {
		json = JSON.parse(text);
	} catch {
		try {
			json = JSON.parse(escapeControls(text));
		} catch {
			return undefined;
		}
	}
	const parsed = itemSchema.safeParse(json);
	return parsed.success ? parsed.data : undefined;
}

/** Every record in a data.1pif: between `***uuid***` lines, or one per line without them. */
function readRecords(text: string): { items: PifItem[]; unreadable: number } {
	const src = (text.charCodeAt(0) === 0xfeff ? text.slice(1) : text).trim();
	const records = SEPARATOR.test(src)
		? src.split(SEPARATOR)
		: readRecord(src)
			? [src]
			: src.split(/\r?\n/);
	const items: PifItem[] = [];
	let unreadable = 0;
	for (const record of records.map((r) => r.trim()).filter(Boolean)) {
		const item = readRecord(record);
		if (item) items.push(item);
		else unreadable++;
	}
	return { items, unreadable };
}

function contentsOf(item: PifItem): Contents {
	const raw = item.secureContents ?? item.details ?? {};
	const parsed = contentsSchema.parse(raw);
	const sectionOf = new Map<SectionField, string>();
	for (const s of parsed.sections ?? []) {
		for (const f of s.fields ?? []) sectionOf.set(f, s.title?.trim() ?? "");
	}
	return { ...parsed, raw, sectionFields: [...sectionOf.keys()], sectionOf };
}

/** A section field's value as text. Dates are Unix seconds, monthYear is YYYYMM. */
function fieldText(f: SectionField): string {
	const v = f.v;
	if (v === null || v === undefined) return "";
	if (typeof v === "object") {
		const a = v as Record<string, unknown>;
		return [a.street, a.city, a.state, a.zip, a.country]
			.filter((p) => typeof p === "string" && p)
			.join(", ");
	}
	if (f.k === "date" && typeof v === "number") {
		return new Date(v * 1000).toISOString().slice(0, 10);
	}
	if (f.k === "monthYear" && /^\d{6}$/.test(String(v))) {
		const s = String(v);
		return `${s.slice(4)}/${s.slice(0, 4)}`;
	}
	return String(v);
}

const isTotp = (f: SectionField) =>
	(f.n ?? "").startsWith("TOTP_") || /^otpauth:\/\//i.test(String(f.v ?? ""));

/**
 * The fields an item holds beyond the ones mapped to the entry: its section fields, or its flat
 * keys when it has no sections. `taken` names what was mapped already, as section field names
 * and flat keys alike; `used` is a section field mapped already.
 */
function extras(
	c: Contents,
	taken: ReadonlySet<string> = new Set(),
	used?: SectionField,
): RawField[] {
	if (c.sectionFields.length === 0) {
		const out: RawField[] = [];
		for (const [key, value] of Object.entries(c.raw)) {
			if (NOT_A_VALUE.has(key) || taken.has(key)) continue;
			if (typeof value !== "string" && typeof value !== "number") continue;
			out.push({ key, value: String(value), hidden: SECRET_KEY.test(key) || undefined });
		}
		return out;
	}
	const fields = c.sectionFields.filter(
		(f) => f !== used && !taken.has(f.n ?? "") && fieldText(f) !== "",
	);
	const label = (f: SectionField) => f.t || f.n || "Field";
	const count = new Map<string, number>();
	for (const f of fields) count.set(label(f), (count.get(label(f)) ?? 0) + 1);
	// An email account has a username and a password under POP and again under SMTP: a label
	// that repeats is told apart by its section.
	return fields.map((f) => {
		const section = c.sectionOf.get(f);
		const repeated = (count.get(label(f)) ?? 0) > 1 && section;
		return {
			key: repeated ? `${section}: ${label(f)}` : label(f),
			value: fieldText(f),
			hidden: f.k === "concealed" || undefined,
		};
	});
}

function urlsOf(item: PifItem, c: Contents): string[] {
	const out: string[] = [];
	const push = (u: string | null | undefined) => {
		if (u && !out.includes(u)) out.push(u);
	};
	for (const u of c.URLs ?? []) push(u.url);
	push(item.location);
	for (const u of item.overview?.URLs ?? []) push(u.u);
	push(item.overview?.url);
	return out;
}

const formText = (f: FormField) =>
	typeof f.value === "string" || typeof f.value === "number" ? String(f.value) : "";

// Checkbox, radio, button and submit: the state of the form, not something the user saved.
const FORM_STATE = new Set(["C", "R", "B", "I"]);

type Base = Pick<EntryData, "name" | "notes" | "tags" | "createdAt" | "updatedAt">;

function mapLogin(item: PifItem, c: Contents, base: Base): LoginEntryData {
	const form = (c.fields ?? []).filter((f) => formText(f) !== "");
	// The designated fields are the ones 1Password fills; without one, the first of the kind.
	const username =
		form.find((f) => f.designation === "username") ??
		form.find((f) => f.type === "T" || f.type === "E");
	const password =
		form.find((f) => f.designation === "password") ?? form.find((f) => f.type === "P");
	const totp = c.sectionFields.find(isTotp);
	// A Password item's password is a key of its own, in either shape.
	const taken = new Set(!password && c.password ? ["password"] : []);
	const custom: RawField[] = [
		...form
			.filter((f) => f !== username && f !== password && !FORM_STATE.has(f.type ?? ""))
			.map((f) => ({
				key: f.name || f.id || "Field",
				value: formText(f),
				hidden: f.type === "P" || undefined,
			})),
		...extras(c, taken, totp),
	];
	const urls = urlsOf(item, c);
	const user = username ? formText(username) : "";
	return {
		type: "login",
		...base,
		name: base.name || hostLabel(urls[0] ?? "") || user,
		urls,
		username: user,
		password: password ? formText(password) : (c.password ?? ""),
		totp: totp ? fieldText(totp) : undefined,
		customFields: toCustomFields(custom),
	};
}

// The card's own fields, as section field names and as 1Password 3 flat keys. `type` is the
// issuer's name, re-derived from the number.
const CARD_FIELDS = new Set([
	"ccnum",
	"cvv",
	"cardholder",
	"expiry",
	"expiry_mm",
	"expiry_yy",
	"type",
]);

function mapCard(c: Contents, base: Base): CardEntryData {
	const value = (n: string): string => {
		const f = c.sectionFields.find((x) => x.n === n);
		if (f) return fieldText(f);
		const v = c.raw[n];
		return typeof v === "string" || typeof v === "number" ? String(v) : "";
	};
	const number = value("ccnum");
	const expiry = String(c.sectionFields.find((f) => f.n === "expiry")?.v ?? "");
	const yyyymm = /^\d{6}$/.test(expiry);
	return {
		type: "card",
		...base,
		cardholderName: value("cardholder"),
		number,
		brand: cardBrand(number),
		expMonth: yyyymm ? String(Number(expiry.slice(4))) : value("expiry_mm"),
		expYear: yyyymm ? expiry.slice(0, 4) : value("expiry_yy"),
		cvv: value("cvv"),
		customFields: toCustomFields(extras(c, CARD_FIELDS)),
	};
}

function mapNote(item: PifItem, c: Contents, base: Base): EntryData {
	// Websites on an item that isn't a login (a router, a licence) are kept, never filled.
	const sites = urlsOf(item, c).map((value) => ({ key: "URL", value }));
	return { type: "note", ...base, customFields: toCustomFields([...extras(c), ...sites]) };
}

const seconds = (s: number | null | undefined) => (s && s > 0 ? s * 1000 : undefined);

/** Folder names from the top down: Mac folders nest by `folderUuid`, Windows ones by `parent`. */
function folderPath(id: string | null | undefined, folders: Map<string, PifItem>): string[] {
	const path: string[] = [];
	const seen = new Set<string>();
	for (let at = id; at && !seen.has(at); ) {
		seen.add(at);
		const folder = folders.get(at);
		if (!folder) break;
		const name = folder.title ?? folder.overview?.title;
		if (name) path.unshift(name);
		at = folder.folderUuid ?? folder.parent;
	}
	return path;
}

/** Files under attachments/<item uuid>/ beside a zipped data.1pif. Previews are left out. */
function attachmentsByItem(
	files: Record<string, Uint8Array>,
	pifPath: string,
): Map<string, { name: string; bytes: Uint8Array }[]> {
	const dir = pifPath.slice(0, pifPath.lastIndexOf("/") + 1);
	const out = new Map<string, { name: string; bytes: Uint8Array }[]>();
	for (const [path, bytes] of Object.entries(files)) {
		if (!path.startsWith(dir)) continue;
		const m = /^attachments\/([^/]+)\/([^/]+)$/i.exec(path.slice(dir.length));
		if (!m?.[1] || !m[2] || m[2].startsWith(".")) continue;
		out.set(m[1], [...(out.get(m[1]) ?? []), { name: m[2], bytes }]);
	}
	return out;
}

/** The .1pif files in a zipped export folder. macOS adds __MACOSX/ copies; they aren't exports. */
export function pifPaths(files: Record<string, Uint8Array>): string[] {
	return Object.keys(files).filter(
		(p) => /\.1pif$/i.test(p) && !p.startsWith("__MACOSX/") && (files[p]?.length ?? 0) > 0,
	);
}

/**
 * Parse a data.1pif. `zipped` is the zipped export folder it came in, and its path there; only
 * then can the attachments beside it come too.
 */
export function parseOnePif(
	text: string,
	zipped?: { files: Record<string, Uint8Array>; path: string },
): ImportResult {
	const { items, unreadable } = readRecords(text);
	if (items.length === 0) throw new Error(PIF_FORMAT_ERROR);

	const folders = new Map<string, PifItem>();
	for (const item of items) {
		if (item.typeName === FOLDER && !item.smart && item.uuid) folders.set(item.uuid, item);
	}
	const stored = zipped ? attachmentsByItem(zipped.files, zipped.path) : new Map();

	const imported: EntryData[] = [];
	const attachments: ImportAttachment[] = [];
	let foldered = 0;
	for (const item of items) {
		const kind = item.typeName ?? item.category ?? "";
		// Trash stays behind, as in every other import. system.* are folders, saved searches and
		// the tombstones of deleted items.
		if (item.trashed || kind.startsWith("system.")) continue;
		const folder = folderPath(item.folderUuid ?? item.folder, folders);
		if (folder.length > 0) foldered++;
		const c = contentsOf(item);
		const base: Base = {
			name: item.title ?? item.overview?.title ?? "",
			notes: c.notesPlain || undefined,
			tags: normalizeTags([...(item.openContents?.tags ?? item.overview?.tags ?? []), ...folder]),
			createdAt: seconds(item.createdAt ?? item.created),
			updatedAt: seconds(item.updatedAt ?? item.updated),
		};
		const entry =
			LOGIN.has(kind) || PASSWORD.has(kind)
				? mapLogin(item, c, base)
				: CARD.has(kind)
					? mapCard(c, base)
					: mapNote(item, c, base);
		imported.push(entry);
		for (const { name, bytes } of stored.get(item.uuid ?? "") ?? []) {
			attachments.push({
				entry,
				name,
				mime: mimeFor(name),
				source: { kind: "blob", blob: new Blob([bytes as BlobPart]) },
				size: bytes.length,
			});
		}
	}

	const warnings: string[] = [];
	if (unreadable > 0) warnings.push(`${unreadable} item(s) in this file couldn't be read.`);
	if (foldered > 0) {
		warnings.push(`${foldered} item(s) were in a 1Password folder, imported as tags.`);
	}
	if (!zipped) {
		warnings.push(
			"Attachments aren't in data.1pif. To bring them too, zip the whole export folder and import the .zip instead.",
		);
	}
	return summarize(imported, unreadable, warnings, attachments);
}
