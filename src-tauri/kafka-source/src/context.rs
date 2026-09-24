//! What librdkafka says went wrong, kept so an error can say more than a code.
use std::sync::Mutex;

use rdkafka::client::ClientContext;
use rdkafka::config::RDKafkaLogLevel;
use rdkafka::consumer::ConsumerContext;
use rdkafka::error::KafkaError;

/// What a reason librdkafka gave says about why a broker was not read.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Refusal {
    /// The broker's certificate could not be verified.
    Certificate,
    /// The broker refused the credentials.
    Credentials,
    /// Anything else: a connection refused or lost, a name that did not resolve.
    Other,
}

impl Refusal {
    pub fn of(reason: &str) -> Self {
        let lower = reason.to_ascii_lowercase();
        // A listener's name ("sasl_ssl://...") appears in every reason on that
        // listener, so neither word alone decides anything.
        if lower.contains("certificate verify") || lower.contains("ssl handshake failed") {
            Self::Certificate
        } else if lower.contains("authentication") {
            Self::Credentials
        } else {
            Self::Other
        }
    }
}

/// Keeps the reasons librdkafka reported through its error callback — "SSL
/// handshake failed: certificate verify failed", "SASL authentication error:
/// ..." — because a failed metadata request alone says only that no broker
/// answered. Log lines are dropped: nothing here writes to the terminal of a
/// desktop app.
#[derive(Default)]
pub struct Context {
    reasons: Mutex<Reasons>,
}

#[derive(Default)]
struct Reasons {
    /// The most recent reason.
    last: Option<String>,
    /// The first reason that says why a broker turned the client away. A host
    /// name can resolve to an address that refuses every connection —
    /// "localhost" as ::1, with the broker listening on 127.0.0.1 only — and
    /// that refusal, reported again on every retry, would otherwise hide what
    /// the address that answered said.
    refusal: Option<String>,
}

impl Context {
    /// The reason to explain an error with: why a broker refused the client,
    /// if one did, and otherwise the most recent reason.
    pub fn reason(&self) -> Option<String> {
        let reasons = self.reasons.lock().ok()?;
        reasons.refusal.clone().or_else(|| reasons.last.clone())
    }

    /// Whether a broker has said why it refused the client, so that no later
    /// reason can change the explanation.
    pub fn refused(&self) -> bool {
        self.reasons.lock().is_ok_and(|reasons| reasons.refusal.is_some())
    }

    /// Keeps an error a poll returned, when the callback gave no reason.
    pub fn note(&self, error: &KafkaError) {
        if let Ok(mut reasons) = self.reasons.lock() {
            if reasons.last.is_none() {
                reasons.last = Some(error.to_string());
            }
        }
    }

    fn keep(&self, reason: String) {
        if let Ok(mut reasons) = self.reasons.lock() {
            if reasons.refusal.is_none() && Refusal::of(&reason) != Refusal::Other {
                reasons.refusal = Some(reason.clone());
            }
            reasons.last = Some(reason);
        }
    }
}

impl ClientContext for Context {
    fn log(&self, _level: RDKafkaLogLevel, _facility: &str, _message: &str) {}

    fn error(&self, error: KafkaError, reason: &str) {
        self.keep(if reason.is_empty() { error.to_string() } else { reason.to_owned() });
    }
}

impl ConsumerContext for Context {}

#[cfg(test)]
mod tests {
    use super::*;

    const REFUSED: &str = "sasl_ssl://localhost:9094/bootstrap: Connect to ipv6#[::1]:9094 failed: \
                           Connection refused (after 0ms in state CONNECT)";
    const BAD_PASSWORD: &str = "sasl_ssl://localhost:9094/bootstrap: SASL authentication error: \
                                Authentication failed during authentication due to invalid \
                                credentials with SASL mechanism SCRAM-SHA-256";
    const UNTRUSTED: &str = "sasl_ssl://localhost:9094/bootstrap: SSL handshake failed: \
                             error:0A000086:SSL routines::certificate verify failed";

    #[test]
    fn a_refusal_is_told_apart_from_a_connection_that_failed() {
        assert_eq!(Refusal::of(BAD_PASSWORD), Refusal::Credentials);
        assert_eq!(Refusal::of(UNTRUSTED), Refusal::Certificate);
        assert_eq!(Refusal::of(REFUSED), Refusal::Other);
        // The listener's name alone decides nothing.
        assert_eq!(Refusal::of("sasl_ssl://localhost:9094/bootstrap: Disconnected"), Refusal::Other);
    }

    #[test]
    fn why_a_broker_refused_outlasts_the_address_that_never_answered() {
        let context = Context::default();
        context.error(KafkaError::Canceled, REFUSED);
        assert_eq!(context.reason().as_deref(), Some(REFUSED));
        assert!(!context.refused());

        context.error(KafkaError::Canceled, BAD_PASSWORD);
        context.error(KafkaError::Canceled, REFUSED);
        assert_eq!(context.reason().as_deref(), Some(BAD_PASSWORD));
        assert!(context.refused());
    }

    #[test]
    fn a_reason_from_the_callback_is_not_replaced_by_a_bare_code() {
        let context = Context::default();
        context.error(KafkaError::Canceled, REFUSED);
        context.note(&KafkaError::Canceled);
        assert_eq!(context.reason().as_deref(), Some(REFUSED));
    }
}
