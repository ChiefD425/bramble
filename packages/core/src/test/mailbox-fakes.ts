// Test-only: a mailbox device's keys without the core. Real Ed25519 over WebCrypto, so a server
// verifies the requests, and a reversible "seal" that checks its AAD and starts with the core's
// version byte, so the envelope treats it as the core's own.

import type { MailboxSigner } from "../sync/mailbox/api";
import type { MailboxCryptoPort } from "../sync/mailbox/envelope";
import { base64ToBytes, bytesToBase64 } from "../util/bytes";

const enc = new TextEncoder();
const dec = new TextDecoder();

export async function verifyEd25519(sigKey: string, message: string, sigB64: string) {
	try {
		const key = await crypto.subtle.importKey(
			"raw",
			base64ToBytes(sigKey) as Uint8Array<ArrayBuffer>,
			{ name: "Ed25519" },
			false,
			["verify"],
		);
		return await crypto.subtle.verify(
			{ name: "Ed25519" },
			key,
			base64ToBytes(sigB64) as Uint8Array<ArrayBuffer>,
			enc.encode(message),
		);
	} catch {
		return false;
	}
}

export async function ed25519Signer(): Promise<MailboxSigner> {
	const pair = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, [
		"sign",
		"verify",
	])) as CryptoKeyPair;
	const sigKey = bytesToBase64(
		new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey)),
	);
	return {
		sigKey,
		sign: async (message) =>
			bytesToBase64(
				new Uint8Array(
					await crypto.subtle.sign({ name: "Ed25519" }, pair.privateKey, enc.encode(message)),
				),
			),
	};
}

/** Fails as the core does, so the envelope reads these as refusals of the message. */
export function fakeMailboxCrypto(mailboxId: string, signer: MailboxSigner): MailboxCryptoPort {
	return {
		mailboxId: async () => mailboxId,
		mailboxSeal: async (_group, aad, plaintext) =>
			bytesToBase64(new Uint8Array([1, ...enc.encode(JSON.stringify({ aad, plaintext }))])),
		mailboxOpen: async (_group, aad, sealedB64) => {
			const bytes = base64ToBytes(sealedB64);
			if (bytes[0] !== 1) throw new Error("not a sealed mailbox message");
			let opened: { aad?: unknown; plaintext?: unknown };
			try {
				opened = JSON.parse(dec.decode(bytes.subarray(1)));
			} catch {
				throw new Error("mailbox open failed");
			}
			if (opened.aad !== aad || typeof opened.plaintext !== "string") {
				throw new Error("mailbox open failed");
			}
			return opened.plaintext;
		},
		sign: (message) => signer.sign(message),
		verify: verifyEd25519,
	};
}
