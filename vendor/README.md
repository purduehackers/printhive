# Browser preview package

Source: the separate browser/ package in the time_estimator repository.
Source commit: 0c8be2cd800627056038da04a1be1a48b54b6163.
Package: @time-estimator/browser-preview 0.1.0 (private).
Archive SHA-256: 93e73548a785409c275f3c8582598b6a795e6a8f7064730f9085cca2ecb88ef6.

The archive contains the reusable JavaScript API, declarations, optional Three.js overlay,
notices and provisioning tools. It contains no Orca binary, native/server estimator or
PrintHive-specific importer. Browser engine assets are separately checksum-provisioned
by preview:runtime and are not committed here.

To update, pack the authoritative browser/ source, copy the archive with a content-hash
suffix, change the file dependency in package.json, and run bun install. Keep its declared
source commit and archive hash synchronized. Local integration does not authorize publishing.
