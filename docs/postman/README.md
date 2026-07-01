# Postman collection — Lesotho Health Sandbox

`Lesotho-Health-Sandbox.postman_collection.json` covers the sandbox APIs: BKM mediator,
OpenHIM, HAPI FHIR, DHIS2, OpenLMIS, Keycloak.

The collection variables are pre-set to the PROD deployment (lesotho-bkm.xyz):
- keycloak  = https://lesotho-bkm.xyz/auth
- hapi      = https://fhir.lesotho-bkm.xyz/fhir
- mediator / lesothosite / openhim_ch = https://lesotho-bkm.xyz/mediator-api
- openlmis  = https://lmis.lesotho-bkm.xyz
- dhis2     = https://dhis2.lesotho-bkm.xyz
- openhim_api = https://lesotho-bkm.xyz/openhim

For localhost, change these back to http://localhost:<port> per the service.

## Login

Keycloak uses PKCE (authorization code) for the web portal, but the realm's public clients
have Direct Access Grants enabled, so Postman uses the password grant:
- client_id: opensrp-client (public, no secret)
- username: bkm-admin (the `kc_user` variable)
- password: fill in `kc_pass` yourself — it is blank in the committed file on purpose (no live
  credential in the repo)

Steps:
1. Set `kc_pass` (Collection - Variables) to your bkm-admin password.
2. Run `9. Keycloak -> Token - bkm-admin password grant` first. It saves the JWT to `{{token}}`;
   the collection-level Bearer uses it, so FHIR and mediator requests then work. Token lasts 5
   minutes - re-run when it expires.
3. For OpenLMIS, run `8. OpenLMIS -> Auth - get token` to fill `{{lmis_token}}`.

HAPI FHIR and the mediator are open on prod (no token required); the bearer is there for any
protected route.

## Notes

- All passwords are blanked in this committed copy (Keycloak, DHIS2, OpenHIM, OpenLMIS). Fill
  them in yourself per request / in the collection variables. Keep your filled-in copy local -
  do not commit credentials back.
- `facility_id` / `program_id` / `orderable_id` are the old Maseru demo ids. Prod is Mafeteng;
  fetch the real ids via `OpenLMIS -> Facilities/Orderables list` after getting the LMIS token.
- Some requests still have relative URLs (no host) - prepend `{{mediator}}` / `{{hapi}}` etc.
