//! The Kafka source against a real broker.
//!
//! Run with the broker `tests/broker/start.sh` starts; every test here returns
//! early, and says so, when the environment it prints is absent, so `cargo
//! test` stays green on a machine without Docker. CI runs them with it.
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{mpsc, Arc};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use futures::executor::block_on;
use oav_kafka::{
    fetch, Connection, End, Event, FetchError, Filter, PartitionOffset, Record, Sasl,
    SaslMechanism, Security, Select, Start, StopReason, Window, GROUP_ID,
};
use rdkafka::admin::{AdminClient, AdminOptions, NewTopic, TopicReplication};
use rdkafka::client::DefaultClientContext;
use rdkafka::config::ClientConfig;
use rdkafka::consumer::{BaseConsumer, Consumer};
use rdkafka::producer::{BaseProducer, BaseRecord, Producer};

fn env(name: &str) -> Option<String> {
    std::env::var(name).ok().filter(|value| !value.is_empty())
}

fn plaintext_broker() -> Option<String> {
    let broker = env("OAV_KAFKA_PLAINTEXT");
    if broker.is_none() {
        eprintln!("skipped: OAV_KAFKA_PLAINTEXT is not set (see tests/broker/start.sh)");
    }
    broker
}

fn plaintext(broker: &str) -> Connection {
    Connection {
        bootstrap_servers: vec![broker.to_owned()],
        security: Security::Plaintext,
        sasl: None,
        ca_pem: None,
    }
}

fn unique(prefix: &str) -> String {
    let nanos = SystemTime::now().duration_since(UNIX_EPOCH).expect("clock").as_nanos();
    format!("{prefix}-{nanos}")
}

fn create_topic(broker: &str, topic: &str, partitions: i32) {
    let admin: AdminClient<DefaultClientContext> = ClientConfig::new()
        .set("bootstrap.servers", broker)
        .create()
        .expect("admin client");
    let results = block_on(admin.create_topics(
        &[NewTopic::new(topic, partitions, TopicReplication::Fixed(1))],
        &AdminOptions::new().operation_timeout(Some(Duration::from_secs(10))),
    ))
    .expect("create topics");
    for result in results {
        result.expect("topic created");
    }
}

/// Writes `count` events round-robin across `partitions`, with the given
/// timestamps when there are any.
fn produce(broker: &str, topic: &str, partitions: i32, count: usize, timestamps: Option<&[i64]>) {
    let producer: BaseProducer = ClientConfig::new()
        .set("bootstrap.servers", broker)
        .create()
        .expect("producer");
    for index in 0..count {
        let payload = format!(
            r#"{{"specVersion":"1.0","id":"018f1b70-2c18-7f3a-b46d-{index:012}","time":"2026-09-24T10:00:00.000Z","event":{{"name":"data.record.update","category":"data-modification","outcome":"success"}},"actor":{{"type":"user","id":"user-1"}},"resource":{{"type":"record","id":"record-{index}"}},"application":{{"name":"kafka-test","environment":"test"}}}}"#
        );
        let mut record = BaseRecord::<(), String>::to(topic)
            .payload(&payload)
            .partition(index as i32 % partitions);
        if let Some(timestamps) = timestamps {
            record = record.timestamp(timestamps[index]);
        }
        producer.send(record).expect("queued");
    }
    producer.flush(Duration::from_secs(10)).expect("flushed");
}

fn window(topic: &str, start: Start, max_events: usize) -> Window {
    Window {
        topic: topic.to_owned(),
        partitions: None,
        start,
        end: End::Now,
        select: Select::All,
        filter: Filter::default(),
        max_events,
        follow: false,
        window_deadline: Duration::from_secs(60),
        deadline: Duration::from_secs(60),
        stall: Duration::from_secs(20),
    }
}

fn read(connection: &Connection, window: &Window) -> (Vec<Record>, oav_kafka::FetchReport) {
    let mut records = Vec::new();
    let report = fetch(connection, window, &AtomicBool::new(false), |event| {
        if let Event::Records(batch) = event {
            records.extend(batch);
        }
    })
    .expect("fetched");
    (records, report)
}

#[test]
fn reads_every_record_from_the_earliest_offset_and_says_the_window_ended() {
    let Some(broker) = plaintext_broker() else { return };
    let topic = unique("oav-earliest");
    create_topic(&broker, &topic, 3);
    produce(&broker, &topic, 3, 30, None);

    let (records, report) = read(&plaintext(&broker), &window(&topic, Start::Earliest, 1000));
    assert_eq!(records.len(), 30);
    assert_eq!(report.records, 30);
    assert_eq!(report.stop, StopReason::EndOfWindow);
    assert_eq!(report.partitions.len(), 3);
    for partition in &report.partitions {
        assert!(partition.complete, "partition {} complete", partition.partition);
        assert_eq!(partition.records, 10);
        assert_eq!((partition.start_offset, partition.end_offset), (0, 10));
    }
    assert!(records.iter().all(|record| record.payload.as_deref().is_some_and(|p| p.contains("\"specVersion\":\"1.0\""))));
    assert!(records.iter().all(|record| record.timestamp_millis.is_some()));
}

#[test]
fn latest_reads_that_many_from_the_end_of_each_partition() {
    let Some(broker) = plaintext_broker() else { return };
    let topic = unique("oav-latest");
    create_topic(&broker, &topic, 3);
    produce(&broker, &topic, 3, 30, None);

    let (records, report) = read(&plaintext(&broker), &window(&topic, Start::Latest { count: 2 }, 1000));
    assert_eq!(records.len(), 6);
    assert_eq!(report.stop, StopReason::EndOfWindow);
    for record in &records {
        assert!(record.offset >= 8, "offset {}", record.offset);
    }
}

#[test]
fn an_offset_start_is_moved_into_the_range_each_partition_holds() {
    let Some(broker) = plaintext_broker() else { return };
    let topic = unique("oav-offset");
    create_topic(&broker, &topic, 2);
    produce(&broker, &topic, 2, 20, None);

    let (records, _) = read(&plaintext(&broker), &window(&topic, Start::Offset { offset: 7 }, 1000));
    assert_eq!(records.len(), 6, "offsets 7, 8, 9 of two partitions");
    let (records, report) = read(&plaintext(&broker), &window(&topic, Start::Offset { offset: 500 }, 1000));
    assert!(records.is_empty());
    assert_eq!(report.stop, StopReason::EndOfWindow);
}

#[test]
fn a_timestamp_start_reads_from_the_first_record_at_or_after_it() {
    let Some(broker) = plaintext_broker() else { return };
    let topic = unique("oav-timestamp");
    create_topic(&broker, &topic, 1);
    let base = 1_790_000_000_000i64;
    let stamps: Vec<i64> = (0..10).map(|index| base + index * 1000).collect();
    produce(&broker, &topic, 1, 10, Some(&stamps));

    let (records, _) = read(
        &plaintext(&broker),
        &window(&topic, Start::Timestamp { millis: base + 6_500 }, 1000),
    );
    assert_eq!(records.iter().map(|r| r.offset).collect::<Vec<_>>(), vec![7, 8, 9]);
    assert_eq!(records[0].timestamp_millis, Some(base + 7_000));

    let (records, _) = read(
        &plaintext(&broker),
        &window(&topic, Start::Timestamp { millis: base + 60_000 }, 1000),
    );
    assert!(records.is_empty(), "nothing at or after that time");
}

#[test]
fn the_event_limit_ends_a_window_and_is_named_as_the_reason() {
    let Some(broker) = plaintext_broker() else { return };
    let topic = unique("oav-limit");
    create_topic(&broker, &topic, 1);
    produce(&broker, &topic, 1, 25, None);

    let (records, report) = read(&plaintext(&broker), &window(&topic, Start::Earliest, 10));
    assert_eq!(records.len(), 10);
    assert_eq!(report.stop, StopReason::EventLimit);
    assert!(!report.partitions[0].complete);
}

#[test]
fn a_record_that_cannot_be_an_event_is_returned_with_the_reason() {
    let Some(broker) = plaintext_broker() else { return };
    let topic = unique("oav-problems");
    create_topic(&broker, &topic, 1);
    let producer: BaseProducer = ClientConfig::new()
        .set("bootstrap.servers", &broker)
        .create()
        .expect("producer");
    producer.send(BaseRecord::<str, [u8]>::to(&topic).key("k").payload(&[0xff, 0xfe, 0x00][..])).expect("queued");
    producer.send(BaseRecord::<str, [u8]>::to(&topic).key("k")).expect("queued");
    producer.send(BaseRecord::<(), str>::to(&topic).payload("not json at all")).expect("queued");
    producer.flush(Duration::from_secs(10)).expect("flushed");

    let (records, _) = read(&plaintext(&broker), &window(&topic, Start::Earliest, 100));
    assert_eq!(records.len(), 3);
    assert_eq!(records[0].payload, None);
    assert!(records[0].problem.as_deref().is_some_and(|p| p.contains("not UTF-8")));
    assert!(records[1].problem.as_deref().is_some_and(|p| p.contains("tombstone")));
    // Text that is not an event is still text: whether it is an event is the
    // viewer's question.
    assert_eq!(records[2].payload.as_deref(), Some("not json at all"));
}

#[test]
fn asking_for_a_topic_that_does_not_exist_does_not_create_it() {
    let Some(broker) = plaintext_broker() else { return };
    let topic = unique("oav-absent");
    let error = fetch(
        &plaintext(&broker),
        &window(&topic, Start::Earliest, 10),
        &AtomicBool::new(false),
        |_| {},
    )
    .expect_err("no such topic");
    assert!(matches!(error, FetchError::TopicMissing(_)), "{error:?}");

    let consumer: BaseConsumer = ClientConfig::new()
        .set("bootstrap.servers", &broker)
        .set("allow.auto.create.topics", "false")
        .create()
        .expect("consumer");
    let metadata = consumer.fetch_metadata(None, Duration::from_secs(10)).expect("metadata");
    assert!(metadata.topics().iter().all(|described| described.name() != topic), "the topic was created");
}

#[test]
fn a_partition_the_topic_does_not_have_is_named() {
    let Some(broker) = plaintext_broker() else { return };
    let topic = unique("oav-partitions");
    create_topic(&broker, &topic, 2);
    let mut asked = window(&topic, Start::Earliest, 10);
    asked.partitions = Some(vec![0, 5]);
    let error = fetch(&plaintext(&broker), &asked, &AtomicBool::new(false), |_| {}).expect_err("no partition 5");
    assert!(matches!(error, FetchError::PartitionMissing(_)), "{error:?}");
}

#[test]
fn a_cancelled_read_stops_and_says_so() {
    let Some(broker) = plaintext_broker() else { return };
    let topic = unique("oav-cancel");
    create_topic(&broker, &topic, 1);
    produce(&broker, &topic, 1, 5, None);
    let report = fetch(
        &plaintext(&broker),
        &window(&topic, Start::Earliest, 10),
        &AtomicBool::new(true),
        |_| {},
    )
    .expect("fetched");
    assert_eq!(report.stop, StopReason::Cancelled);
}

#[test]
fn reading_leaves_no_consumer_group_on_the_broker() {
    let Some(broker) = plaintext_broker() else { return };
    let topic = unique("oav-nogroup");
    create_topic(&broker, &topic, 2);
    produce(&broker, &topic, 2, 10, None);

    let consumer: BaseConsumer = ClientConfig::new()
        .set("bootstrap.servers", &broker)
        .create()
        .expect("consumer");
    let groups = |consumer: &BaseConsumer| -> Vec<String> {
        let list = consumer.fetch_group_list(None, Duration::from_secs(10)).expect("group list");
        let mut names: Vec<String> = list.groups().iter().map(|group| group.name().to_owned()).collect();
        names.sort();
        names
    };
    let before = groups(&consumer);
    for start in [Start::Earliest, Start::Latest { count: 3 }, Start::Offset { offset: 2 }] {
        read(&plaintext(&broker), &window(&topic, start, 100));
    }
    let after = groups(&consumer);
    assert_eq!(before, after, "reading added a consumer group");
    assert!(!after.iter().any(|name| name == GROUP_ID));
}

// --- SASL over TLS ------------------------------------------------------------

fn sasl_tls(mechanism: SaslMechanism, password: &str, ca_pem: Option<String>) -> Option<Connection> {
    let broker = env("OAV_KAFKA_SASL_TLS")?;
    Some(Connection {
        bootstrap_servers: vec![broker],
        security: Security::SaslTls,
        sasl: Some(Sasl {
            mechanism,
            username: env("OAV_KAFKA_USER")?,
            password: password.to_owned(),
        }),
        ca_pem,
    })
}

fn test_ca() -> Option<String> {
    let path = env("OAV_KAFKA_CA");
    if path.is_none() {
        eprintln!("skipped: OAV_KAFKA_CA is not set (see tests/broker/start.sh)");
    }
    std::fs::read_to_string(path?).ok()
}

#[test]
fn every_sasl_mechanism_reads_over_tls_with_the_broker_ca() {
    let (Some(broker), Some(ca), Some(password)) =
        (plaintext_broker(), test_ca(), env("OAV_KAFKA_PASSWORD"))
    else {
        return;
    };
    let topic = unique("oav-sasl");
    create_topic(&broker, &topic, 1);
    produce(&broker, &topic, 1, 4, None);

    for mechanism in [SaslMechanism::Plain, SaslMechanism::ScramSha256, SaslMechanism::ScramSha512] {
        let connection = sasl_tls(mechanism, &password, Some(ca.clone())).expect("configured");
        let (records, report) = read(&connection, &window(&topic, Start::Earliest, 100));
        assert_eq!(records.len(), 4, "{mechanism:?}");
        assert_eq!(report.stop, StopReason::EndOfWindow, "{mechanism:?}");
    }
}

#[test]
fn a_wrong_password_is_named_as_an_authentication_failure() {
    let (Some(broker), Some(ca)) = (plaintext_broker(), test_ca()) else { return };
    let topic = unique("oav-badpass");
    create_topic(&broker, &topic, 1);
    let connection = sasl_tls(SaslMechanism::ScramSha256, "not-the-password", Some(ca)).expect("configured");
    let error = fetch(&connection, &window(&topic, Start::Earliest, 10), &AtomicBool::new(false), |_| {})
        .expect_err("refused");
    assert!(matches!(error, FetchError::Authentication(_)), "{error:?}");
    assert!(!error.to_string().contains("not-the-password"), "{error}");
}

#[test]
fn a_broker_whose_certificate_is_not_trusted_is_not_read() {
    let (Some(broker), Some(_), Some(password)) =
        (plaintext_broker(), test_ca(), env("OAV_KAFKA_PASSWORD"))
    else {
        return;
    };
    let topic = unique("oav-untrusted");
    create_topic(&broker, &topic, 1);
    // The public roots, not the test CA: the handshake must fail.
    let connection = sasl_tls(SaslMechanism::ScramSha256, &password, None).expect("configured");
    let error = fetch(&connection, &window(&topic, Start::Earliest, 10), &AtomicBool::new(false), |_| {})
        .expect_err("refused");
    assert!(matches!(error, FetchError::Unreachable(_)), "{error:?}");
    assert!(error.to_string().to_ascii_lowercase().contains("certificate"), "{error}");
}

#[test]
fn a_ca_bundle_of_many_certificates_is_read_whole() {
    let (Some(broker), Some(ca), Some(password)) =
        (plaintext_broker(), test_ca(), env("OAV_KAFKA_PASSWORD"))
    else {
        return;
    };
    let topic = unique("oav-bundle");
    create_topic(&broker, &topic, 1);
    produce(&broker, &topic, 1, 2, None);
    // The test CA last, behind every public root: a reader that took only the
    // first certificate of a bundle would refuse the broker.
    let bundle = format!("{}{}", public_roots(), ca);
    let connection = sasl_tls(SaslMechanism::ScramSha512, &password, Some(bundle)).expect("configured");
    let (records, _) = read(&connection, &window(&topic, Start::Earliest, 10));
    assert_eq!(records.len(), 2);
}

fn public_roots() -> String {
    let connection = Connection {
        bootstrap_servers: vec!["localhost:1".into()],
        security: Security::Tls,
        sasl: None,
        ca_pem: None,
    };
    connection
        .client_config()
        .expect("config")
        .get("ssl.ca.pem")
        .expect("roots")
        .to_owned()
}

// --- Ranges, selections, filters and following ---------------------------------

/// Thirty events, round-robin across three partitions, one second apart: the
/// n-th is at `base + n` seconds and says so in its resource id.
fn thirty_timed(broker: &str, topic: &str) -> i64 {
    create_topic(broker, topic, 3);
    let base = 1_790_000_000_000i64;
    let stamps: Vec<i64> = (0..30).map(|index| base + index * 1000).collect();
    produce(broker, topic, 3, 30, Some(&stamps));
    base
}

/// Which of `thirty_timed`'s events these are, by the index in their payload.
fn indices(records: &[Record]) -> Vec<usize> {
    let mut found: Vec<usize> = records
        .iter()
        .map(|record| {
            let payload = record.payload.as_deref().expect("payload");
            let at = payload.find("\"record-").expect("resource id") + 8;
            payload[at..].split('"').next().expect("index").parse().expect("number")
        })
        .collect();
    found.sort_unstable();
    found
}

#[test]
fn the_newest_records_are_the_newest_across_every_partition() {
    let Some(broker) = plaintext_broker() else { return };
    let topic = unique("oav-newest");
    thirty_timed(&broker, &topic);
    let mut newest = window(&topic, Start::Latest { count: 5 }, 5);
    newest.select = Select::Newest { count: 5 };
    let (records, report) = read(&plaintext(&broker), &newest);
    assert_eq!(indices(&records), vec![25, 26, 27, 28, 29]);
    assert_eq!(report.records, 5);
    assert_eq!(report.stop, StopReason::EndOfWindow);
    assert!(report.caught_up);
}

#[test]
fn the_oldest_records_are_the_oldest_across_every_partition() {
    let Some(broker) = plaintext_broker() else { return };
    let topic = unique("oav-oldest");
    thirty_timed(&broker, &topic);
    let mut oldest = window(&topic, Start::Earliest, 4);
    oldest.select = Select::Oldest { count: 4 };
    let (records, report) = read(&plaintext(&broker), &oldest);
    assert_eq!(indices(&records), vec![0, 1, 2, 3]);
    // Each partition gave at most four before it was set aside.
    assert!(report.scanned <= 12, "scanned {}", report.scanned);
}

#[test]
fn a_window_can_end_at_a_time_or_at_an_offset() {
    let Some(broker) = plaintext_broker() else { return };
    let topic = unique("oav-end");
    let base = thirty_timed(&broker, &topic);

    let mut until_time = window(&topic, Start::Earliest, 100);
    until_time.end = End::Timestamp { millis: base + 5_000 };
    let (records, _) = read(&plaintext(&broker), &until_time);
    assert_eq!(indices(&records), vec![0, 1, 2, 3, 4], "before the time, not at it");

    let mut until_offset = window(&topic, Start::Offset { offset: 2 }, 100);
    until_offset.end = End::Offset { offset: 4 };
    until_offset.partitions = Some(vec![0]);
    let (records, report) = read(&plaintext(&broker), &until_offset);
    assert_eq!(records.iter().map(|r| r.offset).collect::<Vec<_>>(), vec![2, 3, 4], "the end offset is included");
    assert_eq!(report.partitions[0].end_offset, 5);
}

#[test]
fn each_partition_can_start_at_its_own_offset() {
    let Some(broker) = plaintext_broker() else { return };
    let topic = unique("oav-offsets");
    thirty_timed(&broker, &topic);
    let offsets = window(
        &topic,
        Start::Offsets {
            offsets: vec![
                PartitionOffset { partition: 0, offset: 8 },
                PartitionOffset { partition: 2, offset: 5 },
            ],
        },
        100,
    );
    let (records, report) = read(&plaintext(&broker), &offsets);
    assert_eq!(report.partitions.iter().map(|p| p.partition).collect::<Vec<_>>(), vec![0, 2]);
    let mut seen: Vec<(i32, i64)> = records.iter().map(|r| (r.partition, r.offset)).collect();
    seen.sort_unstable();
    assert_eq!(seen, vec![(0, 8), (0, 9), (2, 5), (2, 6), (2, 7), (2, 8), (2, 9)]);
}

#[test]
fn a_filter_keeps_the_matching_records_and_counts_every_one_read() {
    let Some(broker) = plaintext_broker() else { return };
    let topic = unique("oav-filter");
    create_topic(&broker, &topic, 2);
    let producer: BaseProducer = ClientConfig::new()
        .set("bootstrap.servers", &broker)
        .create()
        .expect("producer");
    for (index, (name, application)) in [
        ("auth.login.success", "identity"),
        ("auth.login.failure", "identity"),
        ("data.record.update", "billing"),
        ("auth.session.revoke", "billing"),
        ("data.record.delete", "identity"),
    ]
    .iter()
    .enumerate()
    {
        let payload = format!(
            r#"{{"event":{{"name":"{name}"}},"application":{{"name":"{application}"}},"resource":{{"id":"record-{index}"}}}}"#
        );
        producer
            .send(BaseRecord::<(), String>::to(&topic).payload(&payload).partition(index as i32 % 2))
            .expect("queued");
    }
    producer.flush(Duration::from_secs(10)).expect("flushed");

    let mut auth = window(&topic, Start::Earliest, 100);
    auth.filter.event_name_prefix = Some("auth.".into());
    let (records, report) = read(&plaintext(&broker), &auth);
    assert_eq!(indices(&records), vec![0, 1, 3]);
    assert_eq!((report.scanned, report.records), (5, 3));

    let mut identity_failures = window(&topic, Start::Earliest, 100);
    identity_failures.filter.application = Some("identity".into());
    identity_failures.filter.contains = Some("FAILURE".into());
    let (records, _) = read(&plaintext(&broker), &identity_failures);
    assert_eq!(indices(&records), vec![1]);
}

#[test]
fn following_hands_back_the_window_then_what_arrives() {
    let Some(broker) = plaintext_broker() else { return };
    let topic = unique("oav-follow");
    create_topic(&broker, &topic, 2);
    produce(&broker, &topic, 2, 3, None);

    let mut follow = window(&topic, Start::Earliest, 1000);
    follow.follow = true;
    follow.deadline = Duration::from_secs(60);

    let cancel = Arc::new(AtomicBool::new(false));
    let (caught_up_sender, caught_up) = mpsc::channel::<()>();
    let producer_broker = broker.clone();
    let producer_topic = topic.clone();
    let writer = std::thread::spawn(move || {
        caught_up.recv_timeout(Duration::from_secs(30)).expect("the window was read");
        produce(&producer_broker, &producer_topic, 2, 4, None);
    });

    let mut before = 0usize;
    let mut after = 0usize;
    let mut seen_caught_up = false;
    let stop = Arc::clone(&cancel);
    let report = fetch(&plaintext(&broker), &follow, &cancel, |event| match event {
        Event::Records(batch) => {
            if seen_caught_up {
                after += batch.len();
            } else {
                before += batch.len();
            }
            if after >= 4 {
                stop.store(true, Ordering::Relaxed);
            }
        }
        Event::CaughtUp { .. } => {
            seen_caught_up = true;
            let _ = caught_up_sender.send(());
        }
        Event::Progress { .. } => {}
    })
    .expect("followed");
    writer.join().expect("writer");

    assert_eq!((before, after), (3, 4));
    assert!(report.caught_up);
    assert_eq!(report.followed, 4);
    assert_eq!(report.records, 7);
    assert_eq!(report.stop, StopReason::Cancelled);
}

#[test]
fn following_leaves_no_consumer_group_either() {
    let Some(broker) = plaintext_broker() else { return };
    let topic = unique("oav-follow-nogroup");
    create_topic(&broker, &topic, 1);
    produce(&broker, &topic, 1, 2, None);
    let mut follow = window(&topic, Start::Latest { count: 1 }, 10);
    follow.select = Select::Newest { count: 1 };
    follow.follow = true;
    let cancel = AtomicBool::new(false);
    let report = fetch(&plaintext(&broker), &follow, &cancel, |event| {
        if matches!(event, Event::CaughtUp { .. }) {
            cancel.store(true, Ordering::Relaxed);
        }
    })
    .expect("followed");
    assert_eq!(report.records, 1);

    let consumer: BaseConsumer = ClientConfig::new()
        .set("bootstrap.servers", &broker)
        .create()
        .expect("consumer");
    let groups = consumer.fetch_group_list(None, Duration::from_secs(10)).expect("group list");
    assert!(groups.groups().iter().all(|group| group.name() != GROUP_ID));
}
