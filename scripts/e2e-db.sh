#!/usr/bin/env bash
#
# Throwaway PostgreSQL for the Playwright end-to-end suite (and for the
# DB-gated vitest file, which reads the same TEST_DATABASE_URL).
#
# Deliberately NOT the dev database: e2e/global-setup.ts truncates every
# application table on every run. Port 55432 keeps it clear of a local 5432.
#
#   bash scripts/e2e-db.sh up      # start + wait for readiness
#   bash scripts/e2e-db.sh down    # stop + remove (data is not kept)
#   bash scripts/e2e-db.sh status  # is it running?
set -euo pipefail

CONTAINER=churnlens-e2e-pg
IMAGE=postgres:16-alpine
HOST_PORT=55432
DB_NAME=churnlens_test
DB_PASSWORD=pw
TEST_DATABASE_URL="postgresql://postgres:${DB_PASSWORD}@127.0.0.1:${HOST_PORT}/${DB_NAME}"

usage() {
  echo "usage: $0 {up|down|status}" >&2
  exit 2
}

container_exists() {
  docker ps -a --filter "name=^/${CONTAINER}$" --format '{{.Names}}' | grep -q "^${CONTAINER}$"
}

container_running() {
  docker ps --filter "name=^/${CONTAINER}$" --format '{{.Names}}' | grep -q "^${CONTAINER}$"
}

up() {
  if container_running; then
    echo "[e2e-db] ${CONTAINER} already running."
  else
    if container_exists; then
      # Recreate rather than `docker start`: a container left behind by a
      # failed `docker run` (say, the host port was briefly held by a socket
      # in TIME_WAIT) starts happily WITHOUT its port publishing, and then
      # pg_isready inside the container reports a healthy database that
      # nothing on the host can reach. The data is throwaway either way.
      echo "[e2e-db] removing stopped ${CONTAINER} and recreating it…"
      docker rm -f "${CONTAINER}" >/dev/null
    fi
    echo "[e2e-db] creating ${CONTAINER} (${IMAGE}) on 127.0.0.1:${HOST_PORT}…"
    docker run -d \
      --name "${CONTAINER}" \
      -e POSTGRES_PASSWORD="${DB_PASSWORD}" \
      -e POSTGRES_DB="${DB_NAME}" \
      -p "127.0.0.1:${HOST_PORT}:5432" \
      "${IMAGE}" >/dev/null
  fi

  # pg_isready inside the container: the port is bound before Postgres finishes
  # its first-boot initdb, so "the port answers" is not "the database is up".
  echo -n "[e2e-db] waiting for postgres"
  for _ in $(seq 1 60); do
    # Both checks matter: pg_isready says the database finished initdb, and
    # the /dev/tcp probe says the published port actually reaches it from the
    # host, which is where the tests connect from.
    if docker exec "${CONTAINER}" pg_isready -U postgres -d "${DB_NAME}" >/dev/null 2>&1 &&
       (exec 3<>"/dev/tcp/127.0.0.1/${HOST_PORT}") 2>/dev/null; then
      echo " — ready."
      echo
      echo "export TEST_DATABASE_URL='${TEST_DATABASE_URL}'"
      return 0
    fi
    echo -n "."
    sleep 1
  done
  echo
  echo "[e2e-db] postgres did not become ready in 60s. Logs:" >&2
  docker logs --tail 30 "${CONTAINER}" >&2
  exit 1
}

down() {
  if container_exists; then
    echo "[e2e-db] removing ${CONTAINER}…"
    docker rm -f "${CONTAINER}" >/dev/null
    echo "[e2e-db] gone."
  else
    echo "[e2e-db] ${CONTAINER} does not exist."
  fi
}

status() {
  if container_running; then
    docker ps --filter "name=^/${CONTAINER}$" --format 'table {{.Names}}\t{{.Status}}\t{{.Ports}}'
    echo
    echo "export TEST_DATABASE_URL='${TEST_DATABASE_URL}'"
  elif container_exists; then
    docker ps -a --filter "name=^/${CONTAINER}$" --format 'table {{.Names}}\t{{.Status}}'
  else
    echo "[e2e-db] ${CONTAINER} does not exist."
  fi
}

case "${1:-}" in
  up) up ;;
  down) down ;;
  status) status ;;
  *) usage ;;
esac
