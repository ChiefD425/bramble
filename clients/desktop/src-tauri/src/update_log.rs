//! An update is installed only if it is in a public Sigsum log, witnessed.
//!
//! The updater signature proves Bramble released a build. It cannot show that everyone got the same
//! build: whoever holds the key could sign one for a single user and serve it to that user alone.
//! The log closes that gap. A release's checksum has to sit in an append-only log that witnesses in
//! several countries cosign, before this app will install it, so any build the app accepts is one
//! the whole world can see, and monitors compare every entry against the published releases.
//! See docs/update-transparency.md.

use serde_json::Value;
use sigsum::policy::{Policy, SIGSUM_GENERIC_2025_1};
use sigsum::{Hash, PublicKey, SigsumSignature};

/// Where the update manifest (website/public/desktop/latest.json) keeps the proofs: a map from the
/// artifact's SHA-256 in hex to its Sigsum proof, so an artifact shared by two platforms has one.
pub const PROOFS_FIELD: &str = "sigsum_proofs";

/// Bramble's leaf-signing keys for the log: one signs in CI, the other is an offline backup, so
/// losing one does not strand every install.
const RELEASE_KEYS: &str = include_str!("../sigsum-keys.txt");

/// Whether `artifact` is logged under Bramble's keys according to the pinned policy, by the proof
/// `manifest` carries for it. Needs no network: the proof is complete in itself.
pub fn verify_logged(artifact: &[u8], manifest: &Value) -> Result<(), String> {
    verify_with(artifact, manifest, &release_keys(), &SIGSUM_GENERIC_2025_1)
}

fn release_keys() -> Vec<PublicKey> {
    RELEASE_KEYS
        .lines()
        .filter(|l| !l.starts_with('#') && !l.trim().is_empty())
        .filter_map(|l| l.split_whitespace().next())
        .map(key)
        .collect()
}

fn key(hex: &str) -> PublicKey {
    assert_eq!(hex.len(), 64, "a release key is 32 bytes of hex");
    let mut bytes = [0u8; 32];
    for (i, byte) in bytes.iter_mut().enumerate() {
        *byte = u8::from_str_radix(&hex[i * 2..i * 2 + 2], 16).expect("release key is hex");
    }
    bytes.into()
}

fn verify_with(
    artifact: &[u8],
    manifest: &Value,
    keys: &[PublicKey],
    policy: &Policy,
) -> Result<(), String> {
    let message = Hash::new(artifact);
    let proof = manifest
        .get(PROOFS_FIELD)
        .and_then(|proofs| proofs.get(format!("{message:x}")))
        .and_then(Value::as_str)
        .ok_or("this update is not in the public log")?;
    let proof = SigsumSignature::from_ascii(proof)
        .map_err(|e| format!("this update's log proof is malformed: {e}"))?;
    sigsum::verify(&message, &proof, keys, policy)
        .map_err(|e| format!("this update's log proof does not check out: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use sigsum::policy::SIGSUM_TEST1_2025;

    // Logged on Sigsum's test log with a throwaway key; see fixtures/update-log/README.md.
    const ARTIFACT: &[u8] = include_bytes!("../fixtures/update-log/fixture.txt");
    const PROOF: &str = include_str!("../fixtures/update-log/fixture.txt.proof");
    const TEST_KEY: &str = "da63dbb79f88b4d86babf13f119b05fd85ab124a606817489fb904c94fa08e29";
    const ARTIFACT_SHA256: &str =
        "8bcf11977eb1db1349cd4bdfb387623354945c6603424c125bcd8f38767a1bc7";

    fn manifest(proof: &str) -> Value {
        json!({ "version": "9.9.9", PROOFS_FIELD: { ARTIFACT_SHA256: proof } })
    }

    fn check(artifact: &[u8], manifest: &Value, keys: &[PublicKey]) -> Result<(), String> {
        verify_with(artifact, manifest, keys, &SIGSUM_TEST1_2025)
    }

    #[test]
    fn accepts_a_logged_artifact() {
        check(ARTIFACT, &manifest(PROOF), &[key(TEST_KEY)]).unwrap();
    }

    #[test]
    fn refuses_a_different_artifact() {
        let mut other = ARTIFACT.to_vec();
        other[0] ^= 1;
        // Its checksum has no proof in the manifest at all.
        assert!(check(&other, &manifest(PROOF), &[key(TEST_KEY)]).is_err());
    }

    #[test]
    fn refuses_a_proof_filed_under_another_artifact() {
        let mut other = ARTIFACT.to_vec();
        other[0] ^= 1;
        let hash = format!("{:x}", Hash::new(&other));
        let lying = json!({ PROOFS_FIELD: { hash: PROOF } });
        assert!(check(&other, &lying, &[key(TEST_KEY)]).is_err());
    }

    #[test]
    fn refuses_a_proof_signed_by_another_key() {
        let err = check(ARTIFACT, &manifest(PROOF), &release_keys()).unwrap_err();
        assert!(err.contains("does not check out"), "{err}");
    }

    #[test]
    fn refuses_a_proof_without_the_witness_quorum() {
        let without: String = PROOF
            .lines()
            .filter(|l| !l.starts_with("cosignature="))
            .map(|l| format!("{l}\n"))
            .collect();
        assert!(check(ARTIFACT, &manifest(&without), &[key(TEST_KEY)]).is_err());
    }

    #[test]
    fn refuses_a_tampered_inclusion_proof() {
        assert!(check(
            ARTIFACT,
            &manifest(&flip_node_hash(PROOF)),
            &[key(TEST_KEY)]
        )
        .is_err());
    }

    #[test]
    fn refuses_a_manifest_without_proofs() {
        let err = check(ARTIFACT, &json!({ "version": "9.9.9" }), &[key(TEST_KEY)]).unwrap_err();
        assert!(err.contains("not in the public log"), "{err}");
    }

    #[test]
    fn production_policy_and_keys_parse() {
        assert_eq!(SIGSUM_GENERIC_2025_1.name, "sigsum-generic-2025-1");
        assert_eq!(release_keys().len(), 2);
    }

    /// The first inclusion-proof node with its first hex digit changed.
    fn flip_node_hash(proof: &str) -> String {
        let at = proof.find("node_hash=").expect("proof has a node hash") + "node_hash=".len();
        let digit = &proof[at..at + 1];
        let flipped = if digit == "0" { "1" } else { "0" };
        format!("{}{}{}", &proof[..at], flipped, &proof[at + 1..])
    }
}
