import json
from datetime import datetime, timezone

with open('C:/Users/Neels.Lotter/lesotho-vitallink/config/resources_for_index.txt') as f:
    lines = [l.strip() for l in f if l.strip()]

resources = []
for line in lines:
    parts = line.split('|', 3)
    if len(parts) != 4:
        continue
    hex_uuid, rtype, rid, json_str = parts
    try:
        obj = json.loads(json_str)
        resources.append((hex_uuid, rtype, rid, obj))
    except Exception as e:
        print(f"# SKIP {rid}: {e}")

def esc(s):
    return str(s).replace("'", "''") if s else ''

def token_insert(uuid_hex, rtype, name, path, system, value):
    sys_val = "NULL" if not system else f"'{esc(system)}'"
    return (f"INSERT OR IGNORE INTO TokenIndexEntity (resourceUuid, resourceType, index_name, index_path, index_system, index_value) "
            f"VALUES (X'{uuid_hex}', '{rtype}', '{name}', '{path}', {sys_val}, '{esc(value)}');")

def string_insert(uuid_hex, rtype, name, path, value):
    return (f"INSERT OR IGNORE INTO StringIndexEntity (resourceUuid, resourceType, index_name, index_path, index_value) "
            f"VALUES (X'{uuid_hex}', '{rtype}', '{name}', '{path}', '{esc(value)}');")

def ref_insert(uuid_hex, rtype, name, path, value):
    return (f"INSERT OR IGNORE INTO ReferenceIndexEntity (resourceUuid, resourceType, index_name, index_path, index_value) "
            f"VALUES (X'{uuid_hex}', '{rtype}', '{name}', '{path}', '{esc(value)}');")

def dt_insert(uuid_hex, rtype, name, path, ts_ms):
    return (f"INSERT OR IGNORE INTO DateTimeIndexEntity (resourceUuid, resourceType, index_name, index_path, index_from, index_to) "
            f"VALUES (X'{uuid_hex}', '{rtype}', '{name}', '{path}', {ts_ms}, {ts_ms});")

def parse_ts(dt_str):
    try:
        dt_str = dt_str.replace('Z', '+00:00')
        if '.' in dt_str:
            fmt_part = dt_str.split('.')[0]
            dt = datetime.fromisoformat(fmt_part).replace(tzinfo=timezone.utc)
        else:
            dt = datetime.fromisoformat(dt_str)
        return int(dt.timestamp() * 1000)
    except:
        return 1741435200000

statements = []
statements.append("BEGIN TRANSACTION;")

for (hex_uuid, rtype, rid, obj) in resources:
    meta = obj.get('meta', {})
    last_updated = meta.get('lastUpdated', '2026-03-08T00:00:00+00:00')
    ts = parse_ts(last_updated)

    statements.append(token_insert(hex_uuid, rtype, '_id', f'{rtype}.id', None, rid))
    statements.append(dt_insert(hex_uuid, rtype, '_lastUpdated', f'{rtype}.meta.lastUpdated', ts))

    if rtype == 'Group':
        active = str(obj.get('active', False)).lower()
        gtype = obj.get('type', '')
        name = obj.get('name', '')
        code_list = obj.get('code', {}).get('coding', [])

        statements.append(token_insert(hex_uuid, rtype, 'active', 'Group.active', None, active))
        statements.append(token_insert(hex_uuid, rtype, 'type', 'Group.type', None, gtype))
        if name:
            statements.append(string_insert(hex_uuid, rtype, 'name', 'Group.name', name))
        for c in code_list:
            statements.append(token_insert(hex_uuid, rtype, 'code', 'Group.code', c.get('system', ''), c.get('code', '')))
        me = obj.get('managingEntity', {}).get('reference', '')
        if me:
            statements.append(ref_insert(hex_uuid, rtype, 'managing-entity', 'Group.managingEntity', me))
        for m in obj.get('member', []):
            ref = m.get('entity', {}).get('reference', '')
            if ref:
                statements.append(ref_insert(hex_uuid, rtype, 'member', 'Group.member.entity', ref))
        for ident in obj.get('identifier', []):
            val = ident.get('value', '')
            sys = ident.get('system', '')
            if val:
                statements.append(token_insert(hex_uuid, rtype, 'identifier', 'Group.identifier', sys or None, val))

    elif rtype == 'Patient':
        active = str(obj.get('active', False)).lower()
        gender = obj.get('gender', '')
        bd = obj.get('birthDate', '')
        org = obj.get('managingOrganization', {}).get('reference', '')

        statements.append(token_insert(hex_uuid, rtype, 'active', 'Patient.active', None, active))
        if gender:
            statements.append(token_insert(hex_uuid, rtype, 'gender', 'Patient.gender', None, gender))
        if bd:
            bd_ts = parse_ts(bd + 'T00:00:00+00:00')
            statements.append(dt_insert(hex_uuid, rtype, 'birthdate', 'Patient.birthDate', bd_ts))
        if org:
            statements.append(ref_insert(hex_uuid, rtype, 'organization', 'Patient.managingOrganization', org))
        for name_obj in obj.get('name', []):
            family = name_obj.get('family', '')
            if family:
                statements.append(string_insert(hex_uuid, rtype, 'family', "Patient.name.family", family))
                statements.append(string_insert(hex_uuid, rtype, 'name', 'Patient.name', family))
            for given in name_obj.get('given', []):
                if given:
                    statements.append(string_insert(hex_uuid, rtype, 'given', 'Patient.name.given', given))
                    statements.append(string_insert(hex_uuid, rtype, 'name', 'Patient.name', given))
        for ident in obj.get('identifier', []):
            val = ident.get('value', '')
            sys = ident.get('system', '')
            if val:
                statements.append(token_insert(hex_uuid, rtype, 'identifier', 'Patient.identifier', sys or None, val))

    elif rtype == 'Practitioner':
        active = str(obj.get('active', True)).lower()
        statements.append(token_insert(hex_uuid, rtype, 'active', 'Practitioner.active', None, active))
        for name_obj in obj.get('name', []):
            family = name_obj.get('family', '')
            if family:
                statements.append(string_insert(hex_uuid, rtype, 'family', 'Practitioner.name.family', family))
                statements.append(string_insert(hex_uuid, rtype, 'name', 'Practitioner.name', family))
            for given in name_obj.get('given', []):
                statements.append(string_insert(hex_uuid, rtype, 'given', 'Practitioner.name.given', given))
        for ident in obj.get('identifier', []):
            val = ident.get('value', '')
            sys = ident.get('system', '')
            if val:
                statements.append(token_insert(hex_uuid, rtype, 'identifier', 'Practitioner.identifier', sys or None, val))

    elif rtype == 'PractitionerRole':
        active = str(obj.get('active', True)).lower()
        statements.append(token_insert(hex_uuid, rtype, 'active', 'PractitionerRole.active', None, active))
        prac = obj.get('practitioner', {}).get('reference', '')
        if prac:
            statements.append(ref_insert(hex_uuid, rtype, 'practitioner', 'PractitionerRole.practitioner', prac))
        org = obj.get('organization', {}).get('reference', '')
        if org:
            statements.append(ref_insert(hex_uuid, rtype, 'organization', 'PractitionerRole.organization', org))

    elif rtype == 'Organization':
        active = str(obj.get('active', True)).lower()
        name = obj.get('name', '')
        statements.append(token_insert(hex_uuid, rtype, 'active', 'Organization.active', None, active))
        if name:
            statements.append(string_insert(hex_uuid, rtype, 'name', 'Organization.name', name))
        for ident in obj.get('identifier', []):
            val = ident.get('value', '')
            sys = ident.get('system', '')
            if val:
                statements.append(token_insert(hex_uuid, rtype, 'identifier', 'Organization.identifier', sys or None, val))

    elif rtype == 'Location':
        status = obj.get('status', '')
        name = obj.get('name', '')
        statements.append(token_insert(hex_uuid, rtype, 'status', 'Location.status', None, status))
        if name:
            statements.append(string_insert(hex_uuid, rtype, 'name', 'Location.name', name))
        part_of = obj.get('partOf', {}).get('reference', '')
        if part_of:
            statements.append(ref_insert(hex_uuid, rtype, 'partof', 'Location.partOf', part_of))
        for ident in obj.get('identifier', []):
            val = ident.get('value', '')
            sys = ident.get('system', '')
            if val:
                statements.append(token_insert(hex_uuid, rtype, 'identifier', 'Location.identifier', sys or None, val))

    elif rtype == 'CareTeam':
        status = obj.get('status', '')
        name = obj.get('name', '')
        statements.append(token_insert(hex_uuid, rtype, 'status', 'CareTeam.status', None, status))
        if name:
            statements.append(string_insert(hex_uuid, rtype, 'name', 'CareTeam.name', name))
        for p in obj.get('participant', []):
            member = p.get('member', {}).get('reference', '')
            if member:
                statements.append(ref_insert(hex_uuid, rtype, 'participant', 'CareTeam.participant.member', member))

statements.append("COMMIT;")

sql_path = 'C:/Users/Neels.Lotter/lesotho-vitallink/insert_indexes.sql'
with open(sql_path, 'w') as f:
    f.write('\n'.join(statements))

print(f"Written {len(statements)-2} index statements to {sql_path}")
