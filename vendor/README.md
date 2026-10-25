# Browser preview package

Source: the separate browser/ package in the time_estimator repository.
Source commit: a4660a018a076515b8a1c784bb8a07cd48ca5451.
Package: @time-estimator/browser-preview 0.2.0 (private).
Archive SHA-256: 43a26a14d302adf04c799dea22484070759e0dfcc3371c02dedbe6462fd8bd9f.

The archive contains the reusable JavaScript API, declarations, optional Three.js overlay,
notices and provisioning tools. It contains no Orca binary, native/server estimator or
PrintHive-specific importer. Browser engine assets are separately checksum-provisioned
by preview:runtime and are not committed here.

To update, pack the authoritative browser/ source, copy the archive with a content-hash
suffix, change the file dependency in package.json, and run bun install. Keep its declared
source commit and archive hash synchronized. Local integration does not authorize publishing.
