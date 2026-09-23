//! Holds the Rust verifier to the CLI's answers.
//!
//! Every vector in `signature-vectors.json` was produced by the canonical
//! package's own `verifyEventSignature`, and the frontend suite re-asks the
//! package on every run so the file cannot keep an answer the CLI no longer
//! gives (`src/lib/__tests__/signature-vectors.test.ts`). This test asserts the
//! other half: that this crate gives the same answer — outcome, finding kind
//! and message — or, where a vector names a deliberate divergence, the answer
//! the vector records for the viewer instead.
use base64::engine::general_purpose::STANDARD;
use base64::Engine;
use serde::Deserialize;
use tauri_app_lib::signature::{parse_public_key, verify, Outcome};

#[derive(Deserialize)]
struct Expected {
    ok: bool,
    kind: Option<String>,
    message: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Vector {
    name: String,
    algorithm: String,
    value: String,
    public_key_pem: String,
    message_base64: String,
    cli: Expected,
    divergence: Option<String>,
    viewer: Option<Expected>,
}

#[derive(Deserialize)]
struct Vectors {
    vectors: Vec<Vector>,
}

fn load() -> Vec<Vector> {
    let text = include_str!("signature-vectors.json");
    serde_json::from_str::<Vectors>(text).expect("vectors parse").vectors
}

#[test]
fn every_vector_gets_the_answer_it_records() {
    let vectors = load();
    assert!(vectors.len() >= 30, "the vector file lost cases: {}", vectors.len());

    let mut failures = Vec::new();
    for vector in &vectors {
        let expected = match (&vector.divergence, &vector.viewer) {
            (Some(_), Some(viewer)) => viewer,
            (None, None) => &vector.cli,
            _ => panic!("{}: a divergence and the viewer's answer come together", vector.name),
        };
        let expected = Outcome {
            ok: expected.ok,
            kind: expected.kind.clone(),
            message: expected.message.clone(),
        };

        let key = parse_public_key(&vector.public_key_pem, "vector.pem")
            .unwrap_or_else(|error| panic!("{}: key did not load: {error}", vector.name));
        let message = STANDARD.decode(&vector.message_base64).expect("message is base64");
        let actual = verify(&key, &vector.algorithm, &vector.value, &message);

        if actual != expected {
            failures.push(format!("{}\n  expected {expected:?}\n  actual   {actual:?}", vector.name));
        }
    }
    assert!(failures.is_empty(), "{} vectors disagree:\n{}", failures.len(), failures.join("\n"));
}

#[test]
fn every_divergence_refuses_what_the_cli_accepts() {
    // The only acceptable direction for the viewer to differ in: the CLI says
    // valid and the viewer does not claim it. The reverse would be a viewer
    // reporting a signature verified that the reference implementation refuses.
    for vector in load() {
        if let Some(viewer) = &vector.viewer {
            assert!(
                vector.cli.ok && !viewer.ok,
                "{}: a divergence may only refuse what the CLI accepts",
                vector.name
            );
        }
    }
}

#[test]
fn a_private_key_is_refused_by_name() {
    let pem = "-----BEGIN PRIVATE KEY-----\nMC4CAQAwBQYDK2VwBCIEIBhoAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA\n-----END PRIVATE KEY-----\n";
    let error = parse_public_key(pem, "key.pem").err().expect("refused");
    assert!(error.contains("private key"), "{error}");
}

#[test]
fn text_that_is_not_pem_is_refused() {
    assert!(parse_public_key("not a key", "key.pem").is_err());
}

#[test]
fn the_summary_names_what_a_key_can_verify() {
    for vector in load() {
        let key = parse_public_key(&vector.public_key_pem, "vector.pem").expect("loads");
        let summary = &key.summary;
        assert_eq!(summary.fingerprint.len(), 64, "{}", vector.name);
        match summary.key_type.as_str() {
            "ed25519" => assert_eq!(summary.usable_for, ["Ed25519"]),
            "ec" if summary.curve.as_deref() == Some("prime256v1") => {
                assert_eq!(summary.usable_for, ["ECDSA-P256-SHA256"])
            }
            "rsa" | "rsa-pss" if summary.modulus_bits.unwrap_or(0) >= 2048 => {
                assert_eq!(summary.usable_for, ["RSA-PSS-SHA256"])
            }
            _ => assert!(summary.usable_for.is_empty(), "{}", vector.name),
        }
    }
}

#[test]
fn the_fingerprint_is_the_sha256_of_the_der_inside_the_pem() {
    // The panel tells people to check it with
    // `grep -v -- ----- key.pem | base64 -d | shasum -a 256`; this is that.
    use sha2::{Digest, Sha256};
    for vector in load() {
        let first_block: String = vector
            .public_key_pem
            .split("-----END")
            .next()
            .unwrap_or_default()
            .lines()
            .filter(|line| !line.contains("-----") && !line.contains(' ') && !line.contains(':'))
            .collect();
        let Ok(der) = base64::engine::general_purpose::STANDARD.decode(first_block.trim()) else {
            continue; // unpadded or unusual layouts are covered by the vectors themselves
        };
        let expected: String = Sha256::digest(&der).iter().map(|b| format!("{b:02x}")).collect();
        let key = parse_public_key(&vector.public_key_pem, "vector.pem").expect("loads");
        assert_eq!(key.summary.fingerprint, expected, "{}", vector.name);
    }
}
