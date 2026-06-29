"""Generate dispense_medicine StructureMap JSON from known patterns."""
import json, os

QR = "questionnaireResponse"
BUNDLE = "bundle"

def src(ctx=QR, element=None, variable=None, condition=None):
    s = {"context": ctx}
    if element: s["element"] = element
    if variable: s["variable"] = variable
    if condition: s["condition"] = condition
    return s

def tgt_uuid(ctx, element):
    return {"context": ctx, "contextType": "variable", "element": element, "transform": "uuid"}

def tgt_copy_str(ctx, element, value):
    return {"context": ctx, "contextType": "variable", "element": element, "transform": "copy", "parameter": [{"valueString": value}]}

def tgt_copy_id(ctx, element, var_id):
    return {"context": ctx, "contextType": "variable", "element": element, "transform": "copy", "parameter": [{"valueId": var_id}]}

def tgt_eval(ctx, element, qr_var, expr, variable=None):
    t = {"transform": "evaluate", "parameter": [{"valueId": qr_var}, {"valueString": expr}]}
    if ctx:
        t["context"] = ctx
        t["contextType"] = "variable"
    if element: t["element"] = element
    if variable: t["variable"] = variable
    return t

def tgt_eval_var(var_name, qr_var, expr):
    return {"variable": var_name, "transform": "evaluate", "parameter": [{"valueId": qr_var}, {"valueString": expr}]}

def tgt_create(ctx, element, type_name, variable=None):
    t = {"context": ctx, "contextType": "variable", "element": element, "transform": "create", "parameter": [{"valueString": type_name}]}
    if variable: t["variable"] = variable
    return t

def tgt_create_var(var_name, type_name):
    return {"variable": var_name, "transform": "create", "parameter": [{"valueString": type_name}]}

def tgt_cc(ctx, element, system, code, display, variable=None):
    t = {"context": ctx, "contextType": "variable", "element": element, "transform": "cc",
         "parameter": [{"valueString": system}, {"valueString": code}, {"valueString": display}]}
    if variable: t["variable"] = variable
    return t

def tgt_cc_var(var_name, system, code, display):
    return {"variable": var_name, "transform": "cc",
            "parameter": [{"valueString": system}, {"valueString": code}, {"valueString": display}]}

def tgt_entry(bundle_var="bundle"):
    return {"context": bundle_var, "contextType": "variable", "element": "entry", "variable": "entry"}

def tgt_entry_resource(res_type, var_name):
    return {"context": "entry", "contextType": "variable", "element": "resource", "variable": var_name,
            "transform": "create", "parameter": [{"valueString": res_type}]}

def rule(name, sources, targets=None, rules=None, dependent=None):
    r = {"name": name, "source": sources}
    if targets: r["target"] = targets
    if rules: r["rule"] = rules
    if dependent: r["dependent"] = dependent
    return r

def dep(group_name, variables):
    return {"name": group_name, "variable": variables}

# ── effective date rules (matching physical inventory pattern) ──────────────

def effective_date_rules(obs_var, outer_name, inner_name):
    """Returns the two-level rule for observation.effective = today at midnight."""
    return rule(
        outer_name,
        [src()],
        [tgt_eval_var("current", QR, "now()")],
        [rule(
            inner_name,
            [src("questionnaireResponse")],
            [
                tgt_create(obs_var, "effective", "dateTime", variable="dt"),
                tgt_eval("dt", "value", "current", "$this.value.substring(0,10) + 'T00:00:00+00:00'"),
            ]
        )]
    )

# ── observation component (running balance) ────────────────────────────────

def obs_component_rule(obs_var, balance_var):
    return rule(
        "rule_obs_component",
        [src()],
        [{"context": obs_var, "contextType": "variable", "element": "component", "variable": "component"}],
        [
            rule("rule_comp_code", [src()],
                [tgt_create("component", "code", "CodeableConcept", variable="compCC")],
                [
                    rule("rule_comp_coding", [src()],
                        [tgt_create("compCC", "coding", "Coding", variable="compCoding")],
                        [
                            rule("rule_comp_sys", [src()], [tgt_copy_str("compCoding", "system", "http://snomed.info/sct")]),
                            rule("rule_comp_cod", [src()], [tgt_copy_str("compCoding", "code", "255619001")]),
                            rule("rule_comp_disp", [src()], [tgt_copy_str("compCoding", "display", "Total")]),
                        ]
                    ),
                    rule("rule_comp_text", [src()], [tgt_copy_str("compCC", "text", "Running total/Cumulative sum")]),
                ]
            ),
            rule("rule_comp_qty", [src()],
                [tgt_create("component", "value", "Quantity", variable="compQty")],
                [rule("rule_comp_qty_val", [src()], [tgt_copy_id("compQty", "value", balance_var)])]
            ),
        ]
    )

# ── new Observation (preliminary, balance-after-dispense) ──────────────────

def new_obs_rule(balance_var):
    return rule(
        "rule_new_obs",
        [src()],
        [tgt_entry(), tgt_entry_resource("Observation", "observation")],
        [
            rule("rule_obs_id", [src()], [tgt_uuid("observation", "id")]),
            rule("rule_obs_status", [src()], [tgt_copy_str("observation", "status", "preliminary")]),
            rule("rule_obs_cat", [src()],
                [tgt_cc("observation", "category", "http://snomed.info/sct", "386452003", "Supply management")]),
            rule("rule_obs_code", [src()],
                [tgt_create("observation", "code", "CodeableConcept", variable="code")],
                [
                    rule("rule_obs_coding", [src()],
                        [tgt_create("code", "coding", "Coding", variable="coding")],
                        [
                            rule("rule_obs_code_sys", [src()], [tgt_copy_str("coding", "system", "https://smartregister.org/")]),
                            rule("rule_obs_code_cod", [src()], [tgt_copy_str("coding", "code", "balance-after-dispense")]),
                            rule("rule_obs_code_disp", [src()], [tgt_copy_str("coding", "display", "balance-after-dispense")]),
                        ]
                    ),
                    rule("rule_obs_code_text", [src()], [tgt_copy_str("code", "text", "balance-after-dispense")]),
                ]
            ),
            rule("rule_obs_subject", [src()], [tgt_copy_id("observation", "subject", "commodityGroupReference")]),
            effective_date_rules("observation", "rule_obs_effective", "rule_obs_effective_val"),
            rule("rule_obs_performer", [src()],
                [tgt_eval("observation", "performer", QR, "$this.generalPractitioner.first()")]),
            rule("rule_obs_value", [src()],
                [tgt_create("observation", "value", "Quantity", variable="qty")],
                [rule("rule_obs_qty_val", [src()], [tgt_copy_id("qty", "value", balance_var)])]
            ),
            obs_component_rule("observation", balance_var),
        ]
    )

# ── stockout flag rules ────────────────────────────────────────────────────

def flag_zero_rule():
    return rule(
        "rule_balance_zero",
        [src(QR, variable="stockOut", condition="(newBalance = 0)")],
        None,
        [rule(
            "rule_no_flag",
            [src(QR, element="item", variable="noFlag",
                 condition="((linkId = 'd-flag-id') and (answer.value.empty()))")],
            None,
            [rule("rule_create_stockout_flag", [src()], None, None,
                  [dep("createStockOutFlag", [QR, BUNDLE, "commodityGroupReference"])])]
        )]
    )

def flag_positive_rule():
    return rule(
        "rule_balance_positive",
        [src(QR, variable="endStockOut", condition="(newBalance > 0)")],
        None,
        [rule(
            "rule_flag_exists",
            [src(QR, element="item", variable="flagExists",
                 condition="((linkId = 'd-flag-id') and (answer.value.exists()))")],
            None,
            [rule(
                "rule_flag_id",
                [src()],
                [tgt_eval_var("flagId", QR, "$this.item.where(linkId = 'd-flag-id').answer.value")],
                [rule(
                    "rule_flag_start_check",
                    [src(QR, element="item", variable="flagStartCheck",
                         condition="((linkId = 'd-flag-start-date') and (answer.value.exists()))")],
                    None,
                    [rule(
                        "rule_update_stockout_flag",
                        [src()],
                        [tgt_eval_var("flagStart", QR, "$this.item.where(linkId = 'd-flag-start-date').answer.value")],
                        None,
                        [dep("updateStockOutFlag", [QR, BUNDLE, "flagId", "flagStart"])]
                    )]
                )]
            )]
        )]
    )

# ── MedicationDispense ──────────────────────────────────────────────────────

def medication_dispense_rule():
    return rule(
        "rule_md",
        [src()],
        [tgt_entry(), tgt_entry_resource("MedicationDispense", "md")],
        [
            rule("rule_md_id", [src()], [tgt_uuid("md", "id")]),
            rule("rule_md_status", [src()], [tgt_copy_str("md", "status", "completed")]),
            rule("rule_md_medication", [src()],
                [tgt_create("md", "medication", "CodeableConcept", variable="medCC")],
                [rule("rule_md_med_text", [src()], [tgt_copy_id("medCC", "text", "commodityName")])]
            ),
            rule("rule_md_subject", [src()],
                [tgt_create("md", "subject", "Reference", variable="subRef")],
                [rule("rule_md_sub_ref", [src()],
                    [tgt_eval("subRef", "reference", QR, "'Patient/' + patientId")])]
            ),
            rule("rule_md_performer", [src()],
                [{"context": "md", "contextType": "variable", "element": "performer", "variable": "perf"}],
                [rule("rule_md_actor", [src()],
                    [tgt_eval("perf", "actor", QR, "$this.generalPractitioner.first()")])]
            ),
            rule("rule_md_quantity", [src()],
                [tgt_create("md", "quantity", "Quantity", variable="mdQty")],
                [
                    rule("rule_md_qty_val", [src()], [tgt_copy_id("mdQty", "value", "dispensedQty")]),
                    rule("rule_md_qty_unit", [src()], [tgt_copy_str("mdQty", "unit", "units")]),
                ]
            ),
            rule("rule_md_when", [src()],
                [tgt_eval("md", "whenHandedOver", QR, "now()")]),
        ]
    )

# ── update latest observation ──────────────────────────────────────────────

def update_latest_obs_rule():
    return rule(
        "rule_check_latest_obs",
        [src(QR, element="item", variable="latestObs",
             condition="((linkId = 'd-observation-id') and (answer.value.exists()))")],
        None,
        [rule(
            "rule_update_obs",
            [src()],
            [tgt_eval_var("latestObsId", QR, "$this.item.where(linkId = 'd-observation-id').answer.value")],
            None,
            [dep("updateLatestObservation", [QR, BUNDLE, "latestObsId"])]
        )]
    )

# ── build the full StructureMap ───────────────────────────────────────────

SM_ID = "f7a8b9c0-d1e2-3f4a-5b6c-7d8e9f0a1b2c"

sm = {
    "resourceType": "StructureMap",
    "id": SM_ID,
    "url": f"https://fhir.labs.smartregister.org/fhir/StructureMap/{SM_ID}",
    "name": "Dispense Medicine",
    "status": "active",
    "structure": [
        {"url": "http://hl7.org/fhir/StructureDefinition/QuestionnaireResponse", "mode": "source"},
        {"url": "http://hl7.org/fhir/StructureDefinition/Bundle", "mode": "target"},
    ],
    "group": [
        # ── group 1: entry point ──────────────────────────────────────────
        {
            "name": "dispenseMedicine",
            "typeMode": "none",
            "input": [
                {"name": QR, "type": "QuestionnaireResponse", "mode": "source"},
                {"name": BUNDLE, "type": "Bundle", "mode": "target"},
            ],
            "rule": [
                rule("rule_bundle_id", [src()], [tgt_uuid(BUNDLE, "id")]),
                rule("rule_bundle_type", [src()], [tgt_copy_str(BUNDLE, "type", "collection")]),
                rule("rule_bundle_entries", [src()],
                    [tgt_eval_var("commodityGroupReference", QR, "$this.subject")],
                    None,
                    [dep("extractDispense", [QR, "commodityGroupReference", BUNDLE])]
                ),
            ],
        },

        # ── group 2: main dispense logic ──────────────────────────────────
        {
            "name": "extractDispense",
            "typeMode": "none",
            "input": [
                {"name": QR, "type": "QuestionnaireResponse", "mode": "source"},
                {"name": "commodityGroupReference", "type": "Reference", "mode": "source"},
                {"name": BUNDLE, "type": "Bundle", "mode": "target"},
            ],
            "rule": [
                rule(
                    "rule_quantities",
                    [src()],
                    [
                        tgt_eval_var("currentBalance", QR, "$this.item.where(linkId = 'd-current-balance').answer.value"),
                        tgt_eval_var("dispensedQty", QR, "$this.item.where(linkId = 'd-quantity').answer.value"),
                        tgt_eval_var("patientId", QR, "$this.item.where(linkId = 'd-patient-id').answer.value"),
                        tgt_eval_var("commodityName", QR, "$this.item.where(linkId = 'd-commodity-name').answer.value"),
                    ],
                    [rule(
                        "rule_new_balance",
                        [src()],
                        [tgt_eval_var("newBalance", QR, "(currentBalance - dispensedQty)")],
                        [
                            new_obs_rule("newBalance"),
                            flag_zero_rule(),
                            flag_positive_rule(),
                            medication_dispense_rule(),
                        ]
                    )]
                ),
                update_latest_obs_rule(),
            ],
        },

        # ── group 3: mark previous observation as final ───────────────────
        {
            "name": "updateLatestObservation",
            "typeMode": "none",
            "input": [
                {"name": QR, "type": "QuestionnaireResponse", "mode": "source"},
                {"name": BUNDLE, "type": "Bundle", "mode": "target"},
                {"name": "latestObservationId", "type": "String", "mode": "source"},
            ],
            "rule": [
                rule(
                    "rule_update_obs",
                    [src()],
                    [tgt_entry(), tgt_entry_resource("Observation", "observation")],
                    [
                        rule("rule_update_obs_id", [src()],
                            [tgt_create("observation", "id", "id", variable="obsId")],
                            [rule("rule_update_obs_id_val", [src()],
                                [tgt_copy_id("obsId", "value", "latestObservationId")])]
                        ),
                        rule("rule_update_obs_status", [src()],
                            [tgt_copy_str("observation", "status", "final")]),
                        effective_date_rules("observation", "rule_update_obs_effective", "rule_update_obs_effective_val"),
                    ]
                )
            ],
        },

        # ── group 4: create stockout flag ─────────────────────────────────
        {
            "name": "createStockOutFlag",
            "typeMode": "none",
            "input": [
                {"name": QR, "type": "QuestionnaireResponse", "mode": "source"},
                {"name": BUNDLE, "type": "Bundle", "mode": "target"},
                {"name": "commodityGroupReference", "type": "Reference", "mode": "source"},
            ],
            "rule": [
                rule(
                    "rule_flag",
                    [src()],
                    [tgt_entry(), tgt_entry_resource("Flag", "flag")],
                    [
                        rule("rule_flag_id", [src()], [tgt_uuid("flag", "id")]),
                        rule("rule_flag_status", [src()], [tgt_copy_str("flag", "status", "active")]),
                        rule("rule_flag_cat", [src()],
                            [tgt_cc("flag", "category", "http://snomed.info/sct", "386452003", "Supply management")]),
                        rule("rule_flag_code", [src()],
                            [tgt_cc("flag", "code", "http://snomed.info/sct", "419182006", " Supplies not available")]),
                        rule("rule_flag_subject", [src()],
                            [tgt_copy_id("flag", "subject", "commodityGroupReference")]),
                        rule("rule_flag_period", [src()],
                            [tgt_create("flag", "period", "Period", variable="period")],
                            [rule("rule_flag_period_start", [src()],
                                [tgt_eval("period", "start", QR, "now()")])]
                        ),
                    ]
                )
            ],
        },

        # ── group 5: close stockout flag ──────────────────────────────────
        {
            "name": "updateStockOutFlag",
            "typeMode": "none",
            "input": [
                {"name": QR, "type": "QuestionnaireResponse", "mode": "source"},
                {"name": BUNDLE, "type": "Bundle", "mode": "target"},
                {"name": "flagId", "type": "String", "mode": "source"},
                {"name": "flagPeriodStart", "type": "DateTime", "mode": "source"},
            ],
            "rule": [
                rule(
                    "rule_update_flag",
                    [src()],
                    [tgt_entry(), tgt_entry_resource("Flag", "flag")],
                    [
                        rule("rule_update_flag_id", [src()],
                            [tgt_create("flag", "id", "id", variable="flagIdEl")],
                            [rule("rule_update_flag_id_val", [src()],
                                [tgt_copy_id("flagIdEl", "value", "flagId")])]
                        ),
                        rule("rule_update_flag_status", [src()],
                            [tgt_copy_str("flag", "status", "inactive")]),
                        rule("rule_update_flag_period", [src()],
                            [tgt_create("flag", "period", "Period", variable="period")],
                            [
                                rule("rule_update_flag_period_start", [src()],
                                    [tgt_create("period", "start", "dateTime", variable="startDate")],
                                    [rule("rule_update_flag_start_val", [src()],
                                        [tgt_copy_id("startDate", "value", "flagPeriodStart")])]
                                ),
                                rule("rule_update_flag_period_end", [src()],
                                    [tgt_eval("period", "end", QR, "now()")]),
                            ]
                        ),
                    ]
                )
            ],
        },
    ],
}

out_path = os.path.join(
    os.path.dirname(os.path.abspath(__file__)),
    "..", "config", "fhir-bkm", "fhir_content", "structure_map", "json", "supply_chain",
    "dispense_medicine.json"
)
os.makedirs(os.path.dirname(out_path), exist_ok=True)
with open(out_path, "w", encoding="utf-8") as f:
    json.dump(sm, f, indent=4)
print(f"Written to: {out_path}")
print(f"Total rules (approximate): {json.dumps(sm).count('\"name\"')}")
