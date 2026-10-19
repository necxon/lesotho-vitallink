# superset-next

A production-style Superset on the jump host (jump-host, port 18088), to test the
replacement of the development install on analytics-host. The current Superset is not
changed: it keeps running, and its database is only read (one pg_dump).

- official release image (SUPERSET_VERSION in .env), not built from source
- production settings (no DEV_MODE, no examples loading, gunicorn), Redis cache
- own PostgreSQL with a copy of the current Superset database: same users, dashboards,
  datasets and saved queries
- PyHive driver, so the BKM_Server connection (Spark on analytics-host:10001) works

Run everything on the jump host as deploy-user (no sudo), in ~/superset-next, unless a step
says otherwise.

## 1. Files

From the PC:

    scp -P 22 -r deploy/vhw-stack/superset-next deploy-user@jump-host-public:

## 2. Settings (.env)

    cd ~/superset-next && cp .env.example .env && chmod 600 .env
    sed -i "s/^DATABASE_PASSWORD=$/DATABASE_PASSWORD=$(openssl rand -hex 16)/" .env
    sed -i "s/^SUPERSET_SECRET_KEY=$/SUPERSET_SECRET_KEY=$(openssl rand -base64 42 | tr -d '\n\/+=')/" .env
    grep -cE "^(DATABASE_PASSWORD|SUPERSET_SECRET_KEY)=." .env      # 2

SUPERSET_PREVIOUS_SECRET_KEY is the current Superset's key, used once so that init can
re-encrypt the copied connections with the new key. On analytics-host:

    sudo docker exec superset_app printenv SUPERSET_SECRET_KEY

Put the value on the SUPERSET_PREVIOUS_SECRET_KEY line with `nano .env`. (On 13 Oct
2026 the current server used Superset's published example key TEST_NON_DEV_SECRET,
which lets anyone forge a login there; this install must not keep it.)

## 3. Copy the current Superset database

On analytics-host (read-only for that database):

    sudo -u postgres pg_dump -Fc superset > /tmp/superset-meta.dump && ls -lh /tmp/superset-meta.dump

On the jump host:

    scp -P 22 deploy-user@analytics-host:/tmp/superset-meta.dump ~/
    ssh -p 22 deploy-user@analytics-host "rm -f /tmp/superset-meta.dump"

## 4. Build and start

    docker compose build
    docker compose up -d db redis && sleep 10
    docker compose exec -T db sh -c 'pg_restore -U "$POSTGRES_USER" -d "$POSTGRES_DB" --no-owner --no-acl' < ~/superset-meta.dump; echo "restore exit: $?"
    docker compose --profile init run --rm init      # upgrade to this version + re-encrypt with the new key
    sed -i "s/^SUPERSET_PREVIOUS_SECRET_KEY=.*/SUPERSET_PREVIOUS_SECRET_KEY=/" .env   # old key no longer needed
    docker compose up -d superset
    shred -u ~/superset-meta.dump

pg_restore may report a few harmless errors for objects that already exist; "restore
exit: 1" with only such messages is fine. `init` must end without a traceback.

## 5. Check

    curl -s http://jump-host:18088/health; echo        # OK
    docker compose ps

From the PC, through a tunnel to the jump host (Termius, or):

    ssh -p 22 -L 18088:jump-host:18088 deploy-user@jump-host-public

then open http://localhost:18088 and log in with the same Superset username and
password as on bkm.vhw.gov.ls. Check:
- the BKM Child Health dashboard opens and shows numbers
- SQL Lab, database BKM_Server: `SELECT count(*), max(meta.lastUpdated) FROM task`
  gives the same as on the current Superset

## Remove again

    docker compose down -v        # -v also deletes this install's database copy

Nothing on analytics-host is affected.
