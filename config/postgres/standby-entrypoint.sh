#!/bin/bash
# Entrypoint for the hot standby database.
#
# The stock postgres entrypoint runs initdb on an empty PGDATA, which would give
# us an unrelated empty cluster instead of a replica. So on first start we take a
# base backup from the primary instead, and on every later start we just run
# postgres against the data we already have.
#
# -R writes standby.signal and primary_conninfo, so the server comes up in
# standby mode and starts streaming. -Xs streams WAL during the backup, which
# keeps the primary from having to retain everything for us.
set -e

PGDATA=${PGDATA:-/var/lib/postgresql/data}
PRIMARY_HOST=${PRIMARY_HOST:-db-postgres}
PRIMARY_PORT=${PRIMARY_PORT:-5432}
REPL_USER=${REPL_USER:-replicator}
export PGPASSWORD=${REPL_PASSWORD:-replicator}

if [ ! -s "$PGDATA/PG_VERSION" ]; then
  echo "standby: PGDATA is empty, taking a base backup from $PRIMARY_HOST"

  until pg_isready -h "$PRIMARY_HOST" -p "$PRIMARY_PORT" -U "$REPL_USER" >/dev/null 2>&1; do
    echo "standby: waiting for the primary to accept connections..."
    sleep 3
  done

  rm -rf "${PGDATA:?}"/*
  pg_basebackup \
    --host="$PRIMARY_HOST" \
    --port="$PRIMARY_PORT" \
    --username="$REPL_USER" \
    --pgdata="$PGDATA" \
    --format=plain \
    --wal-method=stream \
    --write-recovery-conf \
    --checkpoint=fast \
    --progress \
    --verbose

  # hot_standby allows read-only queries while replaying, which is what lets the
  # Administrator Portal read replication state straight off the standby.
  echo "hot_standby = on" >> "$PGDATA/postgresql.auto.conf"
  chmod 0700 "$PGDATA"
  echo "standby: base backup complete"
else
  echo "standby: existing PGDATA found, starting in place"
fi

exec postgres
