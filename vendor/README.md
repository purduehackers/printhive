# Browser preview package

Source: the separate browser/ package in the time_estimator repository.
Source commit: fc82ee9a8f0d6b8d9fabdf26a070228e78cb652a.
Package: @time-estimator/browser-preview 0.4.0 (private).
Archive SHA-256: 312e2a60de84cab285514da5bb7dd7d05a967a307695e47041798de26b9b78e4.

The archive contains the reusable JavaScript API, declarations, pose/STL export, optional
Three.js renderer, prebuilt C++ STL importer and model-body fast estimator, dependency notices and provisioning tools. A pinned MIT-licensed SHA-256 fallback supports ordinary HTTP development origins while retaining checksum verification.
The importer is compiled independently from the existing source-matched STL repair program.
It does not link the native/server estimator. Full Orca slicing engine assets are separately
checksum-provisioned by preview:runtime and are not committed here.

To update, pack the authoritative browser/ source, copy the archive with a content-hash
suffix, change the file dependency in package.json, and run bun install. Keep its declared
source commit and archive hash synchronized. Local integration does not authorize publishing.
