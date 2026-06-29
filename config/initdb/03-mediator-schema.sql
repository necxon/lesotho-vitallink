-- Mediator database schema.
-- Tables are provisioned and ready. The mediator still uses flat files / in-memory
-- state for now. See TODO.md (repo root) — "Migrate mediator state to Postgres".

\c mediator

CREATE TABLE IF NOT EXISTS performer_mappings (
    id              TEXT        PRIMARY KEY,   -- e.g. Practitioner/prac-thabo-mokoena
    name            TEXT,
    role            TEXT        NOT NULL DEFAULT 'vhw',  -- vhw | facility_worker | supervisor
    facility_id     TEXT        NOT NULL DEFAULT '',
    program_id      TEXT        NOT NULL DEFAULT '',
    dhis2_org_unit  TEXT,
    phone           TEXT,
    email           TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS medication_mappings (
    code            TEXT        PRIMARY KEY,   -- app code e.g. AL-20-120
    orderable_id    TEXT        NOT NULL,      -- OpenLMIS orderable UUID
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS runtime_config (
    key             TEXT        PRIMARY KEY,
    value           TEXT        NOT NULL,
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Order batch dispatch log — one row per period dispatched.
-- Mirrors /data/dispatched-orders.json (orderBuffer.js).
-- Prevents double-dispatch across restarts.
CREATE TABLE IF NOT EXISTS dispatch_log (
    period          TEXT        PRIMARY KEY,  -- YYYYMM e.g. 202605
    dispatched_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    entry_count     INT         NOT NULL DEFAULT 0,
    orderable_ids   TEXT[],                   -- which orderables were dispatched
    notes           TEXT
);

-- Order dispatch schedule — single-row, tracks chosen frequency.
-- Mirrors /data/order-schedule.json (scheduleState.js).
CREATE TABLE IF NOT EXISTS order_schedule (
    id              INT         PRIMARY KEY DEFAULT 1,  -- enforces single row
    frequency       TEXT        NOT NULL DEFAULT 'monthly',  -- daily | weekly | monthly
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT single_row CHECK (id = 1)
);
INSERT INTO order_schedule (id, frequency) VALUES (1, 'monthly') ON CONFLICT DO NOTHING;

-- Idempotency cache — prevents duplicate fan-out for resubmitted FHIR resources.
-- Replaces the in-memory _seenIds Map in dispense.js (lost on restart).
CREATE TABLE IF NOT EXISTS idempotency_cache (
    resource_id     TEXT        PRIMARY KEY,
    accepted_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_idempotency_accepted_at ON idempotency_cache (accepted_at);

-- Fan-out audit log — immutable record of every dispense/receipt processed.
-- Currently no permanent record exists; useful for debugging and reporting.
CREATE TABLE IF NOT EXISTS fan_out_events (
    id              BIGSERIAL   PRIMARY KEY,
    resource_id     TEXT,
    resource_type   TEXT,                     -- MedicationDispense | QuestionnaireResponse
    event_type      TEXT,                     -- dispense | receipt | facility-receipt
    performer       TEXT,
    medication_code TEXT,
    quantity        NUMERIC,
    opensrp_status  TEXT,
    dhis2_status    TEXT,
    openlmis_status TEXT,
    error_message   TEXT,
    processed_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_fan_out_performer    ON fan_out_events (performer);
CREATE INDEX IF NOT EXISTS idx_fan_out_processed_at ON fan_out_events (processed_at);

-- DHIS2 org unit labels — village/region display names keyed by OU UID.
-- Mirrors the OU_LABELS hardcode in mappings.js; editable via Mappings UI later.
CREATE TABLE IF NOT EXISTS ou_labels (
    dhis2_org_unit  TEXT        PRIMARY KEY,  -- 11-char DHIS2 UID
    village         TEXT,
    region          TEXT,
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Trigger function to auto-update updated_at on any row change
CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_performer_mappings_updated_at
    BEFORE UPDATE ON performer_mappings
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TRIGGER trg_medication_mappings_updated_at
    BEFORE UPDATE ON medication_mappings
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TRIGGER trg_runtime_config_updated_at
    BEFORE UPDATE ON runtime_config
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TRIGGER trg_order_schedule_updated_at
    BEFORE UPDATE ON order_schedule
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TRIGGER trg_ou_labels_updated_at
    BEFORE UPDATE ON ou_labels
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();
