# Orca-derived preview profiles

`core-one.json` and `h2d.json` contain adapted configuration data from
[OrcaSlicer 2.4.2](https://github.com/OrcaSlicer/OrcaSlicer/tree/8500fcdccaa10b5099ac20d252af3a7c560046f1/resources/profiles).
Upstream OrcaSlicer contributors retain their copyrights. OrcaSlicer is distributed
under the GNU Affero General Public License, version 3; see [LICENSE.txt](LICENSE.txt).

[sources.json](sources.json) identifies every input preset, immutable source URL and
SHA-256, the selected printer/process/filament combination, and omitted desktop or
obsolete keys. Complete original source is available through those links. The
adaptation code is `scripts/import-preview-profiles.mjs` in the PrintHive source.

Changes: resolved parent presets; selected stock 0.4 mm / Generic PLA and H2D's
right standard nozzle; retained normal/quiet machine-limit pairs; normalized typed
values and legacy aliases; removed desktop selection data, options discarded by the
pinned engine and custom G-code; selected the browser's default support style;
disabled prime towers; used absolute extrusion addressing and one physical bed.
These are print-body estimation settings, not printer-ready G-code profiles.
