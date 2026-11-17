// node --test scripts/smoke-sigsum.test.ts

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { sshEd25519Hex } from "./smoke-sigsum.ts";

describe("sshEd25519Hex", () => {
	it("reads the raw key out of an ssh-keygen public key", () => {
		// An ssh-keygen key, and the hex Sigsum's own `sigsum-key to-hex` gives for it.
		const line =
			"ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAINvcOggubBV6z+Uu2hcUZGVO6NNZb2xLqOWmQdsBtrQ+ vector";
		assert.equal(
			sshEd25519Hex(line),
			"dbdc3a082e6c157acfe52eda171464654ee8d3596f6c4ba8e5a641db01b6b43e",
		);
	});

	it("refuses another key type", () => {
		assert.throws(() => sshEd25519Hex("ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAABAQ== x"));
	});
});
