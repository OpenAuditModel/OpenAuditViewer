//! One bounded read of a topic, and optionally what arrives after it.
use std::cmp::{Ordering as Order, Reverse};
use std::collections::{BTreeMap, BinaryHeap};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

use rdkafka::consumer::{BaseConsumer, Consumer};
use rdkafka::error::{KafkaError, RDKafkaErrorCode};
use rdkafka::message::Message;
use rdkafka::topic_partition_list::{Offset, TopicPartitionList};
use serde::{Deserialize, Serialize};

use crate::connection::{validate_topic, Connection};
use crate::context::{Context, Refusal};

/// Most events one window holds: the viewer's own ceiling for a folder.
pub const MAX_WINDOW_EVENTS: usize = 100_000;

/// Largest single record accepted as an event: the conformance tooling's limit
/// for one line of JSON Lines.
pub const MAX_RECORD_BYTES: usize = 8 * 1024 * 1024;

/// Most payload bytes one window holds.
pub const MAX_WINDOW_BYTES: usize = 256 * 1024 * 1024;

/// Longest filter text, in characters.
pub const MAX_FILTER_CHARS: usize = 200;

/// Records handed back per batch.
const BATCH_SIZE: usize = 500;

/// Longest a batch waits before it is handed back anyway, so progress shows.
const BATCH_INTERVAL: Duration = Duration::from_millis(250);

/// How long a metadata or offset request may take.
const REQUEST_TIMEOUT: Duration = Duration::from_secs(15);

/// Where in each partition reading starts.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum Start {
    /// The oldest record the broker still holds.
    Earliest,
    /// The newest `count` records of each partition.
    Latest { count: u64 },
    /// The first record at or after this time, in milliseconds since the epoch.
    Timestamp { millis: i64 },
    /// This offset in every partition, moved into the range the partition
    /// holds when it lies outside it.
    Offset { offset: i64 },
    /// An offset for each partition named; only those partitions are read.
    Offsets { offsets: Vec<PartitionOffset> },
}

/// One partition's starting offset.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct PartitionOffset {
    pub partition: i32,
    pub offset: i64,
}

/// Where in each partition the window ends. Nothing at or after the end is
/// part of the window — though a window that follows reads on past it.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum End {
    /// The end each partition had when reading started.
    #[default]
    Now,
    /// The last record before this time, in milliseconds since the epoch.
    Timestamp { millis: i64 },
    /// This offset in every partition, included.
    Offset { offset: i64 },
}

/// Which of the records read are kept, across the whole topic.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum Select {
    /// Every record read, up to the event limit.
    #[default]
    All,
    /// The `count` oldest records by timestamp, across every partition read.
    Oldest { count: usize },
    /// The `count` newest records by timestamp, across every partition read.
    Newest { count: usize },
}

/// Which records are kept, by what they hold. Empty fields match everything.
/// A record whose value is not a JSON object matches only an empty filter.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Filter {
    /// Text the record's value contains, compared without regard to case.
    pub contains: Option<String>,
    /// The start of `event.name`, such as `auth.` or `data.record.`.
    pub event_name_prefix: Option<String>,
    /// `application.name`, exactly.
    pub application: Option<String>,
}

fn present(value: &Option<String>) -> Option<&str> {
    value.as_deref().map(str::trim).filter(|text| !text.is_empty())
}

impl Filter {
    fn is_empty(&self) -> bool {
        present(&self.contains).is_none()
            && present(&self.event_name_prefix).is_none()
            && present(&self.application).is_none()
    }

    fn validate(&self) -> Result<(), FetchError> {
        for (what, value) in [
            ("the text to look for", &self.contains),
            ("the event name", &self.event_name_prefix),
            ("the application", &self.application),
        ] {
            if let Some(text) = present(value) {
                if text.chars().count() > MAX_FILTER_CHARS {
                    return Err(FetchError::Invalid(format!(
                        "{what} is at most {MAX_FILTER_CHARS} characters"
                    )));
                }
            }
        }
        Ok(())
    }

    /// Whether a record's value passes. Checked once per record read.
    fn matches(&self, payload: Option<&str>) -> bool {
        if self.is_empty() {
            return true;
        }
        let Some(payload) = payload else {
            return false;
        };
        if let Some(needle) = present(&self.contains) {
            if !payload.to_lowercase().contains(&needle.to_lowercase()) {
                return false;
            }
        }
        let prefix = present(&self.event_name_prefix);
        let application = present(&self.application);
        if prefix.is_none() && application.is_none() {
            return true;
        }
        let Ok(serde_json::Value::Object(event)) = serde_json::from_str::<serde_json::Value>(payload)
        else {
            return false;
        };
        let field = |outer: &str, inner: &str| {
            event.get(outer).and_then(|value| value.get(inner)).and_then(serde_json::Value::as_str)
        };
        prefix.is_none_or(|prefix| field("event", "name").is_some_and(|name| name.starts_with(prefix)))
            && application
                .is_none_or(|application| field("application", "name") == Some(application))
    }
}

/// What to read.
#[derive(Clone, Debug)]
pub struct Window {
    pub topic: String,
    /// The partitions to read; every partition of the topic when `None`.
    pub partitions: Option<Vec<i32>>,
    pub start: Start,
    pub end: End,
    pub select: Select,
    pub filter: Filter,
    /// At most this many records are kept, and never more than
    /// [`MAX_WINDOW_EVENTS`]. For [`Select::Oldest`] and [`Select::Newest`],
    /// their count is the limit.
    pub max_events: usize,
    /// After the window is read, go on reading what the topic receives until
    /// stopped. Needs [`End::Now`], and cannot follow [`Select::Oldest`].
    pub follow: bool,
    /// Reading the window — before any following — stops here.
    pub window_deadline: Duration,
    /// Reading stops here whatever else is true, following included.
    pub deadline: Duration,
    /// Reading the window stops when no record has arrived for this long
    /// before its end was reached. Following does not stall: waiting is what
    /// it does.
    pub stall: Duration,
}

/// One record, with where it came from beside it rather than inside it.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Record {
    pub partition: i32,
    pub offset: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub timestamp_millis: Option<i64>,
    /// The payload as text; absent when it could not be given as an event.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub payload: Option<String>,
    /// Why there is no payload.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub problem: Option<String>,
}

/// What reading reports as it goes.
#[derive(Clone, Debug)]
pub enum Event {
    /// Records kept, in the order they are handed back.
    Records(Vec<Record>),
    /// Every record of the window has been handed back, and this is what each
    /// partition gave. When following, what comes after this is new.
    CaughtUp { partitions: Vec<PartitionReport> },
    /// Records read from the broker so far, and how many were kept.
    Progress { scanned: u64, kept: u64 },
}

/// Why reading stopped.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum StopReason {
    /// Every partition was read to the end of the window.
    EndOfWindow,
    /// The event limit was reached first.
    EventLimit,
    /// The byte limit was reached first.
    ByteLimit,
    /// The user stopped it.
    Cancelled,
    /// The deadline passed first.
    TimedOut,
    /// Records stopped arriving before the end was reached.
    Stalled,
}

/// What one partition contributed.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PartitionReport {
    pub partition: i32,
    /// The first offset asked for.
    pub start_offset: i64,
    /// Where the window ended in this partition: nothing at or after it was
    /// part of the window.
    pub end_offset: i64,
    /// The oldest offset the broker held when reading started.
    pub low_offset: i64,
    /// Records kept from this partition, window and following together.
    pub records: u64,
    /// Whether the partition was read to `end_offset`.
    pub complete: bool,
}

/// What a window held and why it ended.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FetchReport {
    pub topic: String,
    pub partitions: Vec<PartitionReport>,
    /// Records read from the broker, kept or not.
    pub scanned: u64,
    /// Records kept and handed back, window and following together.
    pub records: u64,
    /// Of those, the ones that arrived after the window was read.
    pub followed: u64,
    pub bytes: u64,
    /// Whether every record of the window was handed back.
    pub caught_up: bool,
    pub stop: StopReason,
}

/// Why nothing could be read. Every message is written here; none carries a
/// secret, and the reason librdkafka gave is kept where there is one.
#[derive(Debug, PartialEq, Eq)]
pub enum FetchError {
    Invalid(String),
    Unreachable(String),
    Authentication(String),
    TopicMissing(String),
    NotAuthorized(String),
    PartitionMissing(String),
    Broker(String),
}

impl std::fmt::Display for FetchError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            FetchError::Invalid(message)
            | FetchError::Unreachable(message)
            | FetchError::Authentication(message)
            | FetchError::TopicMissing(message)
            | FetchError::NotAuthorized(message)
            | FetchError::PartitionMissing(message)
            | FetchError::Broker(message) => formatter.write_str(message),
        }
    }
}

impl std::error::Error for FetchError {}

/// Turns a librdkafka error into one the viewer can show, with the reason the
/// error callback gave when there was one.
fn explain(error: &KafkaError, context: &Context, topic: &str) -> FetchError {
    let reason = context.reason();
    let with_reason = |message: &str| match &reason {
        Some(reason) => format!("{message}: {reason}"),
        None => message.to_owned(),
    };
    let code = error.rdkafka_error_code();
    let refusal = reason.as_deref().map_or(Refusal::Other, Refusal::of);
    let certificate = refusal == Refusal::Certificate;
    let authentication = refusal == Refusal::Credentials;
    match code {
        Some(RDKafkaErrorCode::UnknownTopicOrPartition | RDKafkaErrorCode::UnknownTopic) => {
            FetchError::TopicMissing(format!("the cluster has no topic \"{topic}\""))
        }
        Some(RDKafkaErrorCode::TopicAuthorizationFailed) => FetchError::NotAuthorized(format!(
            "this user may not read topic \"{topic}\""
        )),
        Some(
            RDKafkaErrorCode::SaslAuthenticationFailed | RDKafkaErrorCode::Authentication,
        ) => FetchError::Authentication(with_reason("the broker refused the credentials")),
        _ if authentication => {
            FetchError::Authentication(with_reason("the broker refused the credentials"))
        }
        _ if certificate => FetchError::Unreachable(with_reason(
            "the broker's certificate could not be verified; if a private CA signed it, add that CA to this source",
        )),
        Some(
            RDKafkaErrorCode::BrokerTransportFailure
            | RDKafkaErrorCode::AllBrokersDown
            | RDKafkaErrorCode::Resolve
            | RDKafkaErrorCode::OperationTimedOut
            | RDKafkaErrorCode::RequestTimedOut
            | RDKafkaErrorCode::SSL,
        ) => FetchError::Unreachable(with_reason("no broker could be reached")),
        _ => FetchError::Broker(with_reason(&format!("the broker answered with an error ({error})"))),
    }
}

/// Serves the events librdkafka queued while a blocking request waited, so
/// that the error callback has seen the reason — "SSL handshake failed",
/// "SASL authentication error" — before an error is explained. A metadata
/// request that failed says only that no broker answered.
///
/// Every queued event is served, not only the first: the first can be an
/// address that refused the connection, queued before the one that answered
/// said why it turned the client away.
fn collect_reasons(consumer: &BaseConsumer<Context>) {
    let until = Instant::now() + Duration::from_millis(500);
    while !consumer.context().refused() && Instant::now() < until {
        match consumer.poll(Duration::from_millis(50)) {
            Some(Err(error)) => consumer.context().note(&error),
            Some(Ok(_)) => {}
            None if consumer.context().reason().is_some() => break,
            None => {}
        }
    }
}

/// [`explain`], after [`collect_reasons`].
fn failed(error: KafkaError, consumer: &BaseConsumer<Context>, topic: &str) -> FetchError {
    collect_reasons(consumer);
    explain(&error, consumer.context(), topic)
}

struct PartitionState {
    report: PartitionReport,
    /// Records kept from the window, for [`Select::Oldest`]'s per-partition cap.
    kept: usize,
}

/// Checks a window before anything connects.
fn check(window: &Window) -> Result<(), FetchError> {
    validate_topic(&window.topic).map_err(|error| FetchError::Invalid(error.0))?;
    window.filter.validate()?;
    if window.max_events == 0 {
        return Err(FetchError::Invalid("ask for at least one event".into()));
    }
    match &window.start {
        Start::Latest { count: 0 } => {
            return Err(FetchError::Invalid("ask for at least one record per partition".into()))
        }
        Start::Offsets { offsets } if offsets.is_empty() => {
            return Err(FetchError::Invalid("name at least one partition and its offset".into()))
        }
        _ if window.partitions.as_ref().is_some_and(Vec::is_empty) => {
            return Err(FetchError::Invalid(
                "name at least one partition, or leave the list out for all of them".into(),
            ))
        }
        Start::Offsets { .. } if window.partitions.is_some() => {
            return Err(FetchError::Invalid(
                "name the partitions with their offsets, or in the partition list, not both".into(),
            ))
        }
        _ => {}
    }
    match window.select {
        Select::Oldest { count } | Select::Newest { count }
            if count == 0 || count > MAX_WINDOW_EVENTS =>
        {
            return Err(FetchError::Invalid(format!(
                "ask for between 1 and {MAX_WINDOW_EVENTS} records"
            )))
        }
        _ => {}
    }
    if window.follow && window.end != End::Now {
        return Err(FetchError::Invalid(
            "a window that ends before now cannot go on to follow what arrives".into(),
        ));
    }
    if window.follow && matches!(window.select, Select::Oldest { .. }) {
        return Err(FetchError::Invalid(
            "the oldest records cannot be followed by what arrives now; read the newest instead".into(),
        ));
    }
    Ok(())
}

fn payload_bytes(record: &Record) -> u64 {
    record.payload.as_ref().map_or(0, String::len) as u64
}

/// A record held for a selection, ordered by the time it carries, then
/// where it sits.
struct Held {
    order: (i64, i32, i64),
    record: Record,
}

impl PartialEq for Held {
    fn eq(&self, other: &Self) -> bool {
        self.order == other.order
    }
}

impl Eq for Held {}

impl PartialOrd for Held {
    fn partial_cmp(&self, other: &Self) -> Option<Order> {
        Some(self.cmp(other))
    }
}

impl Ord for Held {
    fn cmp(&self, other: &Self) -> Order {
        self.order.cmp(&other.order)
    }
}

/// The records kept for a topic-wide selection: never more than `count` —
/// the newest or the oldest seen so far — with their bytes counted as they
/// come and go, so that holding a selection costs what it keeps and not
/// what was read. A record with no timestamp is the least wanted either way.
enum Selection {
    None,
    /// A min-heap: the oldest of the kept records is the one to drop.
    Newest { count: usize, heap: BinaryHeap<Reverse<Held>>, bytes: u64 },
    /// A max-heap: the newest of the kept records is the one to drop.
    Oldest { count: usize, heap: BinaryHeap<Held>, bytes: u64 },
}

impl Selection {
    fn new(select: Select) -> Self {
        match select {
            Select::All => Selection::None,
            Select::Newest { count } => Selection::Newest { count, heap: BinaryHeap::new(), bytes: 0 },
            Select::Oldest { count } => Selection::Oldest { count, heap: BinaryHeap::new(), bytes: 0 },
        }
    }

    fn is_active(&self) -> bool {
        !matches!(self, Selection::None)
    }

    fn len(&self) -> usize {
        match self {
            Selection::None => 0,
            Selection::Newest { heap, .. } => heap.len(),
            Selection::Oldest { heap, .. } => heap.len(),
        }
    }

    fn bytes(&self) -> u64 {
        match self {
            Selection::None => 0,
            Selection::Newest { bytes, .. } | Selection::Oldest { bytes, .. } => *bytes,
        }
    }

    fn offer(&mut self, record: Record) {
        let size = payload_bytes(&record);
        match self {
            Selection::None => {}
            Selection::Newest { count, heap, bytes } => {
                let at = record.timestamp_millis.unwrap_or(i64::MIN);
                heap.push(Reverse(Held { order: (at, record.partition, record.offset), record }));
                *bytes += size;
                if heap.len() > *count {
                    if let Some(Reverse(dropped)) = heap.pop() {
                        *bytes -= payload_bytes(&dropped.record);
                    }
                }
            }
            Selection::Oldest { count, heap, bytes } => {
                let at = record.timestamp_millis.unwrap_or(i64::MAX);
                heap.push(Held { order: (at, record.partition, record.offset), record });
                *bytes += size;
                if heap.len() > *count {
                    if let Some(dropped) = heap.pop() {
                        *bytes -= payload_bytes(&dropped.record);
                    }
                }
            }
        }
    }

    /// The kept records, oldest first.
    fn take(&mut self) -> Vec<Record> {
        let mut held: Vec<Held> = match std::mem::replace(self, Selection::None) {
            Selection::None => Vec::new(),
            Selection::Newest { heap, .. } => heap.into_iter().map(|Reverse(held)| held).collect(),
            Selection::Oldest { heap, .. } => heap.into_vec(),
        };
        held.sort();
        held.into_iter().map(|held| held.record).collect()
    }
}

/// Hands a selection back in batches, oldest first, and counts it.
fn hand_back_selection(
    selection: &mut Selection,
    partitions: &mut BTreeMap<i32, PartitionState>,
    kept: &mut u64,
    bytes: &mut u64,
    on_event: &mut impl FnMut(Event),
) {
    let chosen = selection.take();
    for record in &chosen {
        if let Some(state) = partitions.get_mut(&record.partition) {
            state.report.records += 1;
        }
        *bytes += payload_bytes(record);
    }
    *kept += chosen.len() as u64;
    for piece in chosen.chunks(BATCH_SIZE) {
        on_event(Event::Records(piece.to_vec()));
    }
}

/// Asks the broker which offset each partition holds at a time: the first
/// record at or after it, or `None` where there is none.
fn offsets_at(
    consumer: &BaseConsumer<Context>,
    topic: &str,
    partitions: impl Iterator<Item = i32>,
    millis: i64,
) -> Result<BTreeMap<i32, Option<i64>>, FetchError> {
    let mut query = TopicPartitionList::new();
    for partition in partitions {
        query
            .add_partition_offset(topic, partition, Offset::Offset(millis))
            .map_err(|error| FetchError::Invalid(error.to_string()))?;
    }
    let found = consumer
        .offsets_for_times(query, REQUEST_TIMEOUT)
        .map_err(|error| failed(error, consumer, topic))?;
    Ok(found
        .elements()
        .iter()
        .map(|element| {
            let offset = match element.offset() {
                Offset::Offset(offset) => Some(offset),
                _ => None,
            };
            (element.partition(), offset)
        })
        .collect())
}

/// Reads one window of `window.topic` over `connection`, and when asked goes
/// on reading what the topic receives.
///
/// `on_event` receives records a batch at a time, a [`Event::CaughtUp`] once
/// every record of the window has been handed back, and progress as it goes;
/// `cancel` is checked between polls. The report is complete even when reading
/// stopped early: it names every partition, what each gave, and why reading
/// ended.
pub fn fetch(
    connection: &Connection,
    window: &Window,
    cancel: &AtomicBool,
    mut on_event: impl FnMut(Event),
) -> Result<FetchReport, FetchError> {
    check(window)?;
    // How many of the window's records are kept, and how many in all once
    // following adds to them.
    let window_limit = match window.select {
        Select::All => window.max_events.min(MAX_WINDOW_EVENTS),
        Select::Oldest { count } | Select::Newest { count } => count,
    };
    let total_limit = window.max_events.min(MAX_WINDOW_EVENTS).max(window_limit);
    let config = connection.client_config().map_err(|error| FetchError::Invalid(error.0))?;
    let consumer: BaseConsumer<Context> = config
        .create_with_context(Context::default())
        .map_err(|error| FetchError::Invalid(format!("the connection could not be set up: {error}")))?;
    let topic = window.topic.as_str();

    // The partitions, from the topic's metadata. Asking does not create it.
    let metadata = consumer
        .fetch_metadata(Some(topic), REQUEST_TIMEOUT)
        .map_err(|error| failed(error, &consumer, topic))?;
    let Some(described) = metadata.topics().iter().find(|t| t.name() == topic) else {
        return Err(FetchError::TopicMissing(format!("the cluster has no topic \"{topic}\"")));
    };
    if let Some(error) = described.error() {
        return Err(explain(
            &KafkaError::MetadataFetch(error.into()),
            consumer.context(),
            topic,
        ));
    }
    let available: Vec<i32> = described.partitions().iter().map(|p| p.id()).collect();
    if available.is_empty() {
        return Err(FetchError::TopicMissing(format!("topic \"{topic}\" has no partitions")));
    }
    let asked: Option<Vec<i32>> = match &window.start {
        Start::Offsets { offsets } => Some(offsets.iter().map(|entry| entry.partition).collect()),
        _ => window.partitions.clone(),
    };
    let chosen: Vec<i32> = match asked {
        None => {
            let mut all = available.clone();
            all.sort_unstable();
            all
        }
        Some(asked) => {
            let mut chosen = Vec::new();
            for partition in asked {
                if !available.contains(&partition) {
                    return Err(FetchError::PartitionMissing(format!(
                        "topic \"{topic}\" has no partition {partition}; it has partitions 0 to {}",
                        available.len() - 1
                    )));
                }
                if !chosen.contains(&partition) {
                    chosen.push(partition);
                }
            }
            chosen.sort_unstable();
            chosen
        }
    };

    // Each partition's range, taken once. Nothing written after this moment
    // is part of the window.
    let mut partitions: BTreeMap<i32, PartitionState> = BTreeMap::new();
    for &partition in &chosen {
        let (low, high) = consumer
            .fetch_watermarks(topic, partition, REQUEST_TIMEOUT)
            .map_err(|error| failed(error, &consumer, topic))?;
        partitions.insert(
            partition,
            PartitionState {
                report: PartitionReport {
                    partition,
                    start_offset: low,
                    end_offset: high,
                    low_offset: low,
                    records: 0,
                    complete: false,
                },
                kept: 0,
            },
        );
    }

    // Where each partition ends.
    match window.end {
        End::Now => {}
        End::Offset { offset } => {
            for state in partitions.values_mut() {
                let report = &mut state.report;
                report.end_offset = offset.saturating_add(1).clamp(report.low_offset, report.end_offset);
            }
        }
        End::Timestamp { millis } => {
            let found = offsets_at(&consumer, topic, partitions.keys().copied(), millis)?;
            for (partition, offset) in found {
                if let (Some(state), Some(offset)) = (partitions.get_mut(&partition), offset) {
                    let report = &mut state.report;
                    report.end_offset = offset.clamp(report.low_offset, report.end_offset);
                }
            }
        }
    }

    // Where each partition starts.
    match &window.start {
        Start::Earliest => {}
        Start::Latest { count } => {
            for state in partitions.values_mut() {
                let report = &mut state.report;
                let count = i64::try_from(*count).unwrap_or(i64::MAX);
                report.start_offset = report.end_offset.saturating_sub(count).max(report.low_offset);
            }
        }
        Start::Offset { offset } => {
            for state in partitions.values_mut() {
                let report = &mut state.report;
                report.start_offset = (*offset).clamp(report.low_offset, report.end_offset);
            }
        }
        Start::Offsets { offsets } => {
            for entry in offsets {
                if let Some(state) = partitions.get_mut(&entry.partition) {
                    let report = &mut state.report;
                    report.start_offset = entry.offset.clamp(report.low_offset, report.end_offset);
                }
            }
        }
        Start::Timestamp { millis } => {
            let found = offsets_at(&consumer, topic, partitions.keys().copied(), *millis)?;
            for (partition, offset) in found {
                if let Some(state) = partitions.get_mut(&partition) {
                    let report = &mut state.report;
                    report.start_offset = match offset {
                        Some(offset) => offset.clamp(report.low_offset, report.end_offset),
                        // No record at or after that time: nothing to read here.
                        None => report.end_offset,
                    };
                }
            }
        }
    }
    for state in partitions.values_mut() {
        if state.report.start_offset >= state.report.end_offset {
            state.report.complete = true;
        }
    }

    // Assigned, never subscribed: no group is joined. A partition already
    // complete is still assigned when following, from its end.
    let mut assignment = TopicPartitionList::new();
    for state in partitions.values() {
        let from = if state.report.complete {
            if !window.follow {
                continue;
            }
            state.report.end_offset
        } else {
            state.report.start_offset
        };
        assignment
            .add_partition_offset(topic, state.report.partition, Offset::Offset(from))
            .map_err(|error| FetchError::Invalid(error.to_string()))?;
    }

    let started = Instant::now();
    let mut last_record = Instant::now();
    let mut last_flush = Instant::now();
    let mut batch: Vec<Record> = Vec::with_capacity(BATCH_SIZE);
    // The window's records, held for a topic-wide selection until it is read.
    let mut selection = Selection::new(window.select);
    // Records past the window's end that arrived while it was still being
    // read, when following: new, and handed back once the window is.
    let mut backlog: Vec<Record> = Vec::new();
    let mut backlog_bytes: u64 = 0;
    let mut scanned: u64 = 0;
    let mut kept: u64 = 0;
    let mut followed: u64 = 0;
    let mut bytes: u64 = 0;
    let mut caught_up = false;

    let all_complete = |partitions: &BTreeMap<i32, PartitionState>| {
        partitions.values().all(|state| state.report.complete)
    };

    if !assignment.elements().is_empty() {
        consumer
            .assign(&assignment)
            .map_err(|error| failed(error, &consumer, topic))?;
    }

    let stop = loop {
        if !caught_up && all_complete(&partitions) {
            // The window is read: select from it if asked, hand it back, and
            // say so. What follows, if anything, is new.
            if selection.is_active() {
                hand_back_selection(&mut selection, &mut partitions, &mut kept, &mut bytes, &mut on_event);
            } else if !batch.is_empty() {
                on_event(Event::Records(std::mem::take(&mut batch)));
            }
            on_event(Event::Progress { scanned, kept });
            on_event(Event::CaughtUp {
                partitions: partitions.values().map(|state| state.report.clone()).collect(),
            });
            caught_up = true;
            last_flush = Instant::now();
            if !window.follow {
                break StopReason::EndOfWindow;
            }
            // The backlog counts against the same limits as anything else.
            let mut over = false;
            for record in std::mem::take(&mut backlog) {
                if kept as usize >= total_limit {
                    over = true;
                    break;
                }
                if let Some(state) = partitions.get_mut(&record.partition) {
                    state.report.records += 1;
                }
                kept += 1;
                followed += 1;
                bytes += payload_bytes(&record);
                batch.push(record);
            }
            backlog_bytes = 0;
            if over || kept as usize >= total_limit {
                break StopReason::EventLimit;
            }
        }
        if cancel.load(Ordering::Relaxed) {
            break StopReason::Cancelled;
        }
        if started.elapsed() >= window.deadline
            || (!caught_up && started.elapsed() >= window.window_deadline)
        {
            break StopReason::TimedOut;
        }
        if !caught_up && last_record.elapsed() >= window.stall {
            break StopReason::Stalled;
        }
        if last_flush.elapsed() >= BATCH_INTERVAL {
            if !batch.is_empty() {
                on_event(Event::Records(std::mem::take(&mut batch)));
            }
            on_event(Event::Progress { scanned, kept: kept + selection.len() as u64 });
            last_flush = Instant::now();
        }
        let Some(polled) = consumer.poll(Duration::from_millis(100)) else {
            continue;
        };
        let message = match polled {
            Ok(message) => message,
            Err(KafkaError::PartitionEOF(partition)) => {
                if let Some(state) = partitions.get_mut(&partition) {
                    state.report.complete = true;
                }
                continue;
            }
            Err(error) => {
                // Decided by the error's own code: the last reason the error
                // callback gave may be about something else, long past — a
                // bootstrap server that once refused a login must not make a
                // later network blip end the read.
                match error.rdkafka_error_code() {
                    Some(
                        RDKafkaErrorCode::SaslAuthenticationFailed
                        | RDKafkaErrorCode::Authentication
                        | RDKafkaErrorCode::TopicAuthorizationFailed,
                    ) => return Err(explain(&error, consumer.context(), topic)),
                    // Transient: librdkafka retries on its own, and the stall
                    // timer ends a read that never recovers.
                    _ => continue,
                }
            }
        };
        let partition = message.partition();
        let offset = message.offset();
        let Some(state) = partitions.get_mut(&partition) else {
            continue;
        };
        let beyond = offset >= state.report.end_offset;
        if beyond && !window.follow {
            state.report.complete = true;
            continue;
        }
        if !beyond && state.report.complete {
            // The window's share of this partition is already taken — the
            // oldest records of it, when selecting the oldest.
            continue;
        }
        scanned += 1;
        last_record = Instant::now();
        if !beyond && offset + 1 >= state.report.end_offset {
            state.report.complete = true;
        }

        let (payload, problem) = match message.payload() {
            None => (None, Some("the record has no value (a tombstone)".to_owned())),
            Some(value) if value.len() > MAX_RECORD_BYTES => (
                None,
                Some(format!(
                    "the record is {} bytes, above the {MAX_RECORD_BYTES} byte limit for one event",
                    value.len()
                )),
            ),
            Some(value) => match std::str::from_utf8(value) {
                Ok(text) => (Some(text.to_owned()), None),
                Err(_) => (None, Some("the record's value is not UTF-8 text".to_owned())),
            },
        };
        if !window.filter.matches(payload.as_deref()) {
            continue;
        }
        let size = payload.as_ref().map_or(0, String::len) as u64;
        if bytes + selection.bytes() + backlog_bytes + size > MAX_WINDOW_BYTES as u64 {
            break StopReason::ByteLimit;
        }
        let record = Record {
            partition,
            offset,
            timestamp_millis: message.timestamp().to_millis(),
            payload,
            problem,
        };

        if beyond && !caught_up {
            backlog_bytes += size;
            backlog.push(record);
            continue;
        }
        if !beyond && selection.is_active() {
            state.kept += 1;
            if let Select::Oldest { count } = window.select {
                if state.kept >= count {
                    state.report.complete = true;
                }
            }
            selection.offer(record);
            continue;
        }
        state.report.records += 1;
        kept += 1;
        bytes += size;
        if beyond {
            followed += 1;
        }
        batch.push(record);
        if batch.len() >= BATCH_SIZE {
            on_event(Event::Records(std::mem::take(&mut batch)));
            last_flush = Instant::now();
        }
        if kept as usize >= if caught_up { total_limit } else { window_limit } {
            if !caught_up && all_complete(&partitions) {
                continue;
            }
            break StopReason::EventLimit;
        }
    };
    // Stopped before the window was read: a selection still hands back what
    // it chose from the part that was, and the stop says the part was all.
    if !caught_up && selection.is_active() {
        hand_back_selection(&mut selection, &mut partitions, &mut kept, &mut bytes, &mut on_event);
    }
    if !batch.is_empty() {
        on_event(Event::Records(batch));
    }
    on_event(Event::Progress { scanned, kept });

    Ok(FetchReport {
        topic: window.topic.clone(),
        partitions: partitions.into_values().map(|state| state.report).collect(),
        scanned,
        records: kept,
        followed,
        bytes,
        caught_up,
        stop,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn filter(contains: &str, prefix: &str, application: &str) -> Filter {
        let some = |text: &str| (!text.is_empty()).then(|| text.to_owned());
        Filter {
            contains: some(contains),
            event_name_prefix: some(prefix),
            application: some(application),
        }
    }

    const EVENT: &str = r#"{"event":{"name":"auth.login.failure"},"application":{"name":"Identity"},"actor":{"id":"user-42"}}"#;

    #[test]
    fn an_empty_filter_keeps_everything_even_what_is_not_an_event() {
        assert!(Filter::default().matches(Some("not json")));
        assert!(Filter::default().matches(None));
        assert!(filter(" ", "", "").matches(None), "white space is no filter");
    }

    #[test]
    fn a_filter_matches_text_event_name_prefix_and_application() {
        assert!(filter("USER-42", "", "").matches(Some(EVENT)), "text ignores case");
        assert!(filter("", "auth.", "").matches(Some(EVENT)));
        assert!(!filter("", "data.", "").matches(Some(EVENT)));
        assert!(filter("", "", "Identity").matches(Some(EVENT)));
        assert!(!filter("", "", "identity").matches(Some(EVENT)), "an application is matched exactly");
        assert!(filter("login", "auth.", "Identity").matches(Some(EVENT)));
        assert!(!filter("login", "auth.", "Billing").matches(Some(EVENT)), "every field must match");
    }

    #[test]
    fn a_field_filter_never_matches_what_is_not_a_json_object() {
        assert!(!filter("", "auth.", "").matches(Some("auth.login")));
        assert!(!filter("", "", "Identity").matches(Some("[]")));
        assert!(!filter("x", "", "").matches(None), "no value holds no text");
    }

    fn window(start: Start) -> Window {
        Window {
            topic: "audit.events".into(),
            partitions: None,
            start,
            end: End::Now,
            select: Select::All,
            filter: Filter::default(),
            max_events: 10,
            follow: false,
            window_deadline: Duration::from_secs(1),
            deadline: Duration::from_secs(1),
            stall: Duration::from_secs(1),
        }
    }

    #[test]
    fn following_needs_an_open_end_and_cannot_follow_the_oldest() {
        let mut follows = window(Start::Earliest);
        follows.follow = true;
        assert!(check(&follows).is_ok());
        follows.end = End::Offset { offset: 10 };
        assert!(check(&follows).is_err());
        follows.end = End::Now;
        follows.select = Select::Oldest { count: 5 };
        assert!(check(&follows).is_err());
        follows.select = Select::Newest { count: 5 };
        assert!(check(&follows).is_ok());
    }

    #[test]
    fn offsets_name_their_partitions_or_the_list_does_not_both() {
        let mut both = window(Start::Offsets {
            offsets: vec![PartitionOffset { partition: 0, offset: 5 }],
        });
        assert!(check(&both).is_ok());
        both.partitions = Some(vec![1]);
        assert!(check(&both).is_err());
        assert!(check(&window(Start::Offsets { offsets: vec![] })).is_err());
    }

    #[test]
    fn a_selection_asks_for_between_one_and_the_ceiling() {
        let mut selecting = window(Start::Earliest);
        selecting.select = Select::Newest { count: 0 };
        assert!(check(&selecting).is_err());
        selecting.select = Select::Newest { count: MAX_WINDOW_EVENTS + 1 };
        assert!(check(&selecting).is_err());
        selecting.select = Select::Oldest { count: 500 };
        assert!(check(&selecting).is_ok());
    }

    fn record(partition: i32, offset: i64, at: Option<i64>, payload: &str) -> Record {
        Record {
            partition,
            offset,
            timestamp_millis: at,
            payload: Some(payload.to_owned()),
            problem: None,
        }
    }

    #[test]
    fn a_selection_keeps_only_its_count_and_counts_only_what_it_keeps() {
        let mut newest = Selection::new(Select::Newest { count: 3 });
        for offset in 0..1_000 {
            newest.offer(record(0, offset, Some(offset), "xxxx"));
        }
        assert_eq!(newest.len(), 3);
        assert_eq!(newest.bytes(), 12, "the dropped records' bytes are not held");
        let kept: Vec<i64> = newest.take().iter().map(|r| r.offset).collect();
        assert_eq!(kept, vec![997, 998, 999], "the newest, oldest first");

        let mut oldest = Selection::new(Select::Oldest { count: 2 });
        for offset in (0..10).rev() {
            oldest.offer(record(1, offset, Some(offset * 10), "x"));
        }
        assert_eq!(oldest.take().iter().map(|r| r.offset).collect::<Vec<_>>(), vec![0, 1]);
    }

    #[test]
    fn a_record_with_no_timestamp_is_the_least_wanted_either_way() {
        let mut newest = Selection::new(Select::Newest { count: 2 });
        let mut oldest = Selection::new(Select::Oldest { count: 2 });
        for (offset, at) in [(0, None), (1, Some(10)), (2, Some(20)), (3, None), (4, Some(30))] {
            newest.offer(record(0, offset, at, "x"));
            oldest.offer(record(0, offset, at, "x"));
        }
        assert_eq!(newest.take().iter().map(|r| r.offset).collect::<Vec<_>>(), vec![2, 4]);
        assert_eq!(oldest.take().iter().map(|r| r.offset).collect::<Vec<_>>(), vec![1, 2]);
    }

    #[test]
    fn an_empty_partition_list_is_refused() {
        let mut empty = window(Start::Earliest);
        empty.partitions = Some(vec![]);
        assert!(check(&empty).is_err());
    }

    #[test]
    fn a_long_filter_is_refused() {
        let mut long = window(Start::Earliest);
        long.filter.contains = Some("x".repeat(MAX_FILTER_CHARS + 1));
        assert!(check(&long).is_err());
    }
}
