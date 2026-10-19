-- BKM surveillance dashboards - checks to run in Superset SQL Lab (database: BKM_Server).
-- Each query says what a healthy answer looks like.

-- NOTE: the file now ends with a real query, so 'Run all' works. Run the queries one at a time to read each result.
-- For the DETAILED dashboards (build with --full) you also need the table questionnaireresponse. Until the pipeline
-- exports QuestionnaireResponse (add it to the pipeline's resource list, restart, run a full load) any query on it
-- fails with 'Table or view not found'. When it exists, check it with:
--   SELECT questionnaire, COUNT(*) FROM questionnaireresponse GROUP BY questionnaire;
--   SELECT i.linkId, i.answer[0].valueString, i.answer[0].valueInteger, i.answer[0].valueDate, i.answer[0].valueCoding.code
--   FROM questionnaireresponse qr LATERAL VIEW explode(qr.item) t AS i
--   WHERE qr.questionnaire LIKE '%23a71526-de52-4252-8268-e99185b14e3b%' LIMIT 20;

-- 1. What the ACTIVITY dashboards read (0 is normal until the forms have been used on production)
SELECT 'EBS signals (Encounter ebs_signal)' AS what, COUNT(*) AS n FROM encounter e
  WHERE exists(e.type, t -> exists(t.coding, c -> c.code = 'ebs_signal'))
UNION ALL
SELECT 'Disease follow-ups (Encounter disease_followup)', COUNT(*) FROM encounter e
  WHERE exists(e.type, t -> exists(t.coding, c -> c.code = 'disease_followup'))
UNION ALL
SELECT 'Disease conditions (SNOMED, encounter-diagnosis, active)', COUNT(*) FROM condition c
  WHERE element_at(c.code.coding, 1).system = 'http://snomed.info/sct'
    AND exists(c.category, cat -> exists(cat.coding, x -> x.code = 'encounter-diagnosis'))
    AND exists(c.clinicalStatus.coding, x -> x.code = 'active');

-- 2. Which kinds of Encounter exist, and how many of each (the two form types should show up once they are used)
SELECT element_at(t.coding, 1).code AS encounter_type, COUNT(*) AS n
FROM encounter e LATERAL VIEW explode(e.type) x AS t
GROUP BY 1 ORDER BY 2 DESC LIMIT 30;

-- 3. Do the Encounters carry the VHW and area tags? (both numbers should be close to the total)
SELECT COUNT(*) AS encounters,
  SUM(CASE WHEN size(filter(e.meta.tag, x -> x.system = 'https://smartregister.org/practitioner-tag-id')) > 0 THEN 1 ELSE 0 END) AS with_vhw_tag,
  SUM(CASE WHEN size(filter(e.meta.tag, x -> x.system = 'https://smartregister.org/location-tag-id')) > 0 THEN 1 ELSE 0 END) AS with_area_tag
FROM encounter e;
