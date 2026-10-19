#!/bin/bash
# Checks every public address (production and test), DHIS2/analytics and the local ports, from the
# server it runs on. Run on each server: ./urltest.sh  (PASS/FAIL against the answer each URL should give)
pass=0; fail=0
t() {  # url  expected-codes(space separated)  label
  out=$(curl -s -o /dev/null -m 25 -w "%{http_code} %{time_total}" "$1"); code=${out% *}; secs=${out#* }
  if [[ " $2 " == *" $code "* ]]; then r=PASS; pass=$((pass+1)); else r=FAIL; fail=$((fail+1)); fi
  printf "%-5s %-4s %6ss  %-58s %s\n" "$r" "$code" "$secs" "$1" "$3"
}
echo "== $(hostname) $(date -u +%F\ %T) UTC"
echo "-- production, public"
t https://training.vhw.gov.ls "200" "portal"
t https://vhw.gov.ls/fhir/ "400" "base URL answers HAPI-0287"
t https://vhw.gov.ls/fhir/metadata "200" "capability statement"
t https://vhw.gov.ls/auth/realms/opensrp/ "200" "login realm"
t https://vhw.gov.ls/auth/admin/ "302" "master console"
t https://vhw.gov.ls/auth/admin/opensrp/console/ "200 302" "realm console"
echo "-- test, public"
t https://web.vhw.gov.ls "200" "portal"
t https://web.vhw.gov.ls/admin/location/unit "200" "location page"
t https://app.vhw.gov.ls/fhir/ "400" "base URL answers HAPI-0287"
t https://app.vhw.gov.ls/fhir/metadata "200" "capability statement"
t https://app.vhw.gov.ls/auth/realms/opensrp/ "200" "login realm"
t https://app.vhw.gov.ls/auth/admin/ "302" "master console"
t https://app.vhw.gov.ls/auth/admin/opensrp/console/ "200 302" "realm console"
echo "-- DHIS2 and analytics"
t https://vhw.gov.ls/chwml "302 200" "CHWML staging"
t https://vhw.gov.ls/chwtr "302 200" "chwtr (login known broken)"
t https://bkm.vhw.gov.ls "401 200 302" "Superset"
t http://192.0.2.236:8090 "200 302 401 404" "data pipeline"
echo "-- internal, this server"
for p in "8080/fhir/metadata:200:HAPI" "8081/fhir/metadata:200:gateway" "8082/auth/realms/opensrp:200:Keycloak" "3000/:200 302:portal"; do
  IFS=: read -r path codes lbl <<< "$p"; t "http://127.0.0.1:$path" "$codes" "$lbl (local)"; done
echo "-- internal, other servers"
t http://192.0.2.146:8080/fhir/metadata "200" "production HAPI"
t http://192.0.2.114:8081/fhir/metadata "200 401" "test gateway"
echo "== $pass passed, $fail failed"
