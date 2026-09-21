# NEC XON (c) Copyright 2025.
#
# Backup engine for a single-server deployment.
#
# Based on postgres:14-alpine deliberately: pg_dump must be at least as new as
# the server it dumps, and health-db-postgres is PostgreSQL 14 (postgis/postgis:14-3.2).
# Pinning the major version here means the dumps this container writes can always
# be restored by the pg_restore in this same image.
#
# mongodb-tools supplies mongodump/mongorestore for the OpenHIM database. It is
# needed here rather than using `docker exec openhim-mongo mongodump`, because
# this container deliberately has no access to the Docker socket - a backup
# process that can drive the Docker daemon is a backup process that can delete
# the thing it is backing up.
FROM postgres:14-alpine

RUN apk add --no-cache bash mongodb-tools tzdata coreutils

COPY backup.sh restore.sh verify.sh entrypoint.sh /usr/local/bin/
RUN chmod +x /usr/local/bin/backup.sh /usr/local/bin/restore.sh \
             /usr/local/bin/verify.sh /usr/local/bin/entrypoint.sh

ENV BACKUP_DIR=/backups
ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
