#!/bin/bash
# Force MD5 password auth for all hosts — old JDBC drivers (Java 8-era) don't
# support SCRAM-SHA-256 (auth type 10), which is the postgres 14 default.
sed -i 's/scram-sha-256/md5/g' "$PGDATA/pg_hba.conf"
