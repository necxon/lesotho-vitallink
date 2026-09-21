# NEC XON (c) Copyright 2025.
#
# Operational report engine.
#
# postgres:14-alpine for psql, matching the backup container - the client must
# be at least as new as the servers it queries. python3 for CSV handling and
# SMTP; psycopg2 is deliberately not used, so there is nothing to compile and
# psql does the talking.
FROM postgres:14-alpine

RUN apk add --no-cache bash python3 tzdata

COPY run_reports.py entrypoint.sh /usr/local/bin/
RUN chmod +x /usr/local/bin/run_reports.py /usr/local/bin/entrypoint.sh

ENV REPORT_DIR=/reports
ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
