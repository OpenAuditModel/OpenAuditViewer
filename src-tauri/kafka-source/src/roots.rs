//! The public root certificates, as the PEM bundle librdkafka reads.
use std::sync::OnceLock;

use base64::engine::general_purpose::STANDARD;
use base64::Engine;

/// Mozilla's root set, from `webpki-root-certs`, as one PEM bundle. Built once.
pub fn mozilla_roots_pem() -> String {
    static PEM: OnceLock<String> = OnceLock::new();
    PEM.get_or_init(|| {
        let mut pem = String::new();
        for certificate in webpki_root_certs::TLS_SERVER_ROOT_CERTS {
            pem.push_str("-----BEGIN CERTIFICATE-----\n");
            let encoded = STANDARD.encode(certificate.as_ref());
            for line in encoded.as_bytes().chunks(64) {
                pem.push_str(std::str::from_utf8(line).expect("base64 is ASCII"));
                pem.push('\n');
            }
            pem.push_str("-----END CERTIFICATE-----\n");
        }
        pem
    })
    .clone()
}
