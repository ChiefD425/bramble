// node --test scripts/sigsum-monitor.test.ts

import assert from "node:assert/strict";
import { createHash, createPublicKey, verify } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import {
	checksumOf,
	leafHash,
	merkleRoot,
	parseLeaves,
	parseTreeHead,
	releaseKeys,
	verifyTreeHead,
} from "./sigsum-monitor.ts";

// A tree head from Sigsum's test log, inside the desktop app's update-log fixture.
const PROOF = readFileSync(
	new URL("../clients/desktop/src-tauri/fixtures/update-log/fixture.txt.proof", import.meta.url),
	"utf8",
);
// sigsum-test1-2025, the sigsum crate's built-in test policy.
const TEST_POLICY = {
	logs: [],
	witnesses: [
		{
			name: "poc.sigsum.org/nisse",
			key: "1c25f8a44c635457e2e391d1efbca7d4c2951a0aef06225a881e46b98962ac6c",
		},
		{
			name: "rgdd.se/poc-witness",
			key: "28c92a5a3a054d317c86fc2eeb6a7ab2054d6217100d0be67ded5b74323c5806",
		},
		{
			name: "witness1.smartit.nu/witness1",
			key: "f4855a0f46e8a3e23bb40faf260ee57ab8a18249fa402f2ca2d28a60e1a3130e",
		},
	],
	quorum: 2,
};
const TEST_LOG = "4644af2abd40f4895a003bca350f9d5912ab301a49c77f13e5b6d905c20a5fe6";

describe("verifyTreeHead", () => {
	it("accepts a head the log signed and a quorum cosigned", () => {
		verifyTreeHead(TEST_LOG, parseTreeHead(PROOF), TEST_POLICY);
	});

	it("refuses a head signed by another log", () => {
		assert.throws(
			() => verifyTreeHead("00".repeat(32), parseTreeHead(PROOF), TEST_POLICY),
			/log signature/,
		);
	});

	it("refuses a head whose root was changed", () => {
		const head = parseTreeHead(PROOF);
		head.rootHash = `${head.rootHash[0] === "0" ? "1" : "0"}${head.rootHash.slice(1)}`;
		assert.throws(() => verifyTreeHead(TEST_LOG, head, TEST_POLICY), /log signature/);
	});

	it("refuses a head below the witness quorum", () => {
		const head = parseTreeHead(PROOF);
		const policyWitness = (k: string) =>
			TEST_POLICY.witnesses.some(
				(w) => createHash("sha256").update(Buffer.from(w.key, "hex")).digest("hex") === k,
			);
		const first = head.cosignatures.findIndex((c) => policyWitness(c.keyHash));
		head.cosignatures = head.cosignatures.filter(
			(c, i) => i === first || !policyWitness(c.keyHash),
		);
		assert.throws(() => verifyTreeHead(TEST_LOG, head, TEST_POLICY), /quorum|needs 2/);
	});

	it("refuses a forged cosignature from a policy witness", () => {
		const head = parseTreeHead(PROOF);
		const witnessHash = createHash("sha256")
			.update(Buffer.from(TEST_POLICY.witnesses[0].key, "hex"))
			.digest("hex");
		head.cosignatures.push({ keyHash: witnessHash, time: 1, signature: "00".repeat(64) });
		assert.throws(() => verifyTreeHead(TEST_LOG, head, TEST_POLICY), /bad cosignature/);
	});
});

describe("merkleRoot", () => {
	// RFC 6962's test leaves and the roots of their first 1, 2, 3 and 8.
	const leaves = [
		"",
		"00",
		"10",
		"2021",
		"3031",
		"40414243",
		"5051525354555657",
		"606162636465666768696a6b6c6d6e6f",
	].map((h) =>
		createHash("sha256")
			.update(Buffer.concat([Buffer.from([0]), Buffer.from(h, "hex")]))
			.digest(),
	);

	for (const [n, root] of [
		[1, "6e340b9cffb37a989ca544e6bb780a2c78901d3fb33738768511a30617afa01d"],
		[2, "fac54203e7cc696cf0dfcb42c92a1d9dbaf70ad9e621f4bd8d98662f00e3c125"],
		[3, "aeb6bcfe274b70a14fb067a5e5578264db0fa9b51af5e0ba159158f329e06e77"],
		[8, "5dc9da79a70659a9ad559cb701ded9a2ab9d823aad2f4960cfe370eff4604328"],
	] as const)
		it(`matches RFC 6962 for ${n} leaves`, () => {
			assert.equal(merkleRoot(leaves.slice(0, n)).toString("hex"), root);
		});
});

describe("leaves", () => {
	it("parses get-leaves output and hashes a leaf as checksum, signature, key hash", () => {
		const [leaf] = parseLeaves(`leaf=${"aa".repeat(32)} ${"bb".repeat(64)} ${"cc".repeat(32)}\n`);
		assert.deepEqual(leaf, {
			checksum: "aa".repeat(32),
			signature: "bb".repeat(64),
			keyHash: "cc".repeat(32),
		});
		const expected = createHash("sha256")
			.update(Buffer.from(`00${"aa".repeat(32)}${"bb".repeat(64)}${"cc".repeat(32)}`, "hex"))
			.digest("hex");
		assert.equal(leafHash(leaf).toString("hex"), expected);
	});

	it("computes the checksum sigsum-submit logged for an artifact", () => {
		// fixture.txt's SHA-256; the proof's leaf signature is over the checksum the log holds.
		const sha = "8bcf11977eb1db1349cd4bdfb387623354945c6603424c125bcd8f38767a1bc7";
		const testKey = "da63dbb79f88b4d86babf13f119b05fd85ab124a606817489fb904c94fa08e29";
		const signature = /^leaf=\S+ (\S+)$/m.exec(PROOF)?.[1];
		assert.ok(signature);
		const key = createPublicKey({
			key: Buffer.from(`302a300506032b6570032100${testKey}`, "hex"),
			format: "der",
			type: "spki",
		});
		const signed = (checksum: string) =>
			Buffer.concat([Buffer.from("sigsum.org/v1/tree-leaf\0"), Buffer.from(checksum, "hex")]);
		assert.ok(verify(null, signed(checksumOf(sha)), key, Buffer.from(signature, "hex")));
		assert.ok(!verify(null, signed(sha), key, Buffer.from(signature, "hex")));
	});

	it("reads the release keys file", () => {
		assert.deepEqual(releaseKeys("# comment\naa bb\n\ncc\n"), ["aa", "cc"]);
	});
});
