# Browser preview package

Source: the separate browser/ package in the time_estimator repository.
Source commit: 3feddf30454b50175f51a092c2627d312cf9cf36.
Package: @time-estimator/browser-preview 0.5.0 (private).
Archive SHA-256: 0c616838ed2ff250c8aecd5d1762157cd164a0d00126e9e93270863289f781d4.

The reusable package includes the source-built serial Orca browser engine, native C++
combined model/support pricing, solid support renderer, STL importer, pose/export tools,
build identities and upstream notices. One worker request prepares model sections and
support regions once; it does not generate support toolpaths or export G-code.
The browser engine is built separately and does not link the native/server estimator SDK.
preview:runtime copies the bundled, checksummed assets into the static directory.
No server slicing or cache service is introduced.

To update, pack the authoritative browser/ source, use an archive filename with its content
hash, change the dependency in package.json, and run bun install. Keep this source commit
and archive hash synchronized. Local integration does not authorize publishing.
