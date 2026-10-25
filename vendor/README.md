# Browser preview package

Source: the separate browser/ package in the time_estimator repository.
Source commit: e9587e80dd23d5cbcb672c56508b99fc587aa93e.
Package: @time-estimator/browser-preview 0.3.1 (private).
Archive SHA-256: 1d01f7a595ec8c43ae6ba0eec0ac4f2638ee21a8727becaea0f99ff198f20533.

The archive contains the reusable JavaScript API, declarations, pose/STL export, optional
Three.js renderer, prebuilt C++ STL importer, dependency notices and provisioning tools. A pinned MIT-licensed SHA-256 fallback supports ordinary HTTP development origins while retaining checksum verification.
The importer is compiled independently from the existing source-matched STL repair program.
It does not link the native/server estimator. Full Orca slicing engine assets are separately
checksum-provisioned by preview:runtime and are not committed here.

To update, pack the authoritative browser/ source, copy the archive with a content-hash
suffix, change the file dependency in package.json, and run bun install. Keep its declared
source commit and archive hash synchronized. Local integration does not authorize publishing.
