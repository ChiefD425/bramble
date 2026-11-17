// Watch the Sigsum logs for anything signed with Bramble's release keys that is not a published
// desktop release. docs/update-transparency.md.
//
//   node scripts/sigsum-monitor.ts                exit 0: every entry is a published release
//   node scripts/sigsum-monitor.ts --grace 30     recheck the releases once after 30 minutes
//
// Needs only network, so anyone can run it. It reads every entry each time instead of keeping
// state: the logs are small, and nothing stored between runs can be tampered with. For each log it
// checks the tree head against the log's key and a quorum of witnesses (the view an installed app
// accepts), recomputes the Merkle root from all the entries (so the log cannot have hidden one),
// then matches every entry under Bramble's keys against the SHA256SUMS of the desktop releases.

import { createHash, createPublicKey, verify } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const REPO = process.env.GITHUB_REPOSITORY ?? "bramble-sh/bramble";
const KEYS_FILE = "clients/desktop/src-tauri/sigsum-keys.txt";

/** sigsum-generic-2025-1, the policy the app pins through the sigsum crate. */
export const POLICY = {
	logs: [
		{
			url: "https://seasalp.glasklar.is",
			key: "0ec7e16843119b120377a73913ac6acbc2d03d82432e2c36b841b09a95841f25",
		},
		{
			url: "https://ginkgo.tlog.mullvad.net",
			key: "f00c159663d09bbda6131ee1816863b6adcacfe80b0b288000b11aba8fe38314",
		},
	],
	witnesses: [
		{
			name: "witness.glasklar.is",
			key: "b2106db9065ec97f25e09c18839216751a6e26d8ed8b41e485a563d3d1498536",
		},
		{
			name: "witness.mullvad.net",
			key: "15d6d0141543247b74bab3c1076372d9c894f619c376d64b29aa312cc00f61ad",
		},
		{
			name: "tillitis.se/tillitis-witness-1",
			key: "076be8c9ee7ea60916f0df3608c945d7730082ecb37749dad2c9ed339fea770c",
		},
	],
	quorum: 2,
};

const sha256 = (...parts: Buffer[]) => {
	const h = createHash("sha256");
	for (const p of parts) h.update(p);
	return h.digest();
};
const hex = (s: string) => Buffer.from(s, "hex");

function ed25519Verify(keyHex: string, message: Buffer, signatureHex: string): boolean {
	const key = createPublicKey({
		key: Buffer.concat([hex("302a300506032b6570032100"), hex(keyHex)]),
		format: "der",
		type: "spki",
	});
	return verify(null, message, key, hex(signatureHex));
}

export interface TreeHead {
	size: number;
	rootHash: string;
	signature: string;
	cosignatures: { keyHash: string; time: number; signature: string }[];
}

export function parseTreeHead(text: string): TreeHead {
	const head: TreeHead = { size: -1, rootHash: "", signature: "", cosignatures: [] };
	for (const line of text.split("\n")) {
		const [field, value] = [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)];
		if (field === "size") head.size = Number(value);
		else if (field === "root_hash") head.rootHash = value;
		else if (field === "signature") head.signature = value;
		else if (field === "cosignature") {
			const [keyHash, time, signature] = value.split(" ");
			head.cosignatures.push({ keyHash, time: Number(time), signature });
		}
	}
	if (!Number.isSafeInteger(head.size) || head.size < 0 || !head.rootHash || !head.signature)
		throw new Error("malformed tree head");
	return head;
}

function treeHeadMessage(logKey: string, size: number, rootHash: string): string {
	const keyHash = sha256(hex(logKey)).toString("hex");
	return `sigsum.org/v1/tree/${keyHash}\n${size}\n${hex(rootHash).toString("base64")}\n`;
}

/** Throws unless the log signed `head` and a quorum of the policy's witnesses cosigned it. */
export function verifyTreeHead(logKey: string, head: TreeHead, policy = POLICY): void {
	const message = treeHeadMessage(logKey, head.size, head.rootHash);
	if (!ed25519Verify(logKey, Buffer.from(message), head.signature))
		throw new Error("bad log signature on the tree head");
	const valid = new Set<string>();
	for (const cosig of head.cosignatures) {
		const witness = policy.witnesses.find(
			(w) => sha256(hex(w.key)).toString("hex") === cosig.keyHash,
		);
		if (!witness) continue;
		const signed = Buffer.from(`cosignature/v1\ntime ${cosig.time}\n${message}`);
		if (!ed25519Verify(witness.key, signed, cosig.signature))
			throw new Error(`bad cosignature from ${witness.name}`);
		valid.add(witness.name);
	}
	if (valid.size < policy.quorum)
		throw new Error(
			`${valid.size} valid witness cosignature(s), the policy needs ${policy.quorum}`,
		);
}

export interface Leaf {
	checksum: string;
	signature: string;
	keyHash: string;
}

export function parseLeaves(text: string): Leaf[] {
	return text
		.split("\n")
		.filter((l) => l.startsWith("leaf="))
		.map((l) => {
			const [checksum, signature, keyHash] = l.slice("leaf=".length).split(" ");
			return { checksum, signature, keyHash };
		});
}

export function leafHash(leaf: Leaf): Buffer {
	return sha256(Buffer.from([0]), hex(leaf.checksum), hex(leaf.signature), hex(leaf.keyHash));
}

/** RFC 9162's Merkle tree hash over leaf hashes. */
export function merkleRoot(hashes: Buffer[], lo = 0, hi = hashes.length): Buffer {
	const n = hi - lo;
	if (n === 0) return sha256();
	if (n === 1) return hashes[lo];
	let k = 1;
	while (k * 2 < n) k *= 2;
	return sha256(Buffer.from([1]), merkleRoot(hashes, lo, lo + k), merkleRoot(hashes, lo + k, hi));
}

/** What a published artifact's leaf carries: SHA-256 of the artifact's SHA-256. */
export function checksumOf(artifactSha256: string): string {
	return sha256(hex(artifactSha256)).toString("hex");
}

export function releaseKeys(text: string): string[] {
	return text
		.split("\n")
		.filter((l) => l.trim() && !l.startsWith("#"))
		.map((l) => l.split(/\s+/)[0]);
}

async function get(url: string, headers: Record<string, string> = {}): Promise<string> {
	const res = await fetch(url, { headers });
	if (!res.ok) throw new Error(`${url} answered ${res.status}`);
	return res.text();
}

/** Every leaf, checked against the cosigned root. */
async function readLog(log: { url: string; key: string }): Promise<Leaf[]> {
	const head = parseTreeHead(await get(`${log.url}/get-tree-head`));
	verifyTreeHead(log.key, head);
	const leaves: Leaf[] = [];
	while (leaves.length < head.size) {
		const batch = parseLeaves(
			await get(
				`${log.url}/get-leaves/${leaves.length}/${Math.min(head.size, leaves.length + 1024)}`,
			),
		);
		if (!batch.length) throw new Error(`${log.url} returned no leaves at ${leaves.length}`);
		leaves.push(...batch);
	}
	if (leaves.length !== head.size) throw new Error(`${log.url} returned more leaves than its size`);
	const root = merkleRoot(leaves.map(leafHash)).toString("hex");
	if (root !== head.rootHash)
		throw new Error(`${log.url}: the leaves do not hash to the cosigned root`);
	return leaves;
}

/** The checksums of every artifact of every published desktop release. */
async function publishedChecksums(): Promise<Map<string, string>> {
	const auth: Record<string, string> = process.env.GH_TOKEN
		? { authorization: `Bearer ${process.env.GH_TOKEN}` }
		: {};
	const out = new Map<string, string>();
	for (let page = 1; ; page++) {
		const releases = JSON.parse(
			await get(`https://api.github.com/repos/${REPO}/releases?per_page=100&page=${page}`, auth),
		) as { tag_name: string; draft: boolean }[];
		for (const r of releases.filter((r) => r.tag_name.endsWith("-desktop") && !r.draft)) {
			let sums: string;
			try {
				sums = await get(`https://github.com/${REPO}/releases/download/${r.tag_name}/SHA256SUMS`);
			} catch {
				continue;
			}
			for (const line of sums.split("\n")) {
				const [hash, name] = line.trim().split(/\s+/);
				if (hash && name) out.set(checksumOf(hash), `${r.tag_name}/${name}`);
			}
		}
		if (releases.length < 100) return out;
	}
}

async function main(argv: string[]): Promise<number> {
	const keys = releaseKeys(readFileSync(join(ROOT, KEYS_FILE), "utf8"));
	const ours = new Map(keys.map((k) => [sha256(hex(k)).toString("hex"), k]));
	const graceAt = argv.indexOf("--grace");
	const grace = graceAt === -1 ? 0 : Number(argv[graceAt + 1]);

	const entries: { log: string; leaf: Leaf }[] = [];
	for (const log of POLICY.logs) {
		const leaves = await readLog(log);
		const mine = leaves.filter((l) => ours.has(l.keyHash));
		console.log(
			`${log.url}: ${leaves.length} entries, root and witnesses check out; ${mine.length} ours`,
		);
		for (const leaf of mine) {
			const key = ours.get(leaf.keyHash) as string;
			const signed = Buffer.concat([Buffer.from("sigsum.org/v1/tree-leaf\0"), hex(leaf.checksum)]);
			if (!ed25519Verify(key, signed, leaf.signature))
				throw new Error(`${log.url}: an entry under our key has a bad signature`);
			entries.push({ log: log.url, leaf });
		}
	}

	let published = await publishedChecksums();
	let unexplained = entries.filter((e) => !published.has(e.leaf.checksum));
	if (unexplained.length && grace > 0) {
		// A release logs its artifacts minutes before it publishes them.
		console.log(`${unexplained.length} not yet explained; checking again in ${grace} minutes`);
		await new Promise((r) => setTimeout(r, grace * 60_000));
		published = await publishedChecksums();
		unexplained = unexplained.filter((e) => !published.has(e.leaf.checksum));
	}
	for (const e of entries.filter((e) => published.has(e.leaf.checksum)))
		console.log(`  ok  ${published.get(e.leaf.checksum)}`);
	for (const e of unexplained) console.log(`  UNEXPLAINED  ${e.log} checksum ${e.leaf.checksum}`);
	if (unexplained.length) {
		console.log(
			`\n${unexplained.length} entr${unexplained.length === 1 ? "y" : "ies"} signed with a Bramble release key` +
				' match no published desktop release. See docs/update-transparency.md, "If the monitor fails".',
		);
		return 1;
	}
	console.log(`\nall ${entries.length} entries under Bramble's keys are published releases`);
	return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	main(process.argv.slice(2)).then(
		(code) => process.exit(code),
		(e: Error) => {
			console.error(`error: ${e.message}`);
			process.exit(2);
		},
	);
}
