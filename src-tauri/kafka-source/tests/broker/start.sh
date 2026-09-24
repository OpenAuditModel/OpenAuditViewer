#!/usr/bin/env bash
# Starts the broker the Kafka source's integration tests run against, and
# prints the environment they read. Needs Docker and openssl.
#
#   eval "$(src-tauri/kafka-source/tests/broker/start.sh)"
#   cargo test --manifest-path src-tauri/Cargo.toml -p oav-kafka
#   src-tauri/kafka-source/tests/broker/stop.sh
#
# The certificates are made fresh on every start, for localhost only, by a CA
# that exists for the length of one test run.
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
name="${OAV_KAFKA_CONTAINER:-oav-kafka}"
image="${OAV_KAFKA_IMAGE:-apache/kafka:4.1.0}"
certs="$(mktemp -d)"
# mktemp makes the folder 0700 for the runner's user; the broker runs as
# another user inside the container and must be able to enter it.
chmod 0755 "$certs"

openssl req -x509 -newkey rsa:2048 -nodes -days 2 -subj "/CN=oav-test-ca" \
  -keyout "$certs/ca.key" -out "$certs/ca.pem" >/dev/null 2>&1
cat >"$certs/server.ext" <<EXT
subjectAltName=DNS:localhost,IP:127.0.0.1
extendedKeyUsage=serverAuth
EXT
openssl req -newkey rsa:2048 -nodes -subj "/CN=localhost" \
  -keyout "$certs/server.key" -out "$certs/server.csr" >/dev/null 2>&1
openssl x509 -req -in "$certs/server.csr" -CA "$certs/ca.pem" -CAkey "$certs/ca.key" \
  -CAcreateserial -days 2 -extfile "$certs/server.ext" -out "$certs/server.crt" >/dev/null 2>&1
openssl pkcs8 -topk8 -nocrypt -in "$certs/server.key" -out "$certs/server.pk8" >/dev/null 2>&1
cat "$certs/server.pk8" "$certs/server.crt" "$certs/ca.pem" >"$certs/server.pem"
chmod 0644 "$certs"/*

docker rm -f "$name" >/dev/null 2>&1 || true
# Published on the loopback only, and on both of its addresses: "localhost"
# resolves to ::1 first on Linux and macOS, and a client that finds nothing
# there reports the refusal before it tries 127.0.0.1.
docker run -d --name "$name" \
  -p 127.0.0.1:9092:9092 -p "[::1]:9092:9092" \
  -p 127.0.0.1:9094:9094 -p "[::1]:9094:9094" \
  -v "$here/server.properties:/config/server.properties:ro" \
  -v "$certs:/certs:ro" \
  --entrypoint /bin/bash "$image" -c '
    set -e
    /opt/kafka/bin/kafka-storage.sh format --standalone -t "$(/opt/kafka/bin/kafka-storage.sh random-uuid)" \
      -c /config/server.properties \
      --add-scram "SCRAM-SHA-256=[name=reader,password=reader-secret]" \
      --add-scram "SCRAM-SHA-512=[name=reader,password=reader-secret]" >/dev/null
    exec /opt/kafka/bin/kafka-server-start.sh /config/server.properties
  ' >/dev/null

for _ in $(seq 1 60); do
  if docker exec "$name" /opt/kafka/bin/kafka-topics.sh --bootstrap-server localhost:9092 --list >/dev/null 2>&1; then
    echo "export OAV_KAFKA_PLAINTEXT=localhost:9092"
    echo "export OAV_KAFKA_SASL_TLS=localhost:9094"
    echo "export OAV_KAFKA_CA=$certs/ca.pem"
    echo "export OAV_KAFKA_USER=reader"
    echo "export OAV_KAFKA_PASSWORD=reader-secret"
    exit 0
  fi
  sleep 2
done
echo "the broker did not start; docker logs $name follows" >&2
docker logs "$name" >&2
exit 1
