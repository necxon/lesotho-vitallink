"""
Generate /etc/nginx/conf.d/default.conf for openlmis-ref-distro-nginx-1.
Run: python scripts/gen_openlmis_nginx.py > /tmp/openlmis_nginx.conf
Then: docker cp /tmp/openlmis_nginx.conf openlmis-ref-distro-nginx-1:/etc/nginx/conf.d/default.conf
      docker exec openlmis-ref-distro-nginx-1 nginx -s reload
"""
import re, sys

SERVICE_IPS = {
    'auth':           'auth:8080',
    'buq':            'buq:8080',
    'cce':            'cce:8080',
    'dhis2':          'dhis2-integration:8080',
    'diagnostics':    'diagnostics:8080',
    'fulfillment':    'fulfillment:8080',
    'hapifhir':       'hapifhir:8080',
    'notification':   'notification:8080',
    'referencedata':  'referencedata:8080',
    'report':         'report:8080',
    'requisition':    'requisition:8080',
    'stockmanagement':'stockmanagement:8080',
    'reference-ui':   'reference-ui:80',
}

# All KV pairs from `consul kv get -recurse resources/`, with `resources/` stripped.
KV_RAW = """\
:reference-ui
<all>:reference-ui
actuator/togglz:referencedata
api/Device:cce
api/Location:referencedata
api/apiKeys:auth
api/apiKeys/{token}:auth
api/availableRequisitionColumns:requisition
api/bottomUpQuantifications:buq
api/bottomUpQuantifications/approveFacilityForecastingStats:buq
api/bottomUpQuantifications/costCalculation:buq
api/bottomUpQuantifications/finalApprove:buq
api/bottomUpQuantifications/forFinalApproval:buq
api/bottomUpQuantifications/prepare:buq
api/bottomUpQuantifications/supervisedGeographicZones:buq
api/bottomUpQuantifications/{id}:buq
api/bottomUpQuantifications/{id}/approve:buq
api/bottomUpQuantifications/{id}/auditLog:buq
api/bottomUpQuantifications/{id}/authorize:buq
api/bottomUpQuantifications/{id}/download:buq
api/bottomUpQuantifications/{id}/mostRecentRejection:buq
api/bottomUpQuantifications/{id}/reject:buq
api/bottomUpQuantifications/{id}/submit:buq
api/catalogItems:cce
api/catalogItems/{id}:cce
api/cceAlerts:cce
api/clients/search/findOneByClientId:auth
api/commodityTypes:referencedata
api/commodityTypes/{id}/auditLog:referencedata
api/commodityTypes/{id}/tradeItems:referencedata
api/currencySettings:referencedata
api/digestConfiguration:notification
api/digestConfiguration/{id}:notification
api/execute:dhis2
api/exportData:referencedata
api/facilities:referencedata
api/facilities/byBoundary:referencedata
api/facilities/full:referencedata
api/facilities/minimal:referencedata
api/facilities/search:referencedata
api/facilities/{id}:referencedata
api/facilities/{id}/approvedProducts:referencedata
api/facilities/{id}/auditLog:referencedata
api/facilityOperators:referencedata
api/facilityOperators/{id}:referencedata
api/facilityOperators/{id}/auditLog:referencedata
api/facilityTypeApprovedProducts:referencedata
api/facilityTypeApprovedProducts/search:referencedata
api/facilityTypeApprovedProducts/{id}:referencedata
api/facilityTypeApprovedProducts/{id}/auditLog:referencedata
api/facilityTypes:referencedata
api/facilityTypes/{id}:referencedata
api/facilityTypes/{id}/auditLog:referencedata
api/fileTemplates:fulfillment
api/geographicLevels:referencedata
api/geographicLevels/{id}:referencedata
api/geographicLevels/{id}/auditLog:referencedata
api/geographicZones:referencedata
api/geographicZones/byLocation:referencedata
api/geographicZones/search:referencedata
api/geographicZones/{id}:referencedata
api/geographicZones/{id}/auditLog:referencedata
api/health:diagnostics
api/idealStockAmounts:referencedata
api/importData:referencedata
api/inventoryItems:cce
api/inventoryItems/download:cce
api/inventoryItems/volume:cce
api/inventoryItems/{id}:cce
api/inventoryItems/{id}/transfer:cce
api/lots:referencedata
api/lots/{id}:referencedata
api/lots/{id}/auditLog:referencedata
api/notifications:notification
api/oauth:auth
api/oauth/<all>:auth
api/oauth/authorize:auth
api/oauth/check_token:auth
api/oauth/confirm_access:auth
api/oauth/error:auth
api/oauth/token:auth
api/orderNumberConfigurations:fulfillment
api/orderableDisplayCategories:referencedata
api/orderableDisplayCategories/search:referencedata
api/orderableDisplayCategories/{id}:referencedata
api/orderableDisplayCategories/{id}/auditLog:referencedata
api/orderableFulfills:referencedata
api/orderables:referencedata
api/orderables/search:referencedata
api/orderables/{id}:referencedata
api/orderables/{id}/auditLog:referencedata
api/orders:fulfillment
api/orders/batch:fulfillment
api/orders/numberOfOrdersData:fulfillment
api/orders/requestingFacilities:fulfillment
api/orders/requisitionLess:fulfillment
api/orders/statusesStatsData:fulfillment
api/orders/{id}:fulfillment
api/orders/{id}/export:fulfillment
api/orders/{id}/print:fulfillment
api/orders/{id}/requisitionLess/send:fulfillment
api/orders/{id}/retry:fulfillment
api/organizations:stockmanagement
api/organizations/{id}:stockmanagement
api/physicalInventories:stockmanagement
api/physicalInventories/{id}:stockmanagement
api/physicalInventoryTemplates:stockmanagement
api/processingPeriods:referencedata
api/processingPeriods/{id}:referencedata
api/processingPeriods/{id}/auditLog:referencedata
api/processingPeriods/{id}/duration:referencedata
api/processingSchedules:referencedata
api/processingSchedules/search:referencedata
api/processingSchedules/{id}:referencedata
api/processingSchedules/{id}/auditLog:referencedata
api/productGroups:buq
api/productGroups/{id}:buq
api/productGroups/{id}/auditLog:buq
api/programs:referencedata
api/programs/search:referencedata
api/programs/{id}:referencedata
api/programs/{id}/auditLog:referencedata
api/proofOfDeliveryTemplates:fulfillment
api/proofsOfDelivery:fulfillment
api/proofsOfDelivery/{id}:fulfillment
api/proofsOfDelivery/{id}/auditLog:fulfillment
api/proofsOfDelivery/{id}/print:fulfillment
api/public/stockCardSummaries:stockmanagement
api/public/stockEvents:stockmanagement
api/reasonCategories:stockmanagement
api/reasonTypes:stockmanagement
api/rejectionReasonCategories:requisition
api/rejectionReasonCategories/search:requisition
api/rejectionReasonCategories/{id}:requisition
api/rejectionReasons:requisition
api/rejectionReasons/search:requisition
api/rejectionReasons/{id}:requisition
api/remark:buq
api/remark/{id}:buq
api/remark/{id}/auditLog:buq
api/reports/dashboardReports:report
api/reports/dashboardReports/availableReports:report
api/reports/dashboardReports/{id}:report
api/reports/districts:report
api/reports/images:report
api/reports/images/{id}:report
api/reports/processingPeriods:report
api/reports/programs:report
api/reports/reportCategories:report
api/reports/reportCategories/{id}:report
api/reports/requisitions/{id}/print:report
api/reports/stockAdjustmentReasons/search:report
api/reports/templates/common:report
api/reports/templates/common/{id}:report
api/reports/templates/common/{id}/{format}:report
api/reports/templates/fulfillment:fulfillment
api/reports/templates/fulfillment/{id}:fulfillment
api/reports/templates/requisitions:requisition
api/reports/templates/requisitions/{id}:requisition
api/reports/templates/requisitions/{id}/{format}:requisition
api/requisitionGroups:referencedata
api/requisitionGroups/search:referencedata
api/requisitionGroups/{id}:referencedata
api/requisitionGroups/{id}/auditLog:referencedata
api/requisitionTemplates:requisition
api/requisitionTemplates/{facilityTypeId}/{programId}/{reportOnly}:requisition
api/requisitionTemplates/{id}:requisition
api/requisitions:requisition
api/requisitions/batchReleases:requisition
api/requisitions/convertToOrder:requisition
api/requisitions/initiate:requisition
api/requisitions/numberOfRequisitionsForApproval:requisition
api/requisitions/periodsForInitiate:requisition
api/requisitions/requisitionsForApproval:requisition
api/requisitions/requisitionsForConvert:requisition
api/requisitions/search:requisition
api/requisitions/statusesStatsData:requisition
api/requisitions/submitted:requisition
api/requisitions/unSkipRequisition:requisition
api/requisitions/{id}:requisition
api/requisitions/{id}/approve:requisition
api/requisitions/{id}/authorize:requisition
api/requisitions/{id}/print:requisition
api/requisitions/{id}/reject:requisition
api/requisitions/{id}/skip:requisition
api/requisitions/{id}/statusMessages:requisition
api/requisitions/{id}/submit:requisition
api/rights:referencedata
api/rights/search:referencedata
api/rights/{id}/auditLog:referencedata
api/rights/{rightId}:referencedata
api/roles:referencedata
api/roles/{id}/auditLog:referencedata
api/roles/{roleId}:referencedata
api/serverConfiguration:dhis2
api/serverConfiguration/{id}:dhis2
api/serverConfiguration/{id}/auditLog:dhis2
api/serverConfiguration/{id}/categoryOptionCombos:dhis2
api/serverConfiguration/{id}/datasets:dhis2
api/serverConfiguration/{id}/datasets/{id}:dhis2
api/serverConfiguration/{id}/datasets/{id}/auditLog:dhis2
api/serverConfiguration/{id}/datasets/{id}/dhisElements:dhis2
api/serverConfiguration/{id}/datasets/{id}/elements:dhis2
api/serverConfiguration/{id}/datasets/{id}/elements/{id}:dhis2
api/serverConfiguration/{id}/datasets/{id}/elements/{id}/auditLog:dhis2
api/serverConfiguration/{id}/datasets/{id}/elementsAndCombos:dhis2
api/serverConfiguration/{id}/datasets/{id}/periodMappings:dhis2
api/serverConfiguration/{id}/datasets/{id}/periodMappings/{id}:dhis2
api/serverConfiguration/{id}/datasets/{id}/periodMappings/{id}/auditLog:dhis2
api/serverConfiguration/{id}/dhisDatasets:dhis2
api/serverConfiguration/{id}/dhisDatasets/{id}:dhis2
api/serverConfiguration/{id}/dhisPeriodTypes:dhis2
api/serviceAccounts:referencedata
api/serviceAccounts/{token}:referencedata
api/settings/{key}:report
api/shipmentDrafts:fulfillment
api/shipmentDrafts/{id}:fulfillment
api/shipments:fulfillment
api/shipments/{id}:fulfillment
api/sourcesOfFunds:buq
api/sourcesOfFunds/{id}:buq
api/sourcesOfFunds/{id}/auditLog:buq
api/stockCardLineItemReasonTags:stockmanagement
api/stockCardLineItemReasons:stockmanagement
api/stockCardLineItemReasons/{id}:stockmanagement
api/stockCardRangeSummaries:stockmanagement
api/stockCardSummaries:stockmanagement
api/stockCardSummaries/noCards:stockmanagement
api/stockCardSummaries/print:stockmanagement
api/stockCardTemplates:stockmanagement
api/stockCards:stockmanagement
api/stockCards/deactivate:stockmanagement
api/stockCards/{id}:stockmanagement
api/stockCards/{id}/deactivate:stockmanagement
api/stockCards/{id}/print:stockmanagement
api/stockEvents:stockmanagement
api/supervisoryNodes:referencedata
api/supervisoryNodes/{id}:referencedata
api/supervisoryNodes/{id}/auditLog:referencedata
api/supervisoryNodes/{id}/facilities:referencedata
api/supervisoryNodes/{id}/supervisingUsers:referencedata
api/supplyLines:referencedata
api/supplyLines/{id}:referencedata
api/supplyLines/{id}/auditLog:referencedata
api/supplyPartners:referencedata
api/supplyPartners/{id}:referencedata
api/supplyPartners/{id}/auditLog:referencedata
api/systemNotifications:referencedata
api/systemNotifications/{id}:referencedata
api/systemNotifications/{id}/auditLog:referencedata
api/tradeItems:referencedata
api/tradeItems/{id}/auditLog:referencedata
api/transferProperties:fulfillment
api/transferProperties/search:fulfillment
api/transferProperties/{id}:fulfillment
api/userContactDetails:notification
api/userContactDetails/{id}:notification
api/userContactDetails/{id}/verifications:notification
api/userContactDetails/{id}/verifications/{token}:notification
api/users:referencedata
api/users/auth:auth
api/users/auth/changePassword:auth
api/users/auth/forgotPassword:auth
api/users/auth/logout:auth
api/users/auth/passwordReset:auth
api/users/auth/passwordResetToken:auth
api/users/auth/{id}:auth
api/users/rightSearch:referencedata
api/users/search:referencedata
api/users/search/findOneByUsername:auth
api/users/{id}/auditLog:referencedata
api/users/{id}/subscriptions:notification
api/users/{userId}:referencedata
api/users/{userId}/facilities:referencedata
api/users/{userId}/fulfillmentFacilities:referencedata
api/users/{userId}/hasRight:referencedata
api/users/{userId}/permissionStrings:referencedata
api/users/{userId}/programs:referencedata
api/users/{userId}/roleAssignments:referencedata
api/users/{userId}/supportedPrograms:referencedata
api/v2/requisitions/initiate:requisition
api/v2/requisitions/{id}:requisition
api/v2/requisitions/{id}/updatePatientsData:requisition
api/v2/stockCardSummaries:stockmanagement
api/validDestinations:stockmanagement
api/validDestinations/{id}:stockmanagement
api/validReasons:stockmanagement
api/validReasons/{id}:stockmanagement
api/validSources:stockmanagement
api/validSources/{id}:stockmanagement
auth:auth
auth/docs:auth
auth/docs/<all>:auth
auth/webjars:auth
auth/webjars/<all>:auth
buq:buq
buq/docs:buq
buq/docs/<all>:buq
buq/webjars:buq
buq/webjars/<all>:buq
cce:cce
cce/docs:cce
cce/docs/<all>:cce
cce/webjars:cce
cce/webjars/<all>:cce
dhis2:dhis2
dhis2/docs:dhis2
dhis2/docs/<all>:dhis2
dhis2/webjars:dhis2
dhis2/webjars/<all>:dhis2
diagnostics:diagnostics
diagnostics/docs:diagnostics
diagnostics/docs/<all>:diagnostics
diagnostics/webjars:diagnostics
diagnostics/webjars/<all>:diagnostics
fulfillment:fulfillment
fulfillment/docs:fulfillment
fulfillment/docs/<all>:fulfillment
fulfillment/webjars:fulfillment
fulfillment/webjars/<all>:fulfillment
hapifhir:hapifhir
hapifhir/<all>:hapifhir
hapifhir/Location:hapifhir
hapifhir/Measure:hapifhir
hapifhir/MeasureReport:hapifhir
hapifhir/docs:hapifhir
hapifhir/docs/<all>:hapifhir
hapifhir/webjars:hapifhir
hapifhir/webjars/<all>:hapifhir
localeSettings:referencedata
notification:notification
notification/docs:notification
notification/docs/<all>:notification
notification/webjars:notification
notification/webjars/<all>:notification
referencedata:referencedata
referencedata/docs:referencedata
referencedata/docs/<all>:referencedata
referencedata/webjars:referencedata
referencedata/webjars/<all>:referencedata
report:report
report/docs:report
report/docs/<all>:report
report/webjars:report
report/webjars/<all>:report
requisition:requisition
requisition/docs:requisition
requisition/docs/<all>:requisition
requisition/webjars:requisition
requisition/webjars/<all>:requisition
stockmanagement:stockmanagement
stockmanagement/docs:stockmanagement
stockmanagement/docs/<all>:stockmanagement
stockmanagement/webjars:stockmanagement
stockmanagement/webjars/<all>:stockmanagement
togglz-console:referencedata
togglz-console/<all>:referencedata"""

PARAM_RE = re.compile(r'\{[\w-]+\}')
ALL_RE   = re.compile(r'<[\w-]+>')
GLOBAL_ALL_RE = re.compile(r'^<[\w-]+>$')

def loc(path, upstream, indent='  '):
    return (f'{indent}location ~ /{path}/?$ {{\n'
            f'{indent}  proxy_pass http://{upstream};\n'
            f'{indent}  proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;\n'
            f'{indent}}}')

def parse_kv():
    pairs = []
    for line in KV_RAW.strip().splitlines():
        path, _, upstream = line.rpartition(':')
        pairs.append((path.strip(), upstream.strip()))
    return pairs

def upstreams_block():
    lines = []
    for svc, addr in SERVICE_IPS.items():
        lines.append(f'upstream {svc} {{\n  least_conn;\n  keepalive 128;\n  server {addr};\n}}')
    return '\n'.join(lines)

STUBS = """\
  # bkm-stubs-v7
  # -- BKM sandbox stubs --------------------------------------------------------
  # OPTIONS preflight to /api/oauth/token returns 401 from auth → browser blocks login POST.
  # Exact-match overrides the regex proxy block; if-block handles preflight with 204.
  location = /api/oauth/token {
    if ($request_method = OPTIONS) {
      add_header Access-Control-Allow-Origin $http_origin always;
      add_header Access-Control-Allow-Methods "POST, OPTIONS" always;
      add_header Access-Control-Allow-Headers "Authorization, Content-Type" always;
      add_header Access-Control-Allow-Credentials true always;
      return 204;
    }
    proxy_pass http://auth;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
  }
  location = /api/users/35316636-6264-6331-2d34-3933322d3462/permissionStrings {
    default_type application/json;
    return 200 '["STOCK_INVENTORIES_EDIT|28de536f-b826-4eeb-a3c4-d65221a1120d|31ef5fd8-cef9-4ec0-8304-3018d2cf6c9c","STOCK_INVENTORIES_EDIT","STOCK_CARD_LINE_ITEM_REASONS_MANAGE","USER_ROLES_MANAGE","PROCESSING_SCHEDULES_MANAGE","PROGRAMS_MANAGE","STOCK_ORGANIZATIONS_MANAGE","STOCK_DESTINATIONS_MANAGE","USERS_MANAGE","STOCK_ADJUSTMENT_REASONS_MANAGE","REQUISITION_GROUPS_MANAGE","SUPERVISORY_NODES_MANAGE","SUPPLY_LINES_MANAGE","SYSTEM_IDEAL_STOCK_AMOUNTS_MANAGE","FACILITIES_MANAGE","RIGHTS_VIEW","GEOGRAPHIC_ZONES_MANAGE","REQUISITION_TEMPLATES_MANAGE","FACILITY_APPROVED_ORDERABLES_MANAGE","STOCK_CARD_TEMPLATES_MANAGE","SERVICE_ACCOUNTS_MANAGE","STOCK_SOURCES_MANAGE","ORDERABLES_MANAGE","SYSTEM_SETTINGS_MANAGE","CCE_MANAGE","STOCK_ADJUST|28de536f-b826-4eeb-a3c4-d65221a1120d|31ef5fd8-cef9-4ec0-8304-3018d2cf6c9c","STOCK_CARDS_VIEW|28de536f-b826-4eeb-a3c4-d65221a1120d|31ef5fd8-cef9-4ec0-8304-3018d2cf6c9c","STOCK_CARDS_VIEW"]';
  }
  location = /api/users/35316636-6264-6331-2d34-3933322d3462/programs {
    default_type application/json;
    return 200 '[{"code":"EM","name":"Essential Medicines","active":true,"periodsSkippable":false,"skipAuthorization":false,"showNonFullSupplyTab":true,"enableDatePhysicalStockCountCompleted":false,"id":"31ef5fd8-cef9-4ec0-8304-3018d2cf6c9c"}]';
  }
  location = /api/userContactDetails {
    default_type application/json;
    return 200 '{"content":[{"referenceDataUserId":"35316636-6264-6331-2d34-3933322d3462","emailDetails":{"email":"admin@example.com","emailVerified":false},"phoneNumber":"","allowNotify":true}],"totalElements":1,"totalPages":1,"last":true,"first":true,"number":0,"numberOfElements":1,"size":10}';
  }
  location ~ /api/userContactDetails {
    default_type application/json;
    return 200 '{"referenceDataUserId":"35316636-6264-6331-2d34-3933322d3462","emailDetails":{"email":"admin@example.com","emailVerified":false},"phoneNumber":"","allowNotify":true}';
  }
  location ~ /api/users/auth/[^/]+ {
    default_type application/json;
    return 200 '{"enabled":true,"loginRestricted":false,"allowedPrograms":[]}';
  }
  location = /api/users/me {
    rewrite ^ /api/users/35316636-6264-6331-2d34-3933322d3462 break;
    proxy_pass http://referencedata;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
  }
  location ~ /api/systemNotifications {
    resolver 127.0.0.11 valid=10s ipv6=off;
    set $sysnot http://bkm-mediator:3000;
    rewrite ^/api/systemNotifications(.*)$ /lmis-notifications$1 break;
    proxy_pass $sysnot;
  }
  location ~ /oauth-init/openlmis {
    default_type application/json;
    return 200 '{"state":"NONE"}';
  }
  location ~ /oauth-authorized/openlmis {
    default_type application/json;
    return 200 '{"state":"NONE"}';
  }
  location ~ /api/pages/home {
    default_type application/json;
    return 200 '{"content":[],"totalElements":0,"totalPages":0,"last":true,"first":true,"number":0,"numberOfElements":0,"size":10}';
  }
  location ~ /api/supportedPrograms {
    default_type application/json;
    return 200 '[]';
  }
  location ~ /api/orders/statusesStatsData {
    default_type application/json;
    return 200 '{}';
  }
  location ~ /api/requisitions/statusesStatsData {
    default_type application/json;
    return 200 '{}';
  }
  location ~ /api/reports/dashboardReports {
    default_type application/json;
    return 200 '[]';
  }
  location = /api/orderables/search {
    proxy_method GET;
    rewrite ^ /api/orderables break;
    proxy_pass http://referencedata;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
  }
  location ~ /api/validSources {
    default_type application/json;
    return 200 '{"content":[],"totalElements":0,"totalPages":0,"last":true,"first":true,"number":0,"numberOfElements":0,"size":2147483647}';
  }
  location ~ /api/validDestinations {
    default_type application/json;
    return 200 '{"content":[],"totalElements":0,"totalPages":0,"last":true,"first":true,"number":0,"numberOfElements":0,"size":2147483647}';
  }
  location ~ /api/requisitionGroups {
    default_type application/json;
    return 200 '{"content":[],"totalElements":0,"totalPages":0,"last":true,"first":true,"number":0,"numberOfElements":0,"size":2147483647}';
  }
  location ~ /api/stockAdjustmentReasons {
    default_type application/json;
    return 200 '{"content":[],"totalElements":0,"totalPages":0,"last":true,"first":true,"number":0,"numberOfElements":0,"size":2147483647}';
  }
  location ~ /api/facilities/[^/]+/supportedPrograms {
    default_type application/json;
    return 200 '[{"programId":"31ef5fd8-cef9-4ec0-8304-3018d2cf6c9c","programName":"Essential Medicines","programCode":"EM","periodsSkippable":false,"skipAuthorization":false,"showNonFullSupplyTab":true,"supportStartDate":null,"locallyFulfilled":false}]';
  }
  location ~ /api/users/[^/]+/fulfillmentFacilities {
    default_type application/json;
    return 200 '[{"id":"28de536f-b826-4eeb-a3c4-d65221a1120d","name":"Maseru District Clinic A","code":"MC-A","active":true,"geographicZone":{"id":"d7b0f7a9-65c4-4e8f-bb8a-4b2a3b9c1d02","name":"Maseru"},"type":{"id":"facility-type-health-center","name":"Health Center"}}]';
  }
  location = /api/programs {
    default_type application/json;
    if ($arg_access) {
      return 200 '[{"id":"31ef5fd8-cef9-4ec0-8304-3018d2cf6c9c","name":"Essential Medicines","code":"EM","active":true,"periodsSkippable":false,"skipAuthorization":false,"showNonFullSupplyTab":true,"enableDatePhysicalStockCountCompleted":false}]';
    }
    proxy_pass http://referencedata;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
  }
  location ~ /api/facilities/?$ {
    if ($arg_minimal = "true") {
      set $args "page=0&size=2000";
    }
    proxy_pass http://referencedata;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
  }
  location ~ /localeSettings {
    default_type application/json;
    return 200 '{}';
  }
  location ~ /api/featureFlags {
    default_type application/json;
    return 200 '{}';
  }
  location ~ /api/settings {
    default_type application/json;
    return 200 '{}';
  }
  location = /api/currencySettings {
    default_type application/json;
    return 200 '{"currencyCode":"LSL","currencySymbol":"M","currencySymbolSide":"left","currencyDecimalPlaces":2,"groupingSeparator":",","groupingSize":3,"decimalSeparator":"."}';
  }
  location ~ "^/\\{\\{" {
    return 200 '';
  }
  location = /openlmis.js {
    proxy_pass http://reference-ui;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header Accept-Encoding "";
    sub_filter_types application/javascript text/javascript;
    sub_filter '<form ng-submit="vm.doLogin()">' '<form ng-submit="vm.doLogin()" novalidate>';
    sub_filter_once on;
  }
  location = / {
    proxy_pass http://reference-ui;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header Accept-Encoding "";
    sub_filter '<head>' '<head><script>window.applicationCache=window.applicationCache||{addEventListener:function(){},removeEventListener:function(){},update:function(){},status:0,UNCACHED:0,IDLE:1,CHECKING:2,DOWNLOADING:3,UPDATEREADY:4,OBSOLETE:5};</script>';
    sub_filter_once on;
  }"""

def generate():
    pairs = parse_kv()
    PARAM  = r'[\w-]+'
    ALL    = r'.+'

    no_param, with_param, with_all, global_all = [], [], [], []
    for path, upstream in pairs:
        if path == '' or GLOBAL_ALL_RE.fullmatch(path):
            global_all.append((path, upstream))
        elif ALL_RE.search(path) and not GLOBAL_ALL_RE.fullmatch(path):
            with_all.append((path, upstream))
        elif PARAM_RE.search(path):
            with_param.append((path, upstream))
        else:
            no_param.append((path, upstream))

    lines = []

    # Map + rate limit
    lines.append('''\
map $http_host $allowlisted_ip {
    default 1;
    "localhost" 0;
    "~^localhost" 0;
    "nginx" 0;
    "openlmis-nginx" 0;
    "~^openlmis" 0;
    "~lesotho-bkm" 0;
    "0.0.0.0" 0;
    "~^184\\.168\\.122\\.221" 0;
}

map $allowlisted_ip $limit_key {
    0 "";
    1 $binary_remote_addr;
}

limit_req_zone $limit_key zone=mylimit:32m rate=100r/s;
''')

    lines.append(upstreams_block())
    lines.append('')

    lines.append('''\
log_format upstream_time '$remote_addr - $remote_user [$time_local] '
                 '"$request" $status $body_bytes_sent '
                 '"$http_referer" "$http_user_agent" '
                 '$request_time $upstream_connect_time '
                 '$upstream_header_time $upstream_response_time '
                 '$pipe $bytes_sent $request_length';
''')

    lines.append('''\
server {
  listen 80;
  gzip off;
  access_log /dev/stdout upstream_time;
  error_log /dev/stderr warn;
  server_name localhost;
  client_max_body_size 100m;
  proxy_connect_timeout 300s;
  proxy_send_timeout 600s;
  proxy_read_timeout 600s;
  proxy_set_header Connection "";
  proxy_http_version 1.1;
  send_timeout 600s;

  limit_req zone=mylimit burst=50 nodelay;
  limit_req_log_level warn;
  limit_req_status 429;
''')

    lines.append(STUBS)
    lines.append('')

    # Non-param locations
    lines.append('  # -- KV routes: simple paths -------------------------------------------------')
    for path, upstream in no_param:
        if path == '':
            continue  # handled by the = / stub above
        lines.append(loc(path, upstream))

    # {param} locations
    lines.append('\n  # -- KV routes: {param} paths ------------------------------------------------')
    for path, upstream in with_param:
        p = PARAM_RE.sub(lambda m: PARAM, path)
        lines.append(loc(p, upstream))

    # <all> non-global
    lines.append('\n  # -- KV routes: <all> wildcard paths -----------------------------------------')
    for path, upstream in with_all:
        p = ALL_RE.sub(lambda m: ALL, path)
        lines.append(loc(p, upstream))

    # Global <all> - comes last
    lines.append('\n  # -- KV routes: global wildcard -----------------------------------------------')
    for path, upstream in global_all:
        if GLOBAL_ALL_RE.fullmatch(path):
            lines.append(f'  location ~ / {{\n    proxy_pass http://{upstream};\n    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;\n  }}')
            lines.append(f'  location ~ /.+$ {{\n    proxy_pass http://{upstream};\n    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;\n  }}')

    lines.append('}')
    return '\n'.join(lines)

if __name__ == '__main__':
    sys.stdout.buffer.write(generate().encode('utf-8'))
    sys.stdout.buffer.write(b'\n')
