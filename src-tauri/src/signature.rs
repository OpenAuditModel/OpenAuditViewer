//! Signature verification against one public key the user chose.
//!
//! The viewer checks `integrity.signature` the way `auditmodel verify-integrity
//! --public-key` does, for the same three algorithms: Ed25519,
//! ECDSA-P256-SHA256 and RSA-PSS-SHA256. The webview computes what was signed
//! — the canonical digest input, with the same engine it hashes with — and
//! asks this module whether the declared signature holds over it.
//!
//! Why here and not in the webview's Web Crypto:
//!
//! * RSA-PSS. The reference verifier recovers the salt length from the
//!   signature itself, because a signer's salt choice is the signer's. Web
//!   Crypto cannot: `RsaPssParams.saltLength` is a required member, so a
//!   webview verifier would have to guess, and a signature made with a salt it
//!   did not guess would read as "does not match" here and "valid" in the CLI.
//! * Ed25519. Web Crypto has it in Chromium only from 137 (May 2025), and in
//!   WebKit only from Safari 17. Whether a signature verifies must not depend
//!   on which webview runtime a Windows machine happens to have installed, or
//!   which macOS it runs.
//! * The key never enters the webview. The file is chosen in a native dialog
//!   opened from here, read here and held here. The webview, which renders
//!   untrusted log content, can neither name a path for this module to read
//!   nor see the key's bytes; it receives a summary and a fingerprint.
//!
//! Every answer is held to the CLI's by `tests/signature_vectors.rs`, against
//! vectors the canonical package itself produced
//! (`tools/generate-signature-vectors.mjs`). Where this module answers
//! differently the vector names the reason, and the test refuses any
//! difference that is not a refusal of something the CLI accepts: an
//! RSASSA-PSS key that restricts its own parameters. A small-order Ed25519 key
//! or R was one until canonical 1.0.0 refused them too; both now agree.
//! Separately, some files the CLI would load are refused when the key is
//! chosen: see `parse_public_key`, `rsa_public_key` and `read_key_file`.
//!
//! No key registry, no trust store: `integrity.signature.keyId` names a key
//! for a human to resolve, and nothing here dereferences it.
use std::sync::Mutex;

use base64::engine::general_purpose::STANDARD;
use base64::Engine;
use p256::ecdsa::signature::Verifier;
use rsa::pkcs1::der::Decode;
use rsa::traits::PublicKeyParts;
use rsa::BigUint;
use sha2::{Digest, Sha256};
use spki::{ObjectIdentifier, SubjectPublicKeyInfoRef};

/// Largest key file read. A PEM public key is a few hundred bytes to a couple
/// of kilobytes; anything larger is not one.
const MAX_KEY_FILE_BYTES: u64 = 64 * 1024;

/// Largest RSA modulus accepted. The RSA crate's default ceiling is 4096 bits,
/// which would refuse keys OpenSSL — and so the CLI — verifies with.
const MAX_RSA_MODULUS_BITS: usize = 16_384;

/// Smallest RSA modulus the CLI accepts for RSA-PSS-SHA256.
const MIN_RSA_MODULUS_BITS: usize = 2048;

const OID_ED25519: ObjectIdentifier = ObjectIdentifier::new_unwrap("1.3.101.112");
const OID_ED448: ObjectIdentifier = ObjectIdentifier::new_unwrap("1.3.101.113");
const OID_X25519: ObjectIdentifier = ObjectIdentifier::new_unwrap("1.3.101.110");
const OID_X448: ObjectIdentifier = ObjectIdentifier::new_unwrap("1.3.101.111");
const OID_EC_PUBLIC_KEY: ObjectIdentifier = ObjectIdentifier::new_unwrap("1.2.840.10045.2.1");
const OID_RSA_ENCRYPTION: ObjectIdentifier =
    ObjectIdentifier::new_unwrap("1.2.840.113549.1.1.1");
const OID_RSASSA_PSS: ObjectIdentifier = ObjectIdentifier::new_unwrap("1.2.840.113549.1.1.10");
const OID_DSA: ObjectIdentifier = ObjectIdentifier::new_unwrap("1.2.840.10040.4.1");

const OID_PRIME256V1: ObjectIdentifier = ObjectIdentifier::new_unwrap("1.2.840.10045.3.1.7");
const OID_SECP384R1: ObjectIdentifier = ObjectIdentifier::new_unwrap("1.3.132.0.34");
const OID_SECP521R1: ObjectIdentifier = ObjectIdentifier::new_unwrap("1.3.132.0.35");
const OID_SECP256K1: ObjectIdentifier = ObjectIdentifier::new_unwrap("1.3.132.0.10");

/// What the webview is told about the trusted key. Never the key itself.
#[derive(Clone, Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KeySummary {
    /// The key type as the CLI names it: `ed25519`, `ec`, `rsa`, `rsa-pss`, …
    pub key_type: String,
    /// The named curve of an elliptic-curve key, as the CLI names it.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub curve: Option<String>,
    /// The modulus length of an RSA key, in bits.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub modulus_bits: Option<usize>,
    /// SHA-256 of the key's SubjectPublicKeyInfo DER, lowercase hex — what
    /// `grep -v -- ----- key.pem | base64 -d | shasum -a 256` prints, so the person
    /// who published the key can be asked for the same number.
    pub fingerprint: String,
    /// The name of the file it was read from, without the directory.
    pub file_name: String,
    /// The algorithms this key can verify, in the CLI's names. Empty for a key
    /// that parses but that none of the three algorithms can use.
    pub usable_for: Vec<String>,
}

enum Material {
    /// The 32 bytes as the file holds them, and the key they decode to —
    /// `None` when they are not a valid curve point. OpenSSL loads such a key
    /// and fails every signature against it; so does this.
    Ed25519([u8; 32], Option<ed25519_dalek::VerifyingKey>),
    P256(p256::ecdsa::VerifyingKey),
    Rsa {
        key: rsa::RsaPublicKey,
        /// An RSASSA-PSS key whose SubjectPublicKeyInfo carries parameters.
        restricted: bool,
    },
    /// A key this module can describe but no supported algorithm can use.
    Unusable,
}

/// A parsed public key and what the webview may know about it.
pub struct TrustedKey {
    pub summary: KeySummary,
    material: Material,
}

/// The answer for one signature, in the shape the CLI's `SignatureCheckResult` has.
#[derive(Debug, PartialEq, Eq, serde::Serialize)]
pub struct Outcome {
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub kind: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
}

impl Outcome {
    fn valid() -> Self {
        Outcome { ok: true, kind: None, message: None }
    }

    fn fail(kind: &str, message: impl Into<String>) -> Self {
        Outcome { ok: false, kind: Some(kind.to_owned()), message: Some(message.into()) }
    }

    fn does_not_match() -> Self {
        Outcome::fail("signature-invalid", "signature does not match")
    }
}

/// The encodings of the eight points of order 1, 2, 4 and 8 on edwards25519,
/// sign bit cleared — the list the CLI refuses a key or an R against, and
/// libsodium before it. Two are the non-canonical y = p and y = p + 1.
const SMALL_ORDER_POINTS: [[u8; 32]; 7] = [
    hex32("0000000000000000000000000000000000000000000000000000000000000000"),
    hex32("0100000000000000000000000000000000000000000000000000000000000000"),
    hex32("26e8958fc2b227b045c3f489f2ef98f0d5dfac05d3c63339b13802886d53fc05"),
    hex32("c7176a703d4dd84fba3c0b760d10670f2a2053fa2c39ccc64ec7fd7792ac037a"),
    hex32("ecffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f"),
    hex32("edffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f"),
    hex32("eeffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f"),
];

const fn hex32(text: &str) -> [u8; 32] {
    const fn nibble(byte: u8) -> u8 {
        match byte {
            b'0'..=b'9' => byte - b'0',
            b'a'..=b'f' => byte - b'a' + 10,
            _ => panic!("not lowercase hex"),
        }
    }
    let bytes = text.as_bytes();
    let mut out = [0u8; 32];
    let mut index = 0;
    while index < 32 {
        out[index] = nibble(bytes[2 * index]) << 4 | nibble(bytes[2 * index + 1]);
        index += 1;
    }
    out
}

/// True when a 32-byte encoded point is one of the small-order points, either sign.
fn is_small_order_point(encoded: &[u8]) -> bool {
    let Ok(mut cleared) = <[u8; 32]>::try_from(encoded) else {
        return false;
    };
    cleared[31] &= 0x7f;
    SMALL_ORDER_POINTS.contains(&cleared)
}

/// The CLI's words for a small-order key, so that the two agree to the letter.
const SMALL_ORDER_KEY_MESSAGE: &str = "this Ed25519 public key is a small-order point: nobody holds a private key for it, and a signature that verifies under it can be made for any message, so it is not used";

/// The CLI's words for a small-order R.
const SMALL_ORDER_R_MESSAGE: &str = "the signature's R is a small-order point, a nonce no honest signer produces, so the signature is not accepted";

/// The algorithms this verifier implements, in the CLI's names and order.
pub const SUPPORTED_ALGORITHMS: [&str; 3] = ["Ed25519", "ECDSA-P256-SHA256", "RSA-PSS-SHA256"];

/// The label and bytes of the first PEM block in `text`.
///
/// As loose as OpenSSL's reader, which is what the CLI loads keys with: text
/// before the block and after it is ignored, a second block is ignored, and
/// the base64 inside may be on one line, wrapped at any width, or end its
/// lines with CRLF. A strict RFC 7468 parser refuses several of those, and a
/// key the producer published in one of them would have been refused here and
/// accepted by the CLI. Each is a vector.
fn first_pem_block(text: &str) -> Result<(String, Vec<u8>), String> {
    const NOT_PEM: &str = "the file is not a PEM-encoded key";
    let begin = text.find("-----BEGIN ").ok_or(NOT_PEM)?;
    let after_begin = &text[begin + "-----BEGIN ".len()..];
    let label_end = after_begin.find("-----").ok_or(NOT_PEM)?;
    let label = &after_begin[..label_end];
    let body_start = &after_begin[label_end + "-----".len()..];
    let end_marker = format!("-----END {label}-----");
    let body_end = body_start.find(&end_marker).ok_or(NOT_PEM)?;
    let body: String = body_start[..body_end]
        .chars()
        .filter(|character| !character.is_ascii_whitespace())
        .collect();
    let der = decode_base64_as_node_does(&body).ok_or(NOT_PEM)?;
    if der.is_empty() {
        return Err(NOT_PEM.to_owned());
    }
    Ok((label.to_owned(), der))
}

/// Parses a PEM public key (SubjectPublicKeyInfo, `-----BEGIN PUBLIC KEY-----`).
///
/// Three kinds of file the CLI would load are refused here by label, each with
/// a message that says what to do instead: a private key, whose public half Node would
/// derive — a viewer has no business reading a private key, and choosing one
/// by mistake should be said out loud rather than quietly repaired; a bare
/// PKCS#1 `RSA PUBLIC KEY`; and a certificate. The refusal happens when the
/// key is chosen, before anything is verified with it.
pub fn parse_public_key(pem: &str, file_name: &str) -> Result<TrustedKey, String> {
    let (label, der) = first_pem_block(pem)?;

    match label.as_str() {
        "PUBLIC KEY" => {}
        "PRIVATE KEY" | "RSA PRIVATE KEY" | "EC PRIVATE KEY" | "ENCRYPTED PRIVATE KEY" => {
            return Err(
                "the file holds a private key; choose the public key that belongs to it".to_owned(),
            )
        }
        "RSA PUBLIC KEY" => {
            return Err(
                "the file holds a PKCS#1 RSA public key; convert it with `openssl rsa -RSAPublicKey_in -in key.pem -pubout`".to_owned(),
            )
        }
        "CERTIFICATE" => {
            return Err(
                "the file holds a certificate; extract its public key with `openssl x509 -in cert.pem -pubkey -noout`".to_owned(),
            )
        }
        other => return Err(format!("the file holds a \"{other}\", not a public key")),
    }

    let spki = SubjectPublicKeyInfoRef::try_from(der.as_slice())
        .map_err(|_| "the file's public key could not be read".to_owned())?;
    let fingerprint = hex(&Sha256::digest(&der));
    let oid = spki.algorithm.oid;
    let key_bytes = spki.subject_public_key.raw_bytes();

    let (key_type, curve, modulus_bits, material) = if oid == OID_ED25519 {
        let point = <[u8; 32]>::try_from(key_bytes)
            .map_err(|_| "the Ed25519 key is not 32 bytes long".to_owned())?;
        let key = ed25519_dalek::VerifyingKey::from_bytes(&point).ok();
        ("ed25519", None, None, Material::Ed25519(point, key))
    } else if oid == OID_EC_PUBLIC_KEY {
        let curve_oid = spki
            .algorithm
            .parameters
            .and_then(|parameters| parameters.decode_as::<ObjectIdentifier>().ok())
            .ok_or_else(|| "the elliptic-curve key names no curve".to_owned())?;
        if curve_oid == OID_PRIME256V1 {
            let point = uncompressed_from_hybrid(key_bytes)?;
            let key = p256::ecdsa::VerifyingKey::from_sec1_bytes(&point)
                .map_err(|_| "the P-256 key is not a valid curve point".to_owned())?;
            ("ec", Some("prime256v1".to_owned()), None, Material::P256(key))
        } else {
            let name = curve_name(curve_oid)
                .ok_or_else(|| "the elliptic-curve key is on a curve this viewer does not know".to_owned())?;
            ("ec", Some(name.to_owned()), None, Material::Unusable)
        }
    } else if oid == OID_RSA_ENCRYPTION || oid == OID_RSASSA_PSS {
        let parsed = rsa::pkcs1::RsaPublicKey::from_der(key_bytes)
            .map_err(|_| "the RSA key could not be read".to_owned())?;
        let key = rsa_public_key(
            BigUint::from_bytes_be(parsed.modulus.as_bytes()),
            BigUint::from_bytes_be(parsed.public_exponent.as_bytes()),
        )?;
        let bits = key.n().bits();
        let restricted = oid == OID_RSASSA_PSS && spki.algorithm.parameters.is_some();
        let key_type = if oid == OID_RSASSA_PSS { "rsa-pss" } else { "rsa" };
        (key_type, None, Some(bits), Material::Rsa { key, restricted })
    } else {
        let name = if oid == OID_ED448 {
            "ed448"
        } else if oid == OID_X25519 {
            "x25519"
        } else if oid == OID_X448 {
            "x448"
        } else if oid == OID_DSA {
            "dsa"
        } else {
            return Err(format!("the key's algorithm ({oid}) is not one this viewer knows"));
        };
        (name, None, None, Material::Unusable)
    };

    let usable_for = SUPPORTED_ALGORITHMS
        .iter()
        .filter(|algorithm| key_type_matches(algorithm, key_type, curve.as_deref(), modulus_bits))
        .map(|algorithm| (*algorithm).to_owned())
        .collect();

    Ok(TrustedKey {
        summary: KeySummary {
            key_type: key_type.to_owned(),
            curve,
            modulus_bits,
            fingerprint,
            file_name: file_name.to_owned(),
            usable_for,
        },
        material,
    })
}

/// An RSA public key, checked the way OpenSSL checks one rather than the way the
/// RSA crate does by default.
///
/// The crate refuses a public exponent above 2^33 − 1 and a modulus above 4096
/// bits; OpenSSL, and so the CLI, verifies with both. What is kept is what
/// makes the arithmetic meaningful: an odd modulus, an odd exponent of at least
/// 3, and an exponent below the modulus. OpenSSL's own ceiling on exponents —
/// 64 bits once the modulus passes 3072 — is applied when a signature is
/// checked, where OpenSSL applies it (see `verify`).
fn rsa_public_key(n: BigUint, e: BigUint) -> Result<rsa::RsaPublicKey, String> {
    const UNUSABLE: &str = "the RSA key is not one this viewer can use";
    if n.bits() > MAX_RSA_MODULUS_BITS {
        return Err(format!(
            "the RSA key's modulus is {} bits; this viewer reads keys up to {MAX_RSA_MODULUS_BITS}",
            n.bits()
        ));
    }
    let two = BigUint::from(2u8);
    if &n % &two == BigUint::from(0u8)
        || &e % &two == BigUint::from(0u8)
        || e < BigUint::from(3u8)
        || e >= n
    {
        return Err(UNUSABLE.to_owned());
    }
    Ok(rsa::RsaPublicKey::new_unchecked(n, e))
}

/// A P-256 point in any encoding OpenSSL loads, as bytes the P-256 crate reads.
///
/// SEC 1's hybrid form (`0x06`/`0x07`) carries both coordinates and repeats
/// the parity of y in its prefix. OpenSSL loads it after checking that the
/// parity agrees; the P-256 crate does not read it at all. So the parity is
/// checked here and the prefix rewritten to the uncompressed `0x04`, which
/// says the same thing about the same point.
fn uncompressed_from_hybrid(bytes: &[u8]) -> Result<Vec<u8>, String> {
    match bytes.first() {
        Some(prefix @ (0x06 | 0x07)) if bytes.len() == 65 => {
            let y_is_odd = bytes[64] & 1 == 1;
            if y_is_odd != (*prefix == 0x07) {
                return Err("the P-256 key is not a valid curve point".to_owned());
            }
            let mut point = bytes.to_vec();
            point[0] = 0x04;
            Ok(point)
        }
        _ => Ok(bytes.to_vec()),
    }
}

fn curve_name(oid: ObjectIdentifier) -> Option<&'static str> {
    if oid == OID_PRIME256V1 {
        Some("prime256v1")
    } else if oid == OID_SECP384R1 {
        Some("secp384r1")
    } else if oid == OID_SECP521R1 {
        Some("secp521r1")
    } else if oid == OID_SECP256K1 {
        Some("secp256k1")
    } else {
        None
    }
}

/// The key types each algorithm accepts, as the CLI's `SIGNATURE_ALGORITHMS` lists them.
fn required_key_types(algorithm: &str) -> &'static [&'static str] {
    match algorithm {
        "Ed25519" => &["ed25519"],
        "ECDSA-P256-SHA256" => &["ec"],
        _ => &["rsa", "rsa-pss"],
    }
}

fn key_type_matches(
    algorithm: &str,
    key_type: &str,
    curve: Option<&str>,
    modulus_bits: Option<usize>,
) -> bool {
    required_key_types(algorithm).contains(&key_type)
        && (algorithm != "ECDSA-P256-SHA256" || curve == Some("prime256v1"))
        && (algorithm != "RSA-PSS-SHA256" || modulus_bits.unwrap_or(0) >= MIN_RSA_MODULUS_BITS)
}

/// Verifies `value` over `message` with `key`, in the CLI's order and words:
/// the algorithm, the key's type, curve and size, the encoding, the length,
/// and only then the primitive.
pub fn verify(key: &TrustedKey, algorithm: &str, value: &str, message: &[u8]) -> Outcome {
    if !SUPPORTED_ALGORITHMS.contains(&algorithm) {
        return Outcome::fail(
            "unsupported-signature-algorithm",
            format!("signature algorithm \"{algorithm}\" is not implemented by this verifier"),
        );
    }

    let summary = &key.summary;
    let needed = required_key_types(algorithm);
    if !needed.contains(&summary.key_type.as_str()) {
        return Outcome::fail(
            "signature-invalid",
            format!(
                "the supplied public key is {}, but {algorithm} needs {}",
                summary.key_type,
                needed.join(" or ")
            ),
        );
    }
    // Where the CLI refuses it: after the key's type, before anything else.
    if let Material::Ed25519(point, _) = &key.material {
        if is_small_order_point(point) {
            return Outcome::fail("signature-invalid", SMALL_ORDER_KEY_MESSAGE);
        }
    }
    if algorithm == "ECDSA-P256-SHA256" && summary.curve.as_deref() != Some("prime256v1") {
        return Outcome::fail(
            "signature-invalid",
            format!(
                "the supplied public key is on curve {}, but {algorithm} needs prime256v1",
                summary.curve.as_deref().unwrap_or("unknown")
            ),
        );
    }
    if algorithm == "RSA-PSS-SHA256" {
        let bits = summary.modulus_bits.unwrap_or(0);
        if bits < MIN_RSA_MODULUS_BITS {
            return Outcome::fail(
                "signature-invalid",
                format!(
                    "the supplied public key has a {bits}-bit modulus, but {algorithm} needs at least {MIN_RSA_MODULUS_BITS}"
                ),
            );
        }
    }

    let Some(signature) = decode_base64_as_node_does(value) else {
        return Outcome::fail(
            "malformed-signature",
            "declared signature value is not base64, the encoding this verifier expects",
        );
    };

    let expected_length = match algorithm {
        "RSA-PSS-SHA256" => summary.modulus_bits.unwrap_or(0).div_ceil(8),
        _ => 64,
    };
    if signature.len() != expected_length {
        return Outcome::fail(
            "malformed-signature",
            format!(
                "declared signature is {} bytes, but {algorithm} produces {expected_length}",
                signature.len()
            ),
        );
    }

    if algorithm == "Ed25519" && is_small_order_point(&signature[..32]) {
        return Outcome::fail("signature-invalid", SMALL_ORDER_R_MESSAGE);
    }

    let valid = match (&key.material, algorithm) {
        (Material::Ed25519(_, Some(verifying_key)), "Ed25519") => {
            let bytes = <[u8; 64]>::try_from(signature.as_slice()).expect("length checked above");
            // Strict, as the CLI is from 1.0.0: a small-order key or R was
            // refused above, in the CLI's words, and `verify_strict` refuses
            // anything of the kind the list might not name.
            verifying_key
                .verify_strict(message, &ed25519_dalek::Signature::from_bytes(&bytes))
                .is_ok()
        }
        (Material::Ed25519(_, None), "Ed25519") => false,
        (Material::P256(verifying_key), "ECDSA-P256-SHA256") => {
            // A zero or out-of-range r or s does not parse; OpenSSL reports
            // the same inputs as a signature that does not match.
            match p256::ecdsa::Signature::from_slice(&signature) {
                Ok(parsed) => verifying_key.verify(message, &parsed).is_ok(),
                Err(_) => false,
            }
        }
        (Material::Rsa { restricted: true, .. }, "RSA-PSS-SHA256") => {
            return Outcome::fail(
                "signature-invalid",
                "the supplied RSASSA-PSS public key restricts its own parameters, which this viewer does not evaluate",
            );
        }
        (Material::Rsa { key, .. }, "RSA-PSS-SHA256") => {
            // OpenSSL refuses a public exponent wider than 64 bits once the
            // modulus is wider than 3072 (OPENSSL_RSA_MAX_PUBEXP_BITS), and the
            // CLI reports that as a signature that does not match.
            if key.n().bits() > 3072 && key.e().bits() > 64 {
                false
            } else {
                verify_pss_any_salt(key, message, &signature)
            }
        }
        _ => {
            return Outcome::fail(
                "signature-invalid",
                "signature could not be verified: the supplied key or signature is malformed",
            )
        }
    };

    if valid {
        Outcome::valid()
    } else {
        Outcome::does_not_match()
    }
}

/// Decodes a signature value exactly as far as the CLI does.
///
/// The CLI admits `/^[A-Za-z0-9+/]+=*$/` — the standard alphabet, then any
/// number of `=`, including none — and hands the text to Node's
/// `Buffer.from(value, "base64")`, which is lenient: padding is optional,
/// surplus padding is ignored, unused low bits in the last character are
/// ignored, and a lone trailing character that cannot complete a byte is
/// dropped. Each of those is a vector. A stricter decoder here would call
/// "not base64" a signature the CLI verifies.
fn decode_base64_as_node_does(value: &str) -> Option<Vec<u8>> {
    let body = value.trim_end_matches('=');
    let admitted = !body.is_empty()
        && body
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'+' || byte == b'/');
    if !admitted {
        return None;
    }
    let whole = if body.len() % 4 == 1 { &body[..body.len() - 1] } else { body };
    LENIENT.decode(whole).ok()
}

const LENIENT: base64::engine::GeneralPurpose = base64::engine::GeneralPurpose::new(
    &base64::alphabet::STANDARD,
    base64::engine::GeneralPurposeConfig::new()
        .with_decode_padding_mode(base64::engine::DecodePaddingMode::RequireNone)
        .with_decode_allow_trailing_bits(true),
);

/// RSASSA-PSS over SHA-256 with the salt length the signature itself carries.
///
/// The RSA crate verifies against a salt length it is told, and the CLI —
/// OpenSSL with `RSA_PSS_SALTLEN_AUTO` — accepts whatever salt the signer
/// chose. So the salt length is read out of the encoded message first (RFC
/// 8017 §9.1.2 steps 7–10: unmask the data block and find the `0x01` that
/// ends its zero padding), and the crate then performs the complete
/// verification with that length.
///
/// Two checks here are load-bearing, not merely parameter-finding, because
/// the crate does not make them: that the signature is below the modulus, and
/// that the byte in front of the encoded message is zero when the modulus is
/// one bit past a byte boundary. Without either, the crate accepts a
/// signature the CLI refuses; each has a vector.
fn verify_pss_any_salt(key: &rsa::RsaPublicKey, message: &[u8], signature: &[u8]) -> bool {
    let Some(salt_length) = recover_pss_salt_length(key, signature) else {
        return false;
    };
    let hashed = Sha256::digest(message);
    key.verify(rsa::Pss::new_with_salt::<Sha256>(salt_length), &hashed, signature)
        .is_ok()
}

fn recover_pss_salt_length(key: &rsa::RsaPublicKey, signature: &[u8]) -> Option<usize> {
    const HASH_LENGTH: usize = 32;

    let s = BigUint::from_bytes_be(signature);
    if &s >= key.n() {
        return None;
    }
    let m = rsa::hazmat::rsa_encrypt(key, &s).ok()?;

    let modulus_bits = key.n().bits();
    let em_bits = modulus_bits - 1;
    let em_length = em_bits.div_ceil(8);
    let k = modulus_bits.div_ceil(8);

    let raw = m.to_bytes_be();
    if raw.len() > k {
        return None;
    }
    let mut padded = vec![0u8; k - raw.len()];
    padded.extend_from_slice(&raw);
    // The encoded message is emBits = modBits − 1 bits long. When modBits is
    // one more than a multiple of 8, that is a whole byte shorter than the
    // modulus, and the byte in front of it must be zero. The crate slices that
    // byte off without looking at it, so it is checked here.
    let (leading, em) = padded.split_at(k - em_length);
    if leading.iter().any(|byte| *byte != 0) || em_length < HASH_LENGTH + 2 {
        return None;
    }
    if em[em_length - 1] != 0xBC {
        return None;
    }

    let (masked_db, rest) = em.split_at(em_length - HASH_LENGTH - 1);
    let h = &rest[..HASH_LENGTH];
    let mut db = mgf1_sha256(h, masked_db.len());
    for (byte, masked) in db.iter_mut().zip(masked_db) {
        *byte ^= masked;
    }
    db[0] &= 0xFF >> (8 * em_length - em_bits);

    let separator = db.iter().position(|byte| *byte != 0)?;
    if db[separator] != 0x01 {
        return None;
    }
    Some(db.len() - separator - 1)
}

/// MGF1 with SHA-256 (RFC 8017 §B.2.1).
fn mgf1_sha256(seed: &[u8], length: usize) -> Vec<u8> {
    let mut output = Vec::with_capacity(length + 32);
    let mut counter: u32 = 0;
    while output.len() < length {
        let mut hasher = Sha256::new();
        hasher.update(seed);
        hasher.update(counter.to_be_bytes());
        output.extend_from_slice(&hasher.finalize());
        counter += 1;
    }
    output.truncate(length);
    output
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

/// Reads at most [`MAX_KEY_FILE_BYTES`] from a regular file.
///
/// The size in the file's metadata is not a bound: a FIFO, or a link to a
/// device such as `/dev/zero`, reports zero bytes and then never ends. Such a
/// file is refused before it is opened, and the read itself stops one byte
/// past the limit whatever the metadata said.
fn read_key_file(path: &std::path::Path) -> Result<String, String> {
    use std::io::Read;

    let metadata =
        std::fs::metadata(path).map_err(|_| "the chosen file could not be read".to_owned())?;
    if !metadata.is_file() {
        return Err("the chosen path is not a regular file".to_owned());
    }
    let file = std::fs::File::open(path).map_err(|_| "the chosen file could not be read".to_owned())?;
    let mut bytes = Vec::new();
    file.take(MAX_KEY_FILE_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| "the chosen file could not be read".to_owned())?;
    if bytes.len() as u64 > MAX_KEY_FILE_BYTES {
        return Err(format!(
            "the chosen file is larger than {MAX_KEY_FILE_BYTES} bytes, too large to be a public key"
        ));
    }
    String::from_utf8(bytes).map_err(|_| "the chosen file could not be read as text".to_owned())
}

/// The key the user chose for this session, if any. Nothing is written to
/// disk: a key is trusted until the app closes or the user forgets it.
#[derive(Default)]
pub struct TrustedKeyState(Mutex<Option<TrustedKey>>);

/// Opens a native file dialog, reads the chosen key and trusts it for this
/// session. `Ok(None)` when the dialog was cancelled, in which case the key
/// trusted before — if any — stays trusted.
#[tauri::command]
pub async fn choose_public_key(
    app: tauri::AppHandle,
    state: tauri::State<'_, TrustedKeyState>,
) -> Result<Option<KeySummary>, String> {
    use tauri_plugin_dialog::DialogExt;

    let (sender, receiver) = tokio::sync::oneshot::channel();
    app.dialog()
        .file()
        .set_title("Choose a public key to verify signatures with")
        // No extension filter. macOS types a `.pem` file as an X.509
        // certificate and its panel greyed the key out under a "pem" filter;
        // what the file holds is checked after it is read, not guessed from
        // its name.
        .pick_file(move |chosen| {
            let _ = sender.send(chosen);
        });
    let Some(chosen) = receiver.await.map_err(|_| "the dialog closed unexpectedly".to_owned())?
    else {
        return Ok(None);
    };
    let path = chosen
        .into_path()
        .map_err(|_| "the chosen key is not a file on this machine".to_owned())?;

    let text = read_key_file(&path)?;
    let file_name = path
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_default();

    let key = parse_public_key(&text, &file_name)?;
    let summary = key.summary.clone();
    *state.0.lock().map_err(|_| "the key store is unavailable".to_owned())? = Some(key);
    Ok(Some(summary))
}

/// Stops trusting the chosen key.
#[tauri::command]
pub fn forget_public_key(state: tauri::State<'_, TrustedKeyState>) -> Result<(), String> {
    *state.0.lock().map_err(|_| "the key store is unavailable".to_owned())? = None;
    Ok(())
}

/// The key trusted right now, if any.
#[tauri::command]
pub fn trusted_public_key(
    state: tauri::State<'_, TrustedKeyState>,
) -> Result<Option<KeySummary>, String> {
    Ok(state
        .0
        .lock()
        .map_err(|_| "the key store is unavailable".to_owned())?
        .as_ref()
        .map(|key| key.summary.clone()))
}

/// Verifies one declared signature over `message_base64`, the canonical digest
/// input the webview computed.
///
/// `fingerprint` is the key the caller believes it is verifying with. If the
/// user has since chosen another key, or forgotten this one, the call fails
/// rather than answer under a key the caller did not ask about: every verdict
/// on screen must belong to the key shown beside it.
#[tauri::command]
pub fn verify_signature(
    state: tauri::State<'_, TrustedKeyState>,
    fingerprint: String,
    algorithm: String,
    value: String,
    message_base64: String,
) -> Result<Outcome, String> {
    let guard = state.0.lock().map_err(|_| "the key store is unavailable".to_owned())?;
    let key = guard.as_ref().ok_or_else(|| "no public key is trusted".to_owned())?;
    if key.summary.fingerprint != fingerprint {
        return Err("the trusted key changed while this was being verified".to_owned());
    }
    let message = STANDARD
        .decode(message_base64)
        .map_err(|_| "the signed bytes did not arrive intact".to_owned())?;
    Ok(verify(key, &algorithm, &value, &message))
}
