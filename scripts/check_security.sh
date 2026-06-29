#!/usr/bin/env bash
# Basic, non-intrusive security checks for a Tomcat-behind-nginx site.
# Observational only: just looks at what the server returns to normal requests.
#
# Usage:
#   ./check_security.sh                              # defaults below
#   ./check_security.sh evoucher.example.com         # different host
#   ./check_security.sh evoucher.example.com /app/   # focus on the real app path
#   ./check_security.sh evoucher.example.com /app/ cookies.txt
#       ^ with a curl cookie jar; useful for inspecting Set-Cookie on JSESSIONID,
#         CSRF tokens, and headers behind login. Populate the jar first, e.g.:
#         curl -c cookies.txt -d "username=...&password=..." \
#              https://evoucher.example.com/login

set -u
HOST="${1:-ethopia-evoucher.nec.xon.co.za}"
APP_PATH="${2:-/}"
COOKIE_JAR="${3:-}"

URL="https://${HOST}"
APP_URL="https://${HOST}${APP_PATH}"

CURL=(curl -sS --max-time 10)
if [ -n "${COOKIE_JAR}" ]; then
  if [ -f "${COOKIE_JAR}" ]; then
    CURL+=(-b "${COOKIE_JAR}" -c "${COOKIE_JAR}")
    echo "Using cookie jar: ${COOKIE_JAR}"
  else
    echo "WARN: cookie jar '${COOKIE_JAR}' not found — running unauthenticated"
  fi
fi

bold() { printf "\n\033[1m== %s ==\033[0m\n" "$*"; }
note() { printf "  %s\n" "$*"; }
warn() { printf "  \033[33m! %s\033[0m\n" "$*"; }
bad()  { printf "  \033[31mX %s\033[0m\n" "$*"; }
ok()   { printf "  \033[32m+ %s\033[0m\n" "$*"; }

echo "Target:    ${URL}"
echo "App path:  ${APP_PATH}"

# ---------------------------------------------------------------------------
bold "1. TLS / certificate"
# ---------------------------------------------------------------------------
echo | openssl s_client -connect "${HOST}:443" -servername "${HOST}" 2>/dev/null \
  | openssl x509 -noout -subject -issuer -dates -ext subjectAltName 2>/dev/null

note "Protocols (failure on tls1/tls1_1 is GOOD):"
for proto in tls1 tls1_1 tls1_2 tls1_3; do
  if echo | openssl s_client -connect "${HOST}:443" -servername "${HOST}" -${proto} 2>/dev/null \
       | grep -q "BEGIN CERTIFICATE"; then
    case "$proto" in
      tls1|tls1_1) bad  "${proto} supported (should be disabled)";;
      *)           ok   "${proto} supported";;
    esac
  else
    case "$proto" in
      tls1|tls1_1) ok   "${proto} not supported";;
      *)           warn "${proto} NOT supported";;
    esac
  fi
done

note "OCSP stapling:"
STAPLE=$(echo | openssl s_client -connect "${HOST}:443" -servername "${HOST}" -status 2>/dev/null \
          | grep -i "OCSP response:" | head -1)
echo "${STAPLE}" | grep -qi "no response sent" \
  && warn "OCSP not stapled (clients fall back to direct OCSP — privacy / availability hit)" \
  || ok   "OCSP stapled"

# ---------------------------------------------------------------------------
bold "2. HTTP -> HTTPS redirect"
# ---------------------------------------------------------------------------
"${CURL[@]}" -I "http://${HOST}${APP_PATH}" | head -5
note "(Status should be 301; Location should be the https:// equivalent.)"

# ---------------------------------------------------------------------------
bold "3. Response headers"
# ---------------------------------------------------------------------------

check_headers() {
  local target="$1" label="$2"
  note "---- ${label}: ${target} ----"
  local hdrs
  hdrs=$("${CURL[@]}" -I "${target}")
  echo "${hdrs}" | sed 's/^/    /'

  echo
  note "Security-header summary for ${label}:"

  if echo "${hdrs}" | grep -qi "^strict-transport-security:"; then
    ok "HSTS present"
    echo "${hdrs}" | grep -i "^strict-transport-security:" | sed 's/^/      /'
  else
    bad "HSTS MISSING"
  fi

  if echo "${hdrs}" | grep -qi "^content-security-policy:"; then
    ok "CSP enforced"
  elif echo "${hdrs}" | grep -qi "^content-security-policy-report-only:"; then
    warn "CSP report-only (not enforcing, but tuning in progress)"
  else
    bad "CSP MISSING"
  fi

  echo "${hdrs}" | grep -qi "^x-content-type-options:" \
    && ok "X-Content-Type-Options present" \
    || bad "X-Content-Type-Options MISSING"
  echo "${hdrs}" | grep -qi "^x-frame-options:" \
    && ok "X-Frame-Options present" \
    || bad "X-Frame-Options MISSING"
  echo "${hdrs}" | grep -qi "^referrer-policy:" \
    && ok "Referrer-Policy present" \
    || warn "Referrer-Policy missing"
  echo "${hdrs}" | grep -qi "^permissions-policy:" \
    && ok "Permissions-Policy present" \
    || warn "Permissions-Policy missing"

  note "Server-identification leaks:"
  local leaks
  leaks=$(echo "${hdrs}" | grep -iE "^(server|x-powered-by|x-aspnet-version):")
  if [ -z "${leaks}" ]; then
    ok "(none)"
  else
    echo "${leaks}" | while read -r l; do
      if echo "$l" | grep -qiE "^server:\s*nginx\s*$"; then
        ok "  ${l}"
      else
        warn "  ${l}"
      fi
    done
  fi
}

check_headers "${URL}/" "root"
[ "${APP_PATH}" != "/" ] && check_headers "${APP_URL}" "app path"

# ---------------------------------------------------------------------------
bold "4. Cookie flags"
# ---------------------------------------------------------------------------
# Use -L to follow redirects, since login often bounces a few times.
COOKIES=$("${CURL[@]}" -ILs "${APP_URL}" | grep -i "^set-cookie:")
if [ -z "${COOKIES}" ]; then
  note "No Set-Cookie seen at ${APP_PATH}."
  [ -z "${COOKIE_JAR}" ] && note "  Tip: log in first with curl -c cookies.txt ... then re-run with the jar."
else
  echo "${COOKIES}" | while read -r line; do
    note "${line}"
    echo "${line}" | grep -qi "httponly" || warn "  -> missing HttpOnly"
    echo "${line}" | grep -qi "secure"   || warn "  -> missing Secure"
    echo "${line}" | grep -qi "samesite" || warn "  -> missing SameSite"
    echo "${line}" | grep -qi "JSESSIONID" \
      && note "  -> JSESSIONID confirms Tomcat (fingerprint, not a vuln)"
  done
fi

# Inspect the jar if provided — shows post-login cookies that may not appear in headers.
if [ -n "${COOKIE_JAR}" ] && [ -f "${COOKIE_JAR}" ]; then
  note ""
  note "Cookies in jar (post-auth):"
  awk '!/^#/ && NF>=7 {
    printf "    %s = %s   (domain=%s, secure=%s, expires=%s)\n",
           $6, substr($0, index($0,$7)), $1, $4, $5
  }' "${COOKIE_JAR}" | head -20
fi

# ---------------------------------------------------------------------------
bold "5. HTTP methods (TRACE / OPTIONS / PUT / DELETE)"
# ---------------------------------------------------------------------------
note "OPTIONS:"
"${CURL[@]}" -I -X OPTIONS "${APP_URL}" | grep -iE "^(allow|HTTP/)" | sed 's/^/    /'

for m in TRACE PUT DELETE; do
  code=$("${CURL[@]}" -o /dev/null -w "%{http_code}" -X "${m}" "${APP_URL}")
  case "${code}" in
    405|501|403) ok   "${m} -> ${code}";;
    200|201|204) bad  "${m} -> ${code}  (method appears enabled!)";;
    *)           warn "${m} -> ${code}";;
  esac
done

# ---------------------------------------------------------------------------
bold "6. Tomcat / nginx default-path exposure"
# ---------------------------------------------------------------------------
PATHS=(
  /manager/html /manager/status /manager/text /manager/jmxproxy/
  /host-manager/html
  /examples/ /examples/servlets/ /examples/jsp/
  /docs/ /docs/RELEASE-NOTES.txt
  /sample/ /ROOT/
  /WEB-INF/web.xml /WEB-INF/classes/ /META-INF/MANIFEST.MF
  /j_security_check
  /nginx_status /server-status /status
  /.git/config /.svn/entries /.env /.htaccess
  /backup/ /backup.zip /backup.tar.gz /db.sql /dump.sql
  /actuator /actuator/health /actuator/env /actuator/mappings
  /api/swagger-ui.html /swagger-ui.html /v2/api-docs /v3/api-docs
  /favicon.ico
)
for p in "${PATHS[@]}"; do
  code=$("${CURL[@]}" -o /dev/null -w "%{http_code}" "${URL}${p}")
  case "$code" in
    200|301|302) bad  "${code}  ${p}";;
    401|403)     warn "${code}  ${p}  (exists, gated)";;
    404|000)     ok   "${code}  ${p}";;
    *)           note "${code}  ${p}";;
  esac
done

# ---------------------------------------------------------------------------
bold "7. Error-page fingerprinting"
# ---------------------------------------------------------------------------
RANDPATH="/does-not-exist-$(date +%s)-$RANDOM"
BODY=$("${CURL[@]}" "${URL}${RANDPATH}")
if echo "${BODY}" | grep -iqE "tomcat|apache-coyote|jetty|nginx/[0-9]"; then
  warn "Server/version strings leak on 404:"
  echo "${BODY}" | grep -iE "tomcat|apache-coyote|jetty|nginx/[0-9]" | head -3 | sed 's/^/    /'
else
  ok "No obvious version strings on 404."
fi

# ---------------------------------------------------------------------------
bold "8. CORS sanity (only meaningful for API paths)"
# ---------------------------------------------------------------------------
CORS=$("${CURL[@]}" -I -H "Origin: https://evil.example" "${APP_URL}" \
        | grep -i "^access-control-allow-")
if [ -z "${CORS}" ]; then
  ok "No ACAO header returned for foreign origin."
else
  echo "${CORS}" | while read -r l; do
    if echo "$l" | grep -qi "access-control-allow-origin:.*\*"; then
      bad "ACAO wildcard: ${l}"
    elif echo "$l" | grep -qi "access-control-allow-origin:.*evil.example"; then
      bad "ACAO reflects arbitrary origins: ${l}"
    else
      note "${l}"
    fi
  done
fi

echo
echo "Done. Red = fix; yellow = review."
