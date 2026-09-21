#!/usr/bin/env python3
"""
run_reports.py - produce the five operational reports agreed in
docs/superset-reporting-requirements.md.

    run_reports.py                 # every report due today
    run_reports.py --all           # every report, ignoring schedule
    run_reports.py --id worker-performance
    run_reports.py --list

WHY THIS AND NOT SUPERSET'S OWN SCHEDULER
Superset's Alerts and Reports needs a Celery worker, a beat scheduler, a broker
and a headless browser. That is three or four more containers, on a single
server that has already run out of memory once. This is one container running
psql on a cron, which is the same shape as the backup engine next door.

Superset remains the place people explore data. This is the place reports get
produced: a file somebody can open, file, or attach to an email.

WHAT IT DOES NOT DO
It does not invent SQL. Each report selects from the `rpt_*` analytics views,
which are already shaped as report output - that is what they are for. Using
`SELECT *` rather than naming columns means a view gaining a column does not
silently drop it from the report.

A source that is unreachable is reported as skipped, not as an error and not as
an empty report. An empty CSV and a CSV that could not be produced mean very
different things to whoever receives it.
"""
import argparse
import csv
import datetime as dt
import io
import os
import smtplib
import subprocess
import sys
from email.message import EmailMessage

OUT_DIR = os.environ.get("REPORT_DIR", "/reports")

SOURCES = {
    "fhir": {
        "label": "FHIR",
        "host": os.environ.get("HEALTH_DB_HOST", "db-postgres"),
        "port": os.environ.get("HEALTH_DB_PORT", "5432"),
        "db": "hapi_fhir",
        "user": os.environ.get("HEALTH_DB_USER", "admin"),
        "password": os.environ.get("HEALTH_DB_PASS", "password123"),
    },
    "dhis2": {
        "label": "DHIS2",
        "host": os.environ.get("HEALTH_DB_HOST", "db-postgres"),
        "port": os.environ.get("HEALTH_DB_PORT", "5432"),
        "db": "dhis2",
        "user": os.environ.get("HEALTH_DB_USER", "admin"),
        "password": os.environ.get("HEALTH_DB_PASS", "password123"),
    },
    "lmis": {
        "label": "OpenLMIS",
        "host": os.environ.get("LMIS_DB_HOST", "db"),
        "port": os.environ.get("LMIS_DB_PORT", "5432"),
        "db": "open_lmis",
        "user": os.environ.get("LMIS_DB_USER", "postgres"),
        "password": os.environ.get("LMIS_DB_PASS", "p@ssw0rd"),
    },
}

# due(today) decides whether a report runs on a given date, so the schedule
# lives with the report definition rather than in a crontab somebody has to
# keep in step with this file.
WEEKLY_MONDAY = lambda d: d.weekday() == 0
WEEKLY_FRIDAY = lambda d: d.weekday() == 4
FORTNIGHTLY = lambda d: d.weekday() == 0 and (d.isocalendar()[1] % 2 == 0)
MONTHLY_FIRST_WEEKDAY = lambda d: d.day <= 3 and d.weekday() < 5 and (
    d.day == 1 or (d.day == 2 and d.weekday() == 0) or (d.day == 3 and d.weekday() == 0)
)
MONTHLY_THIRD_WORKING = lambda d: d.day == 3 and d.weekday() < 5

REPORTS = [
    {
        "id": "stock-status",
        "priority": 1,
        "title": "Weekly stock status and alert report",
        "audience": "National logistics officer, district pharmacist, facility in-charge",
        "schedule": "Weekly, Monday",
        "due": WEEKLY_MONDAY,
        "sources": ["lmis"],
        "sql": "SELECT * FROM analytics.rpt_stock_alerts",
    },
    {
        "id": "lot-expiry",
        "priority": 2,
        "title": "Lot expiry and wastage risk report",
        "audience": "National logistics officer, district pharmacist",
        "schedule": "Monthly, first working day",
        "due": MONTHLY_FIRST_WEEKDAY,
        "sources": ["lmis"],
        "sql": "SELECT * FROM analytics.rpt_lot_expiry",
    },
    {
        "id": "worker-performance",
        "priority": 3,
        "title": "Monthly health worker activity report",
        "audience": "District supervisor, programme manager",
        "schedule": "Monthly, third working day",
        "due": MONTHLY_THIRD_WORKING,
        "sources": ["fhir"],
        # The district average is computed here rather than left to the reader,
        # because "12 patients" means nothing without knowing the district runs
        # at 30. Deliberately framed as activity, not performance ranking.
        "sql": """
            SELECT practitioner_name,
                   district,
                   households,
                   patients,
                   dispenses,
                   units_dispensed,
                   round(avg(patients)  OVER (PARTITION BY district), 1) AS district_avg_patients,
                   round(avg(dispenses) OVER (PARTITION BY district), 1) AS district_avg_dispenses
            FROM analytics.rpt_vhw_caseload
            ORDER BY district, patients DESC
        """,
    },
    {
        "id": "requisition-fulfilment",
        "priority": 4,
        "title": "Requisition and order fulfilment report",
        "audience": "Supply chain manager, national logistics officer",
        "schedule": "Fortnightly, Monday",
        "due": FORTNIGHTLY,
        "sources": ["lmis"],
        "sql": "SELECT * FROM analytics.rpt_requisition_pipeline",
    },
    {
        "id": "data-quality",
        "priority": 5,
        "title": "Data quality exception report",
        "audience": "M&E officer, system administrator",
        "schedule": "Weekly, Friday",
        "due": WEEKLY_FRIDAY,
        # Runs against all three sources and writes one file per source, since
        # the checks differ and merging them would hide which system a problem
        # is in.
        "sources": ["fhir", "lmis", "dhis2"],
        "sql": "SELECT * FROM analytics.rpt_data_quality WHERE failing_rows > 0 ORDER BY severity, failing_rows DESC",
    },
]


def reachable(src):
    r = subprocess.run(
        ["pg_isready", "-h", src["host"], "-p", str(src["port"]), "-U", src["user"], "-t", "8"],
        capture_output=True,
    )
    return r.returncode == 0


def query_csv(src, sql):
    env = dict(os.environ, PGPASSWORD=src["password"])
    r = subprocess.run(
        ["psql", "-h", src["host"], "-p", str(src["port"]), "-U", src["user"],
         "-d", src["db"], "--csv", "-v", "ON_ERROR_STOP=1", "-c", sql],
        capture_output=True, text=True, env=env, timeout=300,
    )
    if r.returncode != 0:
        raise RuntimeError(r.stderr.strip().splitlines()[-1] if r.stderr.strip() else "psql failed")
    return r.stdout


def row_count(csv_text):
    # Header line is not a row. An empty result still has a header, which is
    # why this cannot just count lines.
    rows = list(csv.reader(io.StringIO(csv_text)))
    return max(0, len(rows) - 1)


def send_email(subject, body, attachments):
    host = os.environ.get("SMTP_HOST")
    if not host:
        return "not configured"
    recipients = [a.strip() for a in os.environ.get("REPORT_RECIPIENTS", "").split(",") if a.strip()]
    if not recipients:
        return "no recipients set"
    msg = EmailMessage()
    msg["Subject"] = subject
    msg["From"] = os.environ.get("REPORT_FROM", "reports@vitallink.local")
    msg["To"] = ", ".join(recipients)
    msg.set_content(body)
    for name, content in attachments:
        msg.add_attachment(content.encode("utf-8"), maintype="text",
                           subtype="csv", filename=name)
    try:
        with smtplib.SMTP(host, int(os.environ.get("SMTP_PORT", "1025")), timeout=30) as s:
            user = os.environ.get("SMTP_USER")
            if user:
                s.starttls()
                s.login(user, os.environ.get("SMTP_PASSWORD", ""))
            s.send_message(msg)
        return f"emailed {len(recipients)} recipient(s)"
    except Exception as e:
        return f"email FAILED: {e}"


def run_report(report, run_dir, today):
    print(f"\n[{report['id']}] {report['title']}")
    attachments, notes, total = [], [], 0

    for key in report["sources"]:
        src = SOURCES[key]
        if not reachable(src):
            notes.append(f"{src['label']}: source unreachable, skipped")
            print(f"  {src['label']:<9} SKIPPED - database unreachable")
            continue
        try:
            text = query_csv(src, report["sql"])
        except Exception as e:
            notes.append(f"{src['label']}: failed - {e}")
            print(f"  {src['label']:<9} FAILED - {str(e)[:70]}")
            continue

        n = row_count(text)
        total += n
        suffix = f"-{key}" if len(report["sources"]) > 1 else ""
        name = f"{report['id']}{suffix}-{today:%Y%m%d}.csv"
        path = os.path.join(run_dir, name)
        with open(path, "w", encoding="utf-8", newline="") as f:
            f.write(text)
        attachments.append((name, text))
        print(f"  {src['label']:<9} {n} row(s) -> {name}")

    body = (
        f"{report['title']}\n"
        f"Generated {today:%Y-%m-%d}\n"
        f"For: {report['audience']}\n"
        f"Schedule: {report['schedule']}\n\n"
        f"{total} row(s) across {len(attachments)} file(s).\n"
    )
    if notes:
        body += "\nNotes:\n" + "\n".join(f"  - {n}" for n in notes) + "\n"

    if attachments:
        status = send_email(f"[VitalLink] {report['title']} - {today:%Y-%m-%d}", body, attachments)
        print(f"  email: {status}")
    else:
        print("  nothing produced, no email sent")

    return {"id": report["id"], "files": len(attachments), "rows": total, "notes": notes}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--all", action="store_true", help="run every report regardless of schedule")
    ap.add_argument("--id", action="append", help="run only this report id (repeatable)")
    ap.add_argument("--list", action="store_true", help="list the reports and exit")
    args = ap.parse_args()

    if args.list:
        print(f"{'id':<24} {'pri':<4} {'schedule':<28} sources")
        for r in sorted(REPORTS, key=lambda x: x["priority"]):
            print(f"{r['id']:<24} {r['priority']:<4} {r['schedule']:<28} {','.join(r['sources'])}")
        return 0

    today = dt.date.today()
    if args.id:
        due = [r for r in REPORTS if r["id"] in args.id]
        unknown = set(args.id) - {r["id"] for r in REPORTS}
        for u in unknown:
            print(f"No such report: {u}", file=sys.stderr)
        if not due:
            return 1
    elif args.all:
        due = list(REPORTS)
    else:
        due = [r for r in REPORTS if r["due"](today)]

    if not due:
        print(f"No reports due on {today:%Y-%m-%d} ({today:%A}).")
        return 0

    run_dir = os.path.join(OUT_DIR, f"{today:%Y-%m-%d}")
    os.makedirs(run_dir, exist_ok=True)
    print(f"Writing to {run_dir}")

    results = [run_report(r, run_dir, today) for r in sorted(due, key=lambda x: x["priority"])]

    produced = sum(r["files"] for r in results)
    rows = sum(r["rows"] for r in results)
    skipped = sum(1 for r in results if not r["files"])
    print(f"\n{len(results)} report(s): {produced} file(s), {rows} row(s), {skipped} produced nothing.")
    # Producing nothing is not a crash - an unreachable OpenLMIS is a known
    # state, not a bug in the report engine - but it must not look like success.
    return 1 if skipped else 0


if __name__ == "__main__":
    sys.exit(main())
