# Backup and restore

This deployment runs on a single server. Everything on the `Backends & Failover`
page - the two FHIR nodes, the two OpenSRP nodes, the streaming database standby
- protects against a container dying. None of it protects against losing the
machine.

On one server the backup is not a precaution alongside the high-availability
setup. It is the entire disaster recovery plan. See `docs/high-availability.md`
for what the redundancy does and does not cover.

So backups run on a schedule rather than waiting to be remembered, the
Administrator Portal shows how old the newest one is, and there is a drill that
proves an archive really restores.

## At a glance

| | |
|---|---|
| Runs | 02:00 daily, and on demand from the portal |
| Archives | `./backups/vitallink-<timestamp>.tar.gz` on the server |
| Retention | newest 14, pruned only after a new archive is verified |
| Portal page | `Backup & Recovery` (`#/backup`) |
| Take one now | `make backup`, or the portal button |
| Restore | `bash scripts/restore.sh` - command line only, deliberately |
| Prove it works | `make backup-verify` |

## What is in an archive

| Source | Holds |
|---|---|
| `hapi_fhir` | Every patient, stock Observation, and the app configuration Binaries the phones download |
| `keycloak` | Every user account and credential |
| `opensrp` | The whole OpenSRP backend - 54 tables: clients, events, locations, structures, tasks, stock, plans, settings (`core`), practitioners, organizations and roles (`team`), plus its oauth tables |
| `dhis2` | Aggregate reporting data |
| `mediator` | Order buffer, dispatch history, stock on hand |
| `superset` | Analytics dashboards |
| `open_lmis` | Facilities, products, stock cards, requisitions |
| `openhim` | Channels, clients, transaction log (MongoDB) |
| config files | `docker-compose*.yml`, `config/`, `mediator/mappings.json`, `mediator/data/`, `.env` |

Two separate PostgreSQL servers are involved, which is easy to miss.
`health-db-postgres` holds the clinical and identity databases, while the real
OpenLMIS data lives in `open_lmis` on the OpenLMIS ref-distro database container
on a different Docker network. The `openlmis_*` databases that exist on
`health-db-postgres` are created by `config/initdb/02-create-databases.sql` and
are effectively empty; a backup that captures those instead of `open_lmis` has
captured no stock data at all.

### Databases are enumerated, not listed

`backup.sh` asks each server what databases it has and dumps all of them. It
does not work from a list in the script.

This is the lesson from the version it replaced. That one carried a hardcoded
list of seven databases and dumped them faithfully every time it ran - while
omitting `hapi_fhir` and `keycloak`, the two whose loss would end the
deployment, and reading the OpenLMIS databases off the wrong server. It reported
success every run. A restore from it would have come back with no patients, no
users and no stock.

Enumeration means adding a database cannot silently drop out of the backup.
`hapi_fhir` and `keycloak` are additionally checked by name, and a run that
cannot produce both fails rather than writing a reassuring archive.

## How it runs

The engine is `backup/backup.sh`, running in the `bkm-backup` container. The
schedule, the portal button and `make backup` all invoke that same script, so
there is one implementation rather than three that drift apart.

It has to run in a container because the databases sit on internal Docker
networks with no ports published to the host, and the two PostgreSQL servers are
on different networks. `bkm-backup` is attached to both.

The container has no published port and no access to the Docker socket. It holds
credentials for every database in the deployment, so the only ways in are the
two internal networks and the shared `./backups` directory. The portal requests
an on-demand run by writing a `.run-now` trigger file that the engine polls for -
the only thing the portal can ask it to do is "run".

### Configuration

In `docker-compose.yml`, under `bkm-backup`:

| Variable | Default | Meaning |
|---|---|---|
| `BACKUP_CRON` | `0 2 * * *` | Five-field cron expression, server local time |
| `BACKUP_KEEP` | `14` | Archives retained |
| `BACKUP_INCLUDE_CONFIG` | `true` | Include compose files, `config/`, mediator mappings |
| `BACKUP_INCLUDE_ENV` | `true` | Include `.env`, which holds credentials |
| `TZ` | `Africa/Maseru` | Makes `0 2 * * *` mean 02:00 locally |
| `BACKUP_STALE_HOURS` | `36` | On the mediator: when the portal calls a backup stale |

Old archives are pruned only after the new one has been written and read back,
so a failing backup can never delete the last good one.

## The portal page

`Backup & Recovery` in the sidebar, under the System section. It is
administrator-only: an archive downloaded from it contains every patient record
in the deployment.

The headline figure is the age of the newest archive, not whether the last run
reported success. A schedule that quietly stopped firing three weeks ago leaves
a status file that still says "ok", and the age is the only number that catches
that. Past 36 hours the page turns red.

The page also lists each archive with its size and contents, offers `Back up
now`, and provides a download link.

## Getting a copy off the server

An archive on the same disk as the database does not survive losing that disk,
which on a single-server installation is the failure that ends the deployment.
The archives protect against a bad deployment, a wrong delete or a corrupted
database - not against losing the machine.

`Download` on the portal page writes the archive to whatever machine you are
browsing from. That is the simplest way to hold a copy somewhere else, and it
needs no credentials or cloud account configured on the server.

Do this on a schedule you will actually keep. Weekly, done, beats daily,
intended.

An archive contains every patient record, and the deployment credentials unless
`BACKUP_INCLUDE_ENV` is set to `false`. Keep downloaded copies as carefully as
you keep the server itself. Archives are written `chmod 600`.

If the server later gets a route to off-site storage, the place to copy from is
`./backups` and the place to hook it is after the engine's run.

## Restoring

There is no restore button in the portal, on purpose. A restore overwrites every
database in place, and unlike a failed backup it cannot be retried - whatever it
replaced is gone. The same reasoning applies as to promoting the database
standby: a confirmation dialog only asks a human to be careful, and during an
incident people click through.

Stop the applications first. A service connected while its database is dropped
will reconnect to a half-restored database, and Keycloak and HAPI both run schema
migrations on startup that will then write into it.

```
docker compose stop hapi-fhir hapi-fhir-2 opensrp-server opensrp-server-2 \
                    keycloak dhis2-web bkm-mediator superset openhim-core

bash scripts/restore.sh                                   # lists archives
bash scripts/restore.sh vitallink-20260921_020000.tar.gz

docker compose start hapi-fhir hapi-fhir-2 opensrp-server opensrp-server-2 \
                     keycloak dhis2-web bkm-mediator superset openhim-core
```

The restore verifies the archive's checksum before dropping anything, so a
corrupt archive is found while the databases are still there. It then drops and
recreates each database, recreates the PostGIS and uuid-ossp extensions, and
runs `pg_restore`.

Configuration files are staged into `./backups/restored-config-<timestamp>`
rather than written back over the live tree. The config inside an old archive may
be older than the code now deployed, so copying it back is a decision, not a
side effect.

Afterwards, confirm the data is really there before trusting it. The portal home
page and a patient search are the quickest check.

### Restoring OpenLMIS

`open_lmis` restores with everything else. Note the standing warning in
`docs/` and the project notes: never restart the OpenLMIS `referencedata`
service expecting Flyway to be harmless, because it wipes data on its own
schedule. A restore is not a substitute for reading that first.

## Proving it works

A backup that has never been restored is a hypothesis.

```
make backup-verify
```

This restores the newest archive's `hapi_fhir` dump into a scratch database with
a generated name, counts what actually arrived, and drops it. No existing
database is touched, so it is safe on a live server.

It checks the thing that matters and is otherwise invisible: a dump that restores
into an empty database looks exactly like a good one from the outside. The drill
fails if the archive holds no table data, or if the restore produces an empty
database.

Run it after the first backup, and occasionally after that - the same habit as
`make ha-drill`. To check a specific archive or a different database:

```
docker exec bkm-backup verify.sh vitallink-20260921_020000.tar.gz keycloak
```

## What is not covered

- Docker volumes that are not databases: Prometheus metrics, Loki logs and
  Grafana's own state. These are monitoring history, rebuilt over time, and are
  deliberately left out to keep archives small.
- Caches and session state: `opensrp-redis` (the auth token cache) and the
  `opensrp-web-sessions` volume. Restoring either would be meaningless - losing
  them forces re-authentication and nothing more. The `opensrp` database itself,
  all 54 tables across the `core`, `team`, `public` and `error` schemas, is
  backed up, as are the OpenSRP config files under `config/opensrp/`.
- Container images. Several services pin `:latest`, including
  `opensrp/opensrp-server-web`. A restore rebuilds from whatever `latest` is at
  that moment, which may not be the version that wrote the data. Pinning the
  images to digests is what makes a restore reproducible, and no backup can
  substitute for it.
- Point-in-time recovery. The archives are nightly snapshots, so the exposure is
  up to a day of data. WAL archiving would close that gap and is a larger piece
  of work.
- Cross-database consistency. Each dump is internally consistent; the set is
  taken over a few seconds rather than at one instant. These databases hold no
  foreign keys into each other - the mediator is what joins them - so the skew
  does not matter in practice.
- Off-site copies, unless somebody downloads them. See above.

## Troubleshooting

The engine log is `./backups/backup.log` on the server, and
`make backup-logs` tails the container.

| Symptom | Cause |
|---|---|
| Portal says the engine is not running | `docker compose up -d bkm-backup` |
| Portal cannot read the catalogue | `./backups` is not mounted into `bkm-mediator`; recreate it |
| Run fails on `hapi_fhir.dump is missing` | The health database was unreachable. The archive is refused rather than written incomplete |
| `openlmis is unreachable` warning | The OpenLMIS ref-distro stack is down. The run is marked failed and the rest is still captured |
| Archives stop appearing | Check the container is up and `BACKUP_CRON` is a valid five-field expression |
