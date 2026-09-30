#!/usr/bin/env python3
"""
nginx_timing.py - show whether slowness is the backend or the network.

    python scripts/nginx_timing.py /var/log/nginx/timing.log

Reads the "timing" log format (see docs/nginx-timing.md) and, per host and
first path segment (/fhir, /auth, ...), prints request counts and the median and
95th percentile of:

    total     time nginx spent on the request (backend + sending to the client)
    backend   time the backend took to answer nginx
    client    total - backend: mostly the network and the client's speed

Large "client" with small "backend"  -> the network or the phone is slow.
Large "backend"                      -> the server is slow; QoS will not help.
"""
import collections
import re
import statistics
import sys

LINE = re.compile(r'^(\S+) (\S+) "[A-Z]+ (\S+) [^"]*" (\d+) (\S+) (\S+)$')


def pct(vals, p):
    vals = sorted(vals)
    return vals[min(len(vals) - 1, int(len(vals) * p))]


def main(path):
    groups = collections.defaultdict(lambda: ([], []))
    for line in open(path, errors="replace"):
        m = LINE.match(line.strip())
        if not m:
            continue
        host, _ip, uri, _status, total, up = m.groups()
        try:
            total = float(total)
            up = float(up.split(",")[-1])   # "-" (no backend) or a retry list
        except ValueError:
            continue
        seg = "/" + uri.lstrip("/").split("/")[0].split("?")[0]
        groups[(host, seg)][0].append(total)
        groups[(host, seg)][1].append(up)

    print(f"{'host':28}{'path':14}{'n':>7}  {'total p50/p95':>16}  {'backend p50/p95':>16}  {'client p50':>10}")
    for (host, seg), (tot, up) in sorted(groups.items(), key=lambda kv: -len(kv[1][0])):
        client = [max(t - u, 0) for t, u in zip(tot, up)]
        print(f"{host:28}{seg:14}{len(tot):>7}  "
              f"{statistics.median(tot):>7.2f}/{pct(tot,.95):<7.2f}  "
              f"{statistics.median(up):>7.2f}/{pct(up,.95):<7.2f}  "
              f"{statistics.median(client):>10.2f}")


if __name__ == "__main__":
    if len(sys.argv) != 2:
        sys.exit(__doc__)
    main(sys.argv[1])
