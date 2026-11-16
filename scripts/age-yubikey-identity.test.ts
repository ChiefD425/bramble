// node --test scripts/age-yubikey-identity.test.ts

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { combineIdentities } from "./age-yubikey-identity.ts";

const SE = "AGE-PLUGIN-SE-1TOUCHID\n";
const YUBIKEY = "AGE-PLUGIN-YUBIKEY-1SLOT\n";
const unplugged = () => {
	throw new Error("no age identity found on the YubiKey. Is it plugged in?");
};

describe("combineIdentities", () => {
	it("lists Touch ID first, so a file wrapped to both never asks for the YubiKey", () => {
		assert.equal(
			combineIdentities(SE, () => YUBIKEY),
			`${SE}${YUBIKEY}`,
		);
	});

	it("goes without the YubiKey when Touch ID is set up and the key isn't plugged in", () => {
		assert.equal(combineIdentities(SE, unplugged), SE);
	});

	it("is the YubiKey alone where Touch ID isn't set up", () => {
		assert.equal(
			combineIdentities(undefined, () => YUBIKEY),
			YUBIKEY,
		);
	});

	it("says the YubiKey is missing when there is nothing else", () => {
		assert.throws(() => combineIdentities(undefined, unplugged), /plugged in/);
	});
});
