//! Reads a bounded window of a Kafka topic, and nothing else.
//!
//! This is the first thing in OpenAuditViewer that opens a network connection
//! to somewhere the user chose, so what it will not do is as much the design as
//! what it does:
//!
//! * **It leaves nothing on the broker.** Partitions are assigned and sought,
//!   never subscribed, so no consumer group is joined; offsets are never
//!   committed, automatically or otherwise; asking for a topic that does not
//!   exist does not create it. librdkafka's assign needs a `group.id` all the
//!   same, and the one set here says what it is: [`GROUP_ID`]. The broker is
//!   asked which node coordinates it — which, on a cluster no consumer has
//!   ever used, makes the broker create its internal offsets topic, as any
//!   consumer's first connection would — but the group is never joined. Tests
//!   assert that no group appears in the broker's group list.
//! * **It reads a window, and follows only when asked.** The end of every
//!   partition is taken when reading starts — or given, as a time or an
//!   offset — and the window is everything before it. Following goes on to
//!   hand back what arrives afterwards, and is its own request, never a
//!   default. A read is bounded by an event limit, a byte limit and a deadline
//!   as well, and the report says which of them ended it.
//! * **It sends a credential only where it was told to.** The connection is
//!   described by [`Connection`]; the caller is responsible for keeping a
//!   stored password tied to the brokers it was entered for.
//! * **It does not interpret events.** A record's payload is handed back as
//!   text, with its partition, offset and timestamp beside it rather than
//!   inside it; whether the text is an audit event is the viewer's question.
pub mod connection;
mod context;
mod roots;
pub mod window;

pub use connection::{Connection, ConnectionError, Sasl, SaslMechanism, Security};
pub use window::{
    fetch, End, Event, FetchError, FetchReport, Filter, PartitionOffset, PartitionReport, Record,
    Select, Start, StopReason, Window, MAX_FILTER_CHARS, MAX_RECORD_BYTES, MAX_WINDOW_BYTES,
    MAX_WINDOW_EVENTS,
};

/// The `group.id` librdkafka's assign requires. No group of this name is
/// ever joined, and no offset is ever committed under it.
pub const GROUP_ID: &str = "openaudit-viewer-readonly";

/// The `client.id` the broker sees in its logs.
pub const CLIENT_ID: &str = "openaudit-viewer";
