# Printer settings for browser estimates

Edit these files to change the settings sent to the local slicer:

| Printer | Editable file | Preview space (mm) |
| --- | --- | --- |
| Prusa Core ONE+ | [core-one.json](../public/preview-profiles/core-one.json) | 250 × 220 × 270 |
| Bambu H2D, one nozzle | [h2d.json](../public/preview-profiles/h2d.json) | 325 × 320 × 325 |

The viewer uses Core ONE whenever the rotated, scaled model fits all three axes.
Otherwise it selects H2D and loads **H2D's own settings**. If neither printer fits,
the estimate is unavailable. It never enlarges the physical bed. The H2D preview
uses one nozzle's space, rather than the 350 mm combined width of both nozzles.
The print-time row identifies the selected printer. This is an estimate choice;
it does not assign the submitted job to that printer.

## Editing a profile

Keep `schemaVersion: 1` and the file's `printerId`. Give the settings a descriptive
`id`, `label` and `basis`, then edit `configuration` using Orca 2.4.2 setting names
and serialized values. For example, add or replace these entries inside that object:

```json
{
  "outer_wall_speed": ["80"],
  "inner_wall_speed": ["120"],
  "filament_max_volumetric_speed": ["12"],
  "support_threshold_angle": "35"
}
```

Speeds use mm/s; volumetric flow uses mm³/s; the threshold uses degrees. Preserve
array versus scalar types. This fragment is an example, not a recommended printer
calibration. Reload the browser page after editing. Development serves the files
directly; a production install must be rebuilt and restarted to serve changed files.

The supplied files are **starter profiles**, using Orca's typed engine defaults
plus their declared overrides for a 0.4 mm nozzle and PLA. They are not tuned
production presets, and no physical time calibration is claimed. Replace the
configuration with your resolved printer/process/filament settings when available.
Inventory material/color names alone do not select a filament preset.

The browser accepts one nozzle and one filament with the default support style.
Desktop presets containing `inherits` must be resolved first: copying a child
preset alone would omit its parent settings. Unknown or substituted configuration
keys are rejected by the engine. Do not put passwords, network addresses or access
codes in these public files. Printer start/end G-code is unnecessary for this
print-body estimate; startup and finish time are excluded.

## Which values win?

1. The selected printer's JSON provides the engine configuration.
2. The physical bed limits are set from PrintHive's fleet definitions.
3. The form's effective layer height, infill and support choice override those
   entries. A file's explicit settings take precedence over Default settings.

Thus editing a speed, acceleration, cooling or support geometry option in JSON
changes the engine input, while the form still owns its visible choices.

Profiles load once per printer per page, without using a stale browser HTTP copy.
Completed preview cache keys include the entire effective profile, so changed
configuration cannot match an old settings key. Reloading clears that page's cache.
A missing, malformed or wrong-printer profile produces an unavailable estimate and
a message. It never silently borrows the other printer's settings. STL submission
continues to work when preview settings are unavailable.

## Implementation decision and checks

On 26 October 2026 the integration was checked against the bundled browser library
0.5.0 and its Orca 2.4.2 engine, pinned to
`8500fcdccaa10b5099ac20d252af3a7c560046f1`. Orca defines typed options in
[PrintConfig.cpp](https://github.com/OrcaSlicer/OrcaSlicer/blob/8500fcdccaa10b5099ac20d252af3a7c560046f1/src/libslic3r/PrintConfig.cpp).
The bundled library initializes those defaults, applies an effective configuration,
and rejects unresolved inheritance and configuration substitutions. The upstream
H2D machine preset describes two nozzles, so it cannot be copied unchanged into
this single-nozzle browser adapter.

Separate JSON files keep operator configuration outside the form and avoid an
additional settings editor. The server estimator and reusable browser package
remain separate and unchanged. A desktop-preset importer and material-specific
profile selection are not implemented here.

Unit checks validate profile identity, supported structure and printer selection.
The browser regression sends distinct edited speeds through the actual worker and
native engine for Core ONE and H2D, checks cache reuse on return, and covers missing
and misidentified profiles plus successful submission without a working preview.
The form regression also checks that an invalid scale reveals its file's collapsed
options, while required title/email validation still blocks invalid submissions.


A focused same-host check on the supplied 688-triangle case used fresh workers,
the same engine, scale and bed, with previously served engine assets available in
the browser HTTP cache. One request with the previous generic printer metadata
took 12.25 seconds; one with the new Core ONE metadata took 14.52 seconds. Each
started one fast task and returned the same 4,493.42-second estimate and 52,257
support vertices. This narrow comparison does not establish performance equivalence
or physical accuracy. It does show that the former 10-second supplied-file test
limit also fails for the previous settings under these conditions. Those two
functional assertions now use the existing 45-second preview timeout; they are
not latency benchmarks.
