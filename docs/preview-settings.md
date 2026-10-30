# Printer settings for browser estimates

The browser uses resolved **OrcaSlicer 2.4.2 presets**, with stock 0.4 mm nozzles
and Generic PLA. It selects Core ONE whenever the oriented, scaled model fits;
otherwise it uses H2D. The print-time row identifies the selected printer. This
estimate choice does not assign the submitted job to a printer.

| Printer | Editable file | Process basis | Preview space (mm) |
| --- | --- | --- | --- |
| Prusa Core ONE+ | [core-one.json](../public/preview-profiles/core-one.json) | 0.20mm SPEED @CORE One 0.4 | 250 × 220 × 270 |
| Bambu H2D, right standard nozzle | [h2d.json](../public/preview-profiles/h2d.json) | 0.20mm Standard @BBL H2D | 325 × 320 × 325 |

The presets include inherited speeds, accelerations, line widths, shell settings,
material flow limits and cooling settings. Generic PLA limits volumetric flow to
15 mm³/s on Core ONE and 12 mm³/s on H2D. Core ONE uses Orca's CORE One standard-flow
preset as the baseline for this fleet's ONE+; it is not a separate ONE+ calibration.
The H2D profile selects the right standard nozzle, not the high-flow variant or the
350 mm combined dual-nozzle space. A model that fits neither printer has no estimate.

## Editing and refreshing profiles

Edit `configuration` in the selected JSON using Orca 2.4.2 setting names and
serialized values. Keep `schemaVersion: 1`, `printerId` and descriptive `id`,
`label` and `basis` values. For example:

```json
{
  "outer_wall_speed": "80",
  "default_acceleration": "3000",
  "filament_max_volumetric_speed": ["12"],
  "support_threshold_angle": "35"
}
```

Speeds use mm/s, acceleration mm/s², flow mm³/s, and the support threshold degrees.
Preserve scalar versus array types. This example is an illustration, not a printer
calibration. Reload the page after editing; production installs need a rebuild and
restart. These public files must never contain printer credentials or network details.

To reproduce the shipped presets from official immutable upstream files:

```sh
bun run preview:runtime
node scripts/import-preview-profiles.mjs
```

This overwrites both JSON files and `sources.json`, including local operator edits.
The importer resolves every printer/process/filament parent before combining the
settings. A missing parent, identity mismatch, inheritance cycle or download failure
stops the update. It uses the checksummed browser engine's option definitions for
types, converts the pinned legacy aliases, and records omitted desktop/obsolete
keys. The website does not fetch presets or run this importer at runtime.

## Which values win?

1. The selected printer's JSON provides engine settings.
2. PrintHive's fleet definitions provide physical bed limits.
3. The form's effective layer height, infill and support choice override the profile.
   A per-model support angle overrides `support_threshold_angle`; blank preserves it.
   Per-model settings override Default settings.

Profiles are fetched again on file selection, printer changes and retry, with stale HTTP
copies disabled. A response is bound to that file/printer/retry; old settings cannot start
a new estimate. The completed
preview cache includes the entire effective configuration, so changed settings cannot
reuse a previous settings result. Reloading clears the page cache. Missing, invalid,
unresolved, incomplete or wrong-printer profiles make estimates unavailable; submission
still works. Timing-critical speeds, machine limits, volumetric flow and cooling options
must be explicit. An omitted flow limit is rejected instead of inheriting Orca’s generic 2
mm³/s cap; explicit zero still means unlimited flow.

## Source and adaptation decision — 26 October 2026

The source is [OrcaSlicer 2.4.2, revision 8500fcd](https://github.com/OrcaSlicer/OrcaSlicer/tree/8500fcdccaa10b5099ac20d252af3a7c560046f1/resources/profiles),
the same revision as browser library 0.5.0. [sources.json](../public/preview-profiles/sources.json)
records all 21 immutable source paths and SHA-256 values, selected presets, runtime
identity and omitted keys. See [attribution and license](../public/preview-profiles/NOTICE.md).

The alternative of copying only leaf presets loses inherited motion, material and
support settings. Mixing newer presets with the existing engine can change option
semantics. Resolving the matching full chains preserves the available printer-specific
inputs without an engine upgrade or server-library change.

Orca's [PrintConfig.cpp](https://github.com/OrcaSlicer/OrcaSlicer/blob/8500fcdccaa10b5099ac20d252af3a7c560046f1/src/libslic3r/PrintConfig.cpp)
defines typed options, legacy conversions, discarded options and extruder-variant
selection. H2D process arrays list left standard/high-flow then right standard/high-flow;
machine-limit arrays retain the normal/quiet pair for the chosen variant. Material
arrays select standard flow. The importer retains these distinctions rather than
blindly taking the first element of every array.

Browser adaptations are explicit: one standard nozzle/material, no prime tower,
custom G-code removed, absolute extrusion addressing, and default support style.
Core ONE's desktop preset requests snug supports; the browser is qualified for the
default regular/organic styles, so that style is deliberately adapted. Settings
unknown to or discarded by the pinned engine are listed in `sources.json` rather
than being represented as active inputs. This is not an unchanged desktop preset.

The fast estimator still approximates model/support paths and cooling. Startup,
finish, tall-part G-code acceleration adjustments and physical calibration are
excluded. Material names/colors in inventory do not select different filament
presets: these estimates assume Generic PLA. Different nozzle hardware, filament,
print process or firmware may need operator profile edits. Real timed prints are
needed to establish whether overall accuracy improved; preset import alone does
not measure that improvement.

## Validation

Unit checks cover inheritance, array replacement, missing/wrong identities and
cycles, H2D standard/high-flow selection, paired machine limits and shipped profile
provenance. Actual-engine checks run both profiles with supports disabled, tree and
regular supports; all six combinations produce finite positive estimates with no
configuration substitutions. Browser regressions cover real worker settings,
Core ONE/H2D selection, cache reuse, missing/bad profiles and submission independence.

## Per-model support angle and older submissions

More settings offers a support overhang angle in whole degrees from 0 through 90.
Blank uses the selected printer profile: 35° for Core ONE and 30° for H2D.
Higher angles generate support under more overhangs. Orca measures the slope from
horizontal. Zero retains Orca's special behavior: regular supports use the overlap
threshold; tree supports use their 30° fallback. These semantics were checked in
the pinned PrintConfig.cpp and regular/tree support implementations on 26 October 2026.

The angle is applied to the same combined support-shape/time task, and the effective
configuration is part of the preview cache key. It does not trigger a second slice.
A completed result with no support shapes displays a prominent **No supports needed**
notice in either view, with no empty layer slider. Supports switched off is a separate
state and never produces that notice.

Migration 005 adds a nullable `support_angle` column with a 0–90 integer constraint.
It does not rebuild or delete rows. Older submissions retain their settings, file
references, statuses and event history; NULL means printer default. Old API clients
can omit the field. New single/batch submissions accept an integer or NULL; an
explicit NULL in a batch item clears any batch-level angle. Operators see the saved
angle or Printer default. Run normal startup migrations before serving the new code.

Migration checks cover old submissions in every status, session/operator retention,
indexes and foreign keys, and repeat migration execution. The browser check uses a
45° leaning bar: regular supports are empty at the Core ONE default 35°, while 80°
generates them with both tree and regular supports. The imported tree settings also
support this bar at 35°; generated polygons match the same engine’s full-preparation
reference at both 35° and 80° for both support types. It checks file isolation, cached return to default,
invalid-input recovery and the saved operator instructions.

## Timing investigation — 30 October 2026

Six local models, both printers and all three support choices gave 36 comparisons
with full Orca 2.4.2 slicing at the same orientation, scale, 0.2 mm layers and 15%
infill. Earlier starter configurations were +6.97% to +252.14% above the intended
printer-profile Orca references (median +109.13%). Those starters inherited a
2 mm³/s generic flow cap and generic motion settings. Current resolved printer
profiles ranged from −30.89% to +1.02%, with 20.27% median absolute difference.
The old/current comparison deliberately changes configuration; only the current
same-profile comparison measures the fast surrogate’s disagreement with Orca.

The browser’s full reference includes G-code generation and native timing, not
another call to the quick predictor. A desktop Orca 2.4.2 control for one model
reported 19 min 8 s versus 19 min 0.11 s in browser full slicing. This is a narrow
cross-check, not physical calibration or proof of desktop parity for every model.
The standalone estimator checkout’s browser timing comparison tool records raw
reports, profile/model hashes and aggregate error automatically. Local source STLs
are not redistributed.

The fix rejects incomplete timing profiles and refreshes valid profiles when a file
is selected or a preview retried. Completed results still reuse identical effective
settings. Reload an old page once to load this code. No blanket divisor or fitted
correction was applied: current settings mostly underestimate this cohort already.
Profiles improve the inputs; remaining surrogate error and actual physical timing
remain unqualified.
