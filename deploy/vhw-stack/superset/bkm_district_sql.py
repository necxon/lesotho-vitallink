"""Shared SQL for the Lesotho map: one row per district (ISO code LS-A ... LS-K) with the main counts.

Records in the pipeline point to a village or facility area (the location tag). The districts sit above those in the
Location tree (Root -> district -> ... -> village), so every query first walks up to the district, then to its ISO
code. Superset's Country Map chart ("lesotho") colours the 10 districts by the ISO code in column `iso`.

ISO 3166-2:LS codes used by Superset's bundled lesotho.geojson:
  LS-A Maseru, LS-B Butha-Buthe, LS-C Leribe, LS-D Berea, LS-E Mafeteng,
  LS-F Mohale's Hoek, LS-G Quthing, LS-H Qacha's Nek, LS-J Mokhotlong, LS-K Thaba-Tseka
"""

DISTRICTS = [("LS-A", "Maseru"), ("LS-B", "Butha-Buthe"), ("LS-C", "Leribe"), ("LS-D", "Berea"),
             ("LS-E", "Mafeteng"), ("LS-F", "Mohale’s Hoek"), ("LS-G", "Quthing"), ("LS-H", "Qacha’s Nek"),
             ("LS-J", "Mokhotlong"), ("LS-K", "Thaba-Tseka")]

LOC_TAG = ("element_at(filter({a}.meta.tag, x -> x.system = 'https://smartregister.org/location-tag-id'), 1).code")

# every location id -> its district name (walks up to 3 parents; districts have 'District' in the name)
LOC_DISTRICT_CTE = """loc_district AS (
  SELECT l0.id,
         COALESCE(CASE WHEN lower(l0.name) LIKE '%district%' THEN l0.name END,
                  CASE WHEN lower(l1.name) LIKE '%district%' THEN l1.name END,
                  CASE WHEN lower(l2.name) LIKE '%district%' THEN l2.name END,
                  CASE WHEN lower(l3.name) LIKE '%district%' THEN l3.name END) AS district
  FROM location l0
  LEFT JOIN location l1 ON l1.id = substring_index(l0.partOf.reference, '/', -1)
  LEFT JOIN location l2 ON l2.id = substring_index(l1.partOf.reference, '/', -1)
  LEFT JOIN location l3 ON l3.id = substring_index(l2.partOf.reference, '/', -1))"""

# location id -> ISO code (matches on the district name with everything but letters removed)
ISO_OF_CTE = """iso_of AS (
  SELECT id,
         CASE WHEN k LIKE 'maseru%' THEN 'LS-A' WHEN k LIKE 'butha%' THEN 'LS-B' WHEN k LIKE 'leribe%' THEN 'LS-C'
              WHEN k LIKE 'berea%' THEN 'LS-D' WHEN k LIKE 'mafeteng%' THEN 'LS-E' WHEN k LIKE 'mohale%' THEN 'LS-F'
              WHEN k LIKE 'quthing%' THEN 'LS-G' WHEN k LIKE 'qacha%' THEN 'LS-H' WHEN k LIKE 'mokhotlong%' THEN 'LS-J'
              WHEN k LIKE 'thaba%' THEN 'LS-K' END AS iso
  FROM (SELECT id, lower(regexp_replace(district, '[^a-zA-Z]', '')) AS k FROM loc_district WHERE district IS NOT NULL))"""


def count_cte(name, from_sql, alias, where, distinct=None):
    """CTE: number of rows (or distinct things) per ISO code for one table filtered by `where`."""
    what = f"COUNT(DISTINCT {distinct})" if distinct else "COUNT(*)"
    return (f"{name} AS (\n  SELECT io.iso, {what} AS n FROM {from_sql} {alias}\n"
            f"  JOIN iso_of io ON io.id = {LOC_TAG.format(a=alias)}\n  WHERE {where}\n  GROUP BY io.iso)")


METRICS = [  # (column, label, cte name, from, alias, where, distinct)
    ("people", "People", "c_people", "patient", "p", "p.active = true", None),
    ("children_u5", "Children under 5", "c_kids", "patient", "p",
     "p.active = true AND to_date(p.birthDate) > add_months(current_date(), -60)", None),
    ("households", "Households", "c_hh", "`group`", "g", "g.active = true", None),
    ("overdue_doses", "Overdue vaccine doses", "c_over", "task", "t",
     "array_contains(transform(t.code.coding, c -> c.code), '33879002') AND t.status IN ('ready', 'in-progress') "
     "AND to_date(t.executionPeriod.end) < current_date()", None),
    ("ebs_signals", "EBS signals", "c_ebs", "encounter", "e",
     "exists(e.type, t -> exists(t.coding, c -> c.code = 'ebs_signal'))", None),
    ("followups", "Disease follow-ups", "c_fu", "encounter", "e",
     "exists(e.type, t -> exists(t.coding, c -> c.code = 'disease_followup'))", None),
    ("disease_people", "People with a registered disease", "c_dis", "condition", "c",
     "element_at(c.code.coding, 1).system = 'http://snomed.info/sct' "
     "AND exists(c.category, cat -> exists(cat.coding, x -> x.code = 'encounter-diagnosis')) "
     "AND exists(c.clinicalStatus.coding, x -> x.code = 'active')", "substring_index(c.subject.reference, '/', -1)"),
]


def district_metrics_sql():
    ctes = [LOC_DISTRICT_CTE, ISO_OF_CTE] + [count_cte(c, f, a, w, d) for _, _, c, f, a, w, d in METRICS]
    values = ", ".join(f"('{iso}', '{name}')" for iso, name in DISTRICTS)
    cols = ",\n       ".join(f"COALESCE({c}.n, 0) AS {col}" for col, _, c, *_ in METRICS)
    joins = "\n".join(f"LEFT JOIN {c} ON {c}.iso = d.iso" for _, _, c, *_ in METRICS)
    return ("WITH " + ",\n".join(ctes) + f"\nSELECT d.iso, d.district,\n       {cols}\n"
            f"FROM (VALUES {values}) AS d(iso, district)\n{joins}\nORDER BY d.iso")
