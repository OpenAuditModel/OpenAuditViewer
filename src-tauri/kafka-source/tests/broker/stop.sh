#!/usr/bin/env bash
docker rm -f "${OAV_KAFKA_CONTAINER:-oav-kafka}" >/dev/null 2>&1 || true
