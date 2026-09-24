//! What librdkafka says went wrong, kept so an error can say more than a code.
use std::sync::Mutex;

use rdkafka::client::ClientContext;
use rdkafka::config::RDKafkaLogLevel;
use rdkafka::consumer::ConsumerContext;
use rdkafka::error::KafkaError;

/// Keeps the most recent error librdkafka reported through its error callback
/// — "SSL handshake failed: certificate verify failed", "SASL authentication
/// error: ..." — because a failed metadata request alone says only that no
/// broker answered. Log lines are dropped: nothing here writes to the
/// terminal of a desktop app.
#[derive(Default)]
pub struct Context {
    last_error: Mutex<Option<String>>,
}

impl Context {
    pub fn last_error(&self) -> Option<String> {
        self.last_error.lock().ok().and_then(|guard| guard.clone())
    }

    /// Keeps an error a poll returned, when the callback gave no reason.
    pub fn note(&self, error: &KafkaError) {
        if let Ok(mut guard) = self.last_error.lock() {
            if guard.is_none() {
                *guard = Some(error.to_string());
            }
        }
    }
}

impl ClientContext for Context {
    fn log(&self, _level: RDKafkaLogLevel, _facility: &str, _message: &str) {}

    fn error(&self, error: KafkaError, reason: &str) {
        if let Ok(mut guard) = self.last_error.lock() {
            *guard = Some(if reason.is_empty() { error.to_string() } else { reason.to_owned() });
        }
    }
}

impl ConsumerContext for Context {}
