# Browser preview package

Source: the separate browser/ package in the time_estimator repository.
Source commit: e8bddc1ac5790f62a8259ebbf08b942000eb7890.
Package: @time-estimator/browser-preview 0.3.0 (private).
Archive SHA-256: 659ca5cc2bf7dd680c9fa6fab17e5429a9314abb0a19eff088c8782556b711af.

The archive contains the reusable JavaScript API, declarations, pose/STL export, optional
Three.js renderer, prebuilt C++ STL importer, dependency notices and provisioning tools.
The importer is compiled independently from the existing source-matched STL repair program.
It does not link the native/server estimator. Full Orca slicing engine assets are separately
checksum-provisioned by preview:runtime and are not committed here.

To update, pack the authoritative browser/ source, copy the archive with a content-hash
suffix, change the file dependency in package.json, and run bun install. Keep its declared
source commit and archive hash synchronized. Local integration does not authorize publishing.
