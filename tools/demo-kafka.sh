#!/usr/bin/env bash
# Puts the demo audit logs on a Kafka topic, to try "Read from Kafka…" with.
#
#   npm run demo-logs
#   eval "$(src-tauri/kafka-source/tests/broker/start.sh)"
#   tools/demo-kafka.sh
#   tools/demo-kafka.sh --trickle   # then one event a second, to listen to
#
# The topic is audit.demo, three partitions, on the broker start.sh runs. In
# the app, save a source with bootstrap server localhost:9092 and no TLS, or
# localhost:9094 with TLS and SASL (user reader, password reader-secret) and
# the CA file whose path start.sh printed as OAV_KAFKA_CA.
set -euo pipefail

name="${OAV_KAFKA_CONTAINER:-oav-kafka}"
trickle=false
if [ "${1:-}" = "--trickle" ]; then
  trickle=true
  shift
fi
topic="${1:-audit.demo}"
root="$(cd "$(dirname "$0")/.." && pwd)"

if ! ls "$root"/demo-logs/*.jsonl >/dev/null 2>&1; then
  echo "no demo logs: run npm run demo-logs first" >&2
  exit 1
fi

# One demo event a second, round and round, until interrupted: something for
# "Keep listening" to hear. The topic is not replaced.
if [ "$trickle" = true ]; then
  echo "writing one event a second to $topic; Ctrl-C stops" >&2
  while true; do
    for file in "$root"/demo-logs/*.jsonl; do
      while IFS= read -r line; do
        printf '%s\n' "$line"
        sleep 1
      done <"$file"
    done
  done | docker exec -i "$name" /opt/kafka/bin/kafka-console-producer.sh \
    --bootstrap-server localhost:9092 --topic "$topic" \
    --producer-property partitioner.class=org.apache.kafka.clients.producer.RoundRobinPartitioner \
    --producer-property linger.ms=0 >/dev/null
  exit 0
fi

# Replaced on every run, so that reading it twice does not show every event twice.
docker exec "$name" /opt/kafka/bin/kafka-topics.sh --bootstrap-server localhost:9092 \
  --delete --if-exists --topic "$topic" >/dev/null 2>&1 || true
sleep 1
docker exec "$name" /opt/kafka/bin/kafka-topics.sh --bootstrap-server localhost:9092 \
  --create --topic "$topic" --partitions 3 --replication-factor 1 >/dev/null
# Round-robin, so the demo chains are spread across partitions the way a
# producer keyed by anything but the chain spreads them: reading the newest
# records of each partition then leaves holes, which the app shows as links
# it did not check.
cat "$root"/demo-logs/*.jsonl | docker exec -i "$name" /opt/kafka/bin/kafka-console-producer.sh \
  --bootstrap-server localhost:9092 --topic "$topic" \
  --producer-property partitioner.class=org.apache.kafka.clients.producer.RoundRobinPartitioner \
  >/dev/null
count=$(cat "$root"/demo-logs/*.jsonl | wc -l | tr -d ' ')
echo "wrote $count events to $topic"
