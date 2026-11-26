import { describe, expect, it } from "vitest";
import { normalizeHost, sshFingerprint } from "./ssh";

describe("sshFingerprint", () => {
	// Pinned test vector: generated with `ssh-keygen -t ed25519 -N ""`,
	// fingerprint cross-checked via `ssh-keygen -lf`. Embedded so a regression
	// in our base64 decode / digest / encode path breaks the suite immediately.
	const PUB =
		"ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIIZ8zKL37kT+SI/th45WgrIvgPV9VCC7M/9P3NqPeAls bramble-fingerprint-test@example";
	const EXPECTED = "SHA256:gRfjhrKWa8WDZPh6GB3WW3kX4m38DSqsahQGlH0JPzk";

	it("matches ssh-keygen -lf for a known ed25519 key", async () => {
		expect(await sshFingerprint(PUB)).toBe(EXPECTED);
	});

	it("ignores the optional comment field", async () => {
		const noComment =
			"ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIIZ8zKL37kT+SI/th45WgrIvgPV9VCC7M/9P3NqPeAls";
		expect(await sshFingerprint(noComment)).toBe(EXPECTED);
	});

	it("tolerates surrounding whitespace and trailing newlines", async () => {
		expect(await sshFingerprint(`  ${PUB}\n`)).toBe(EXPECTED);
	});

	it("is deterministic and differs across distinct keys", async () => {
		const other =
			"ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAILdf1q6Uw8GBjjE2K3aJxlAGLF5XJk9p1jY7gFmCcRRq other@example";
		expect(await sshFingerprint(PUB)).toBe(await sshFingerprint(PUB));
		expect(await sshFingerprint(other)).not.toBe(EXPECTED);
	});

	it("returns undefined when there's no key blob to hash", async () => {
		expect(await sshFingerprint("")).toBeUndefined();
		expect(await sshFingerprint("   ")).toBeUndefined();
		expect(await sshFingerprint("ssh-ed25519")).toBeUndefined();
	});

	it("returns undefined for malformed base64 rather than throwing", async () => {
		expect(await sshFingerprint("ssh-ed25519 not-valid-base64!")).toBeUndefined();
	});
});

describe("normalizeHost", () => {
	it("keeps hosts, addresses, patterns and aliases", () => {
		for (const h of ["github.com", "10.0.0.5", "*.example.com", "fe80::1%en0", "prod", "a-b_c?"]) {
			expect(normalizeHost(h)).toBe(h);
		}
	});

	it("trims and strips a user@ prefix", () => {
		expect(normalizeHost("  git@github.com ")).toBe("github.com");
	});

	it("refuses anything that could end the ssh config line", () => {
		for (const h of ["", " ", "a b", 'a"b', "a#b", "a=b", "a\nb", "a".repeat(254)]) {
			expect(normalizeHost(h)).toBeNull();
		}
	});
});
