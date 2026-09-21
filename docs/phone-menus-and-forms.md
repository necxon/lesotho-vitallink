# Phone menus and forms

How the Android app's menus are configured, why the menu was cut from 20 items
to 6, what the portal preview can and cannot tell you, and how to check the
whole chain before a phone ever sees it.

## The chain a phone walks

Nothing about the app's menus lives in the APK. The app fetches all of it at
startup:

```
Composition (identifier "app")            one manifest of everything
  -> Binary  navigation                   the side menu and the bottom sheet
      -> menu item actions
          LAUNCH_REGISTER   -> register config Binary
          LAUNCH_QUESTIONNAIRE -> Questionnaire
  -> Binary  register configs   x20
  -> Binary  translations       x3
  -> Questionnaire              x13
  -> StructureMap               x17
```

Every one of those is a resource on HAPI. A menu item can therefore look
perfectly correct in the config and still do nothing on the phone, because the
thing it points at was never uploaded. `make test-menus` is the check for that.

## Why the menu was too long

The drawer renders **two** lists, in `AppDrawer.kt`:

| Line | What it draws |
|---|---|
| 206 | the bottom-sheet register switcher |
| 221 | `staticMenu.filter { it.visible }` |

Fourteen registers - ANC, PNC, Family Planning, Child Health, HIV, TB,
Hypertension, Diabetes, Mental Health, Asthma, Cancer, Epilepsy, Stroke,
Paralysis - were listed in **both**. Every health worker saw the same fourteen
registers twice, in two different places, on a phone screen.

Removing them from `staticMenu` took the side menu from 20 items to 6, of which
5 are visible. Nothing became unreachable: the bottom sheet still offers all
fourteen, which is what that control is for.

```
make nav-simplify        # show what would change
python scripts/simplify_nav.py --apply
```

The script edits `staticMenu` only and validates the document's shape before and
after. That matters more than it sounds: `bottomSheetRegisters` is a single
OBJECT, not a list, and code that iterates it as a list rewrites it to
`["display","visible",...]`, after which the app dies on launch with
`JsonDecodingException: Expected '{' but had '['`. That has taken prod down
before.

HAPI versions the Binary, so a mistake is recoverable:

```
curl http://localhost:8079/fhir/Binary/<id>/_history
curl http://localhost:8079/fhir/Binary/<id>/_history/<n> > good.json
curl -X PUT -H 'Content-Type: application/json' --data @good.json \
     http://localhost:8079/fhir/Binary/<id>
```

A device that already cached a bad config keeps crashing until its data is
cleared, so always verify on the server before letting phones re-sync.

## Where the menu is edited

The app menu and the forms it launches now live on one page: **Phone Menus**
(`#/questionnaires`), with the menu on its **App Nav** tab. A menu item launches
one of the questionnaires listed on the same page, so keeping them on separate
pages meant editing two places to make one change.

`#/navigation` still resolves and redirects to `#/questionnaires/nav`, which
opens straight onto the menu, so older bookmarks land in the right place.

### Seeing the menu without a device

The App Nav tab draws a simulation of the drawer from the live config. It
follows the order `AppDrawer.kt` composes it in, which is not the order the
editable list below it uses:

1. a `REGISTERS` heading, only when `clientRegisters` has more than one entry
2. `clientRegisters.filter { it.visible }`
3. the bottom-sheet entry, with a chevron, because it opens a sheet not a screen
4. a divider
5. `staticMenu.filter { it.visible }`

Labels are resolved as the app resolves them: `{{some.key}}` is looked up in the
translation bundle, which is found through the Composition's `strings` section
rather than a hardcoded Binary id. A key with no translation is highlighted and
listed, because on the phone it renders as literal braces in the menu.

It is the menu only. Counts show 0 - those come from the device database - and
it does not render the registers themselves. `make test-menus` is what confirms
each item actually leads somewhere.

## Per-role menus do not work

This is worth stating plainly, because both the config and the portal used to
imply otherwise.

The app filters the menu on exactly one thing: `it.visible`.
`NavigationMenuConfig` has these fields and no others:

```
id, visible, enabled, menuIconConfig, display, showCount, animate, actions
```

There is no `roles` field and no `showWidget` field, in any of the three Android
variants in this repo. The app parses config with `ignoreUnknownKeys = true`, so
the `roles` arrays sitting in `navigation_config.json`, and the `showWidget`
blocks the portal used to write from its "Visible to roles" selector, are
**silently discarded**. An item restricted to one role was shown to everyone.

That selector has been replaced with a plain "Show in the app menu" yes/no,
which is the lever the app actually honours. Leftover role settings are flagged
in red in the item list so nobody mistakes them for a working restriction.

Real per-role menus need one of:

- a change to `AppDrawer` in FHIRCore plus a new APK, or
- the server returning a different navigation Binary depending on the caller's
  token, which needs the app's config fetch routed through the mediator.

Neither is done. `docs/role-based-navigation.md` describes the intended matrix
and predates this finding - read it as a design note, not as a description of
what the app does.

## Previewing forms: LHC-Forms

The portal's **Fill** view renders a Questionnaire with
[LHC-Forms](https://lhncbc.github.io/lforms/), the NLM's reference FHIR
Questionnaire renderer - the same engine behind the NLM Form Builder that the
Phone Menus page already links to for authoring.

### Why it replaced the old renderer

The previous preview was about 170 hand-written lines. It implemented none of
`enableWhen`, `itemControl`, calculated expressions, `repeats` or `initial`
values - and the forms in this deployment use all five:

| Feature | Uses across the 10 questionnaires |
|---|---|
| `enableWhen` | 39 |
| `itemControl` | 44 |
| calculated expressions | 8 |
| `repeats` | 7 |
| `initial` | 12 |

So it drew every question unconditionally. Measured on the live forms:

| Questionnaire | Items | Conditional | Shown initially |
|---|---:|---:|---:|
| Physical Inventory Count and Stock Supply | 22 | 12 | 8 |
| BKM Add Family Member Registration | 22 | 4 | 11 |
| BKM Family Registration | 14 | 4 | 10 |
| BKM Remove Family Member Form | 9 | 5 | 1 |
| Order Supplies | 3 | 0 | 3 |

The last row is the control: a form with no conditional logic renders every
item, which is how you can tell the others are being hidden deliberately rather
than dropped. A preview that showed 22 questions where the phone shows 8 could
not be used to check anything.

### What it is and is not

It is a close model of the phone, not the phone. The app runs the Android FHIR
SDK's Structured Data Capture renderer - a different implementation of the same
specification. Use the portal preview to catch the mistakes that matter: a
question that never appears, a skip that does not fire, an empty drop-down. Use
a real device for final sign-off.

### The library is vendored

`bkm-web/vendor/lforms/` holds the LHC-Forms bundle, checked in rather than
loaded from a CDN, because the deployment server may have no outbound internet.
It is ~3.8MB, so it is loaded lazily by `bkm-web/js/lforms-loader.js` the first
time a form is opened, not from `index.html`. nginx serves `/vendor/` as
immutable so it is cached rather than re-downloaded on every page load - the
`^~` on that `location` block is load-bearing, because a regex `location`
otherwise wins and applies the portal's `no-store` rule.

See `bkm-web/vendor/lforms/VERSION` for the version and how to update it.

## Testing the menus end to end

```
make test-menus
```

It walks the whole chain above and reports anything that does not resolve. No
browser and no device, so it can run on every change.

What it checks:

- every resource the Composition publishes actually exists on the server
- the navigation document's shape, including the `bottomSheetRegisters` object
- no register appears in both the side menu and the bottom sheet
- every menu item has an id and a display label
- every `LAUNCH_REGISTER` target is a register the Composition publishes
- every `LAUNCH_QUESTIONNAIRE` target is a Questionnaire on the server
- per questionnaire: linkIds unique, every `enableWhen` target resolves to a
  real linkId, every choice item has options, required-and-conditional items
  are flagged for review

A failure means something is broken on the phone. A warning means something
worth a human decision - a required question behind a condition is legitimate
design, but it is also how a form becomes impossible to submit.

Existence is checked by HTTP status and never by parsing the body: config
Binaries are served as their raw content, and the translation files are Java
`.properties`, not JSON. An earlier version of the script decoded every response
and reported six perfectly healthy resources as missing.

### Current state

The six clinical questionnaires the Composition published but never uploaded
have been seeded as placeholders:

```
make seed-questionnaires          # show what is missing
python scripts/seed_clinical_questionnaires.py --apply
```

They are placeholders, not forms. Each is a single display item saying so, and
each is `status: draft` so it stands out from the real `active` forms in the
portal's Status column. Seeding them makes the config internally consistent -
the phone stops requesting resources that 404 - but a health worker who reaches
one sees placeholder text, not a usable form.

The real content is not in this repository and is not publicly available. A
GitHub code search for these ids returns only this repo and one
opensrp/fhircore documentation page; the definitions live on the BKM
implementer's own FHIR server. `scripts/seed.sh` used to seed 24 such stubs
(commit 5ee10ab) and that block was later removed, which is how the dangling
references appeared. The new script derives its list from the live Composition
rather than a hardcoded array, so it cannot drift the same way.

Note the stubs carry no `targetStructureMap` extension. The maps those forms
would reference are themselves missing, so attaching them would swap one
dangling reference for another, and a placeholder has nothing to extract.

### Real forms from the NLM library

The placeholders above exist because the BKM clinical content is unavailable.
For real, complete instruments to demonstrate and test against, standard forms
are imported from the NLM's LHC Forms library at
<https://lhcforms.nlm.nih.gov/lhcforms>:

```
make import-lhc-forms
```

| Id | Form | Items |
|---|---|---:|
| `lhc-55418-8` | Weight and Height tracking panel | 5 |
| `lhc-34566-0` | Vital signs with method details panel | 9 |
| `lhc-44249-1` | PHQ-9 depression assessment | 11 |
| `lhc-69724-3` | PHQ-4 brief depression and anxiety | 5 |
| `lhc-69723-5` | Patient Health Questionnaire, full PHQ | 63 |
| `lhc-69737-5` | GAD-7 anxiety | 8 |
| `lhc-72109-2` | AUDIT-C alcohol use | 4 |

NLM serves these in LForms' own format, not FHIR. The conversion is done by
LHC-Forms itself (`LForms.Util.getFormFHIRData`) - the reference
implementation, already vendored here for the portal preview - driven through
headless Chrome. The browser is needed only to AUTHOR the files; the output is
plain FHIR JSON in `config/fhir-bkm/fhir_content/questionnaire/lhc/`, and
nothing at runtime depends on Chrome.

Ids are `lhc-<loinc>` so re-running updates in place instead of duplicating, and
they are marked `active` while the placeholders stay `draft` - so the portal's
Status column separates real content from filler at a glance.

There is no standalone 15-item PHQ form definition at NLM; `lhc-69723-5` is the
full 63-item PHQ, which contains the PHQ-15 somatic section.

#### Still outstanding

Four failures remain, all StructureMaps the Composition publishes that are not
on the server:

```
Sick Child Registration        StructureMap/737a86d6-...
Sick Child Follow Up Visit     StructureMap/737a86d6-...   (same map)
Child Counter Referral         StructureMap/528a8603-...
Pregnancy Outcome              StructureMap/f78e1da0-...
```

No questionnaire on the server references any of them - they are orphaned
Composition entries. Removing those four sections is therefore the cleaner fix
than seeding stub extraction logic, which would be inert anyway. That is a
config decision, so it has been left alone.

### Checking that forms really render

`make test-menus` checks structure, not rendering. To verify LHC-Forms actually
draws the forms, render them in a headless browser and count the input controls
that appear - remembering that LHC-Forms renders asynchronously, so counting
immediately after `addFormToPage` reports zero controls for a form that is about
to render perfectly. All 10 questionnaires were verified this way.
