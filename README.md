# PrintHive

An Astro + React 3D printing queue running on Bun. SQLite is accessed through `Bun.SQL`; original STLs stay in a private directory on disk. The public queue lists printing and queued jobs, while operators can download files, manage statuses, and view history. Currently equipped with a Bambu H2D Pro and Prusa Core ONE+.

## Local development

Requires Bun 1.4.2 or newer. All project commands use Bun; the container pins Bun 1.4.3 for the verified production SMTP setup. Database access serializes queries and complete transactions on the single SQLite connection, so concurrent queue updates and background notification delivery also work on Bun 1.4.2/1.4.3.

React and ReactDOM are pinned to 19.2.7. The test suite includes a production-rendering regression check; run it before upgrading that pair.

```sh
bun install --frozen-lockfile
cp .env.example .env
bun -e 'console.log(require("node:crypto").randomBytes(32).toString("hex"))'
```

Put the generated value in `CONFIRMATION_SECRET` in `.env`. Start a local SMTP inbox, for example:

```sh
podman run --rm --name printhive-mailpit -p 127.0.0.1:1025:1025 -p 127.0.0.1:8025:8025 docker.io/axllent/mailpit
bun run dev
```

Open `http://localhost:4321`; email appears in Mailpit at `http://localhost:8025`. Use the exact `APP_ORIGIN` hostname when browsing (including port). Submissions require a `@purdue.edu` address even in development; local Mailpit captures that mail without delivering externally.

Provision the first operator by piping a password from a password manager or protected file into the CLI:

```sh
bun run operator:add your-username < /path/to/protected-password-file
```

Passwords must have 12–1024 characters and are hashed with Argon2id. Running the command again resets that account's password, activates it, and revokes its sessions. The CLI reads stdin, so passwords need not appear in process arguments or shell history.

Signed-in operators can use **Manage operators** on `/operator` to open `/operator/manage-operators`. All operators can add accounts, change usernames, reset passwords, and remove access. Leave the password blank when editing to retain it. Password resets and removals revoke the affected account's sessions; changing your own password or removing your own access signs you out. The last active operator cannot be removed through the UI or API. Removal deactivates the account and preserves its print history; adding the same username again restores that account with a new password. The CLI remains available for account recovery. No database migration is needed for operator management.

## How it works

- A metadata request creates a pending job and returns a short-lived AES-256-GCM upload capability. The browser sends the STL as a raw streamed body, with progress and cancellation. The server independently enforces the 500 MiB limit, declared size, concurrency, upload deadline, and STL structure. It uses bounded file reads/writes and atomically renames validated files.
- A confirmation email is sent synchronously. Submission succeeds only after SMTP accepts it. SMTP failure deletes the pending database row and file. SMTP acceptance does not guarantee inbox delivery. A lost response or ambiguous SMTP failure may leave an unusable email; its link cannot enqueue an incomplete or deleted job.
- Confirmation links contain an encrypted job ID, purpose, version, and expiry. No token is stored in SQLite. Opening a link does not change state; the user must press **Confirm print**. The link and database deadline expire after 24 hours. Repeated confirmation cannot move or reopen a job.
- The queue orders confirmed jobs by queue timestamp, then ID for ties, and refreshes every 15 seconds. Email, notes, original filenames, and downloads are private. Multiple jobs may print at once. Completed, canceled, failed, and rejected jobs remain in operator history.
- Operators use hashed random sessions with a 12-hour expiry. Mutations require the configured origin. Login and reservation requests are rate limited. Status writes compare versions, update history transactionally, and then send email. Email failure produces a visible operator warning and preserves the saved status. There is no automatic retry or durable email outbox.
- Allowed transitions: queued → printing/canceled/failed/rejected; printing → completed/canceled/failed/rejected; completed/canceled/failed/rejected → queued. Requeue adds a job to the end. No-op writes do not email.
- Operators can choose **Reject and return with feedback** for queued or printing jobs. Feedback is required (up to 5,000 characters), saved privately in status history, and sent through the status email system with a link to submit a revised print. Rejection removes the job from the active queue while retaining its file and history. Email failure preserves the rejection and feedback and shows the existing delivery warning. Migration `002_rejected_feedback.sql` adds the rejected status and event feedback while preserving existing jobs and history.
- Preview parsing runs in a worker, reads bounded slices, and samples at most 1,000,000 triangles. Preview cancellation terminates the worker. Three.js resources are released when files change. Orientation and X mirroring are saved into a new STL before submission; each batch file retains its own orientation. Units are assumed to be millimeters. Optional generated support inspection uses a separately packaged browser library and a checksum-pinned Orca WebAssembly engine. The full STL uses Orca's C++ import/repair path in a separate browser worker; display sampling is never slicing input. Each printer has an editable JSON configuration under `public/preview-profiles/`; the selected printer is shown beside its estimate. See [printer settings](docs/preview-settings.md). Tree scenarios do not change an “Operator decides” submission. Support generation has its own size/time budgets and cancellation; submission still works when the preview or engine is unavailable. The server time_estimator library is not a browser dependency.

## Operator notifications and Android installation

Operators can enable desktop and Android Chrome push alerts under **Print alerts** at the bottom of `/operator`. Each browser/device opts in separately. A confirmed submission sends an alert showing its submission name, file count and submitter email; a batch sends one alert for all its files. Copies do not increase the file count. Migration `009_push_submission_details.sql` preserves these details for retries and backfills existing outbox entries. Pending uploads, confirmation-link previews, requeues and other status changes do not send new-print alerts. Click an alert to open the authenticated operator queue. The dashboard also checks for changes every 15 seconds and offers **Refresh queue**, preserving selections until the operator refreshes.

**Server setup (administrator):** Before operators can enable notifications, generate a VAPID key pair once with `bun run push:keys` (or `podman exec printhive bun run push:keys` for an existing container). Add the generated values and a real administrator contact to the server's runtime environment:

```dotenv
VAPID_PUBLIC_KEY=GENERATED_PUBLIC_KEY
VAPID_PRIVATE_KEY=GENERATED_PRIVATE_KEY
VAPID_SUBJECT=mailto:operator@example.org
```

Apply the updated environment by restarting the Quadlet service (`systemctl --user restart printhive.service`) or recreating a manually managed container with its updated environment file and existing data volume. `podman restart` alone does not reload an `--env-file`. Serve the app over HTTPS and allow outbound HTTPS to browser push services. Operators can then enable notifications and use **Send test** on each device.

Leave all three values unset to disable push; incomplete or mismatched configuration fails startup validation. Retain the keys across deployments, keep the private key secret, and do not commit them. Rotating the keys requires devices to enable notifications again. No Firebase project is needed.

On Android, open the HTTPS site in Chrome and use its menu to install PrintHive (depending on Chrome, **Install and create shortcut → Install** or **Add to home screen → Install**). Launch it from its icon, sign in and choose **Enable notifications**. Installation does not grant notification permission. Use **Send test** to check the device; both browser/site and Android notification settings must permit alerts. Push can work while the Android app is closed; desktop delivery requires the browser to be running, possibly in the background. Delivery/presentation can be delayed or suppressed by connectivity, power settings or Do Not Disturb. The queue is authoritative.

Subscriptions survive the 12-hour web session so personal devices can receive background alerts. Signing out revokes that browser's subscription; password resets (including the provisioning CLI), account removal and account reactivation revoke all affected subscriptions. A different operator signing in on the same browser revokes its previous operator's device subscription. Private pages still require a valid login. No authenticated pages, models or preview engine assets are cached for offline use.

Migration `008_operator_push.sql` adds device subscriptions and a durable outbox. Queue transitions and recipients are committed together. The web process starts its dispatcher on its first request (including `/api/health`), processes up to four deliveries at a time, retries temporary failures, removes expired subscriptions and expires alerts after one hour. Restarted processes recover pending deliveries after their 30-second leases expire. A push-service acceptance is not proof the device displayed an alert, and interrupted deliveries can be repeated. Stable notification tags reduce duplicate alerts. Logs record sanitized `push.delivery_failed` / `push.dispatch_failed` events without subscription endpoints or keys. The regular cleanup command also removes expired outbox events.

## Verification

The push-only service worker activates updates immediately, including while app windows remain open; it never reloads or caches operator pages. **Send test** includes the latest confirmed print thumbnail when available. Windows receives the same small file as a notification picture as well as its icon; the OS controls the final layout. Android installations created before the white theme change can retain the old native navigation-bar color until Chrome updates their installed wrapper. For local testing, Chrome's `about://webapks` page provides **Update PrintHive Operators**; close and reopen PrintHive to trigger the update check.

New submissions include 128 × 128 PNG model thumbnails, displayed at 36 pixels on the operator dashboard and used as notification icons when the browser supports them. Dashboard backgrounds blend into each row; notifications retain the same image's white background. Near-white filament is shaded light gray for legibility. The browser renders a fixed, fitted isometric view without a bed or supports, reusing preview geometry when available. A batch alert uses its first available thumbnail. Images are limited to 64 KiB; the server stores and serves them without rendering or slicing. Optional preparation runs alongside submission work with a 750 ms worker limit; the upload path waits at most 150 ms for an image and 500 ms for its upload before continuing without one. Existing submissions keep their text-only appearance. Thumbnails require operator login or a purpose-specific encrypted notification link that expires after 24 hours; public queue responses never include them. Cleanup removes thumbnails with abandoned submissions. After building, `bun run test:thumbnails` checks browser generation, dimensions, framing, privacy and mobile layout.

```sh
bun run check
bun test tests
bun run build
bun run test:e2e
bun run test:browser
bun run test:notifications
```

`test:e2e` runs the built standalone server against an isolated SQLite directory and a local SMTP sink, testing real HTTP streaming, mail failure, privacy, authentication, download integrity, confirmation, and persistence across restarts. `test:browser` also exercises the actual UI, worker preview, and mobile layout with Playwright. `test:notifications` exercises real service worker registration and notification HTTP endpoints with simulated browser permission/push enrollment; actual background delivery needs a real-device test. Install the browser once with `bun --bun playwright install chromium`. These tests never use your configured SMTP account, push keys or database. The optional `LARGE_UPLOAD_TEST=1 bun run test:e2e` adds a near-500-MiB streamed upload. Test screenshots go to ignored `test-results/`.

After building, `bun run test:push-live` uses installed Google Chrome in a temporary profile and contacts its real push provider. It grants notification permission only in that test profile, sends real encrypted pushes, verifies notifications through the browser, closes all PrintHive tabs, confirms a test print and a two-print batch, and checks confirmation replay. It uses temporary keys, an isolated database and a local SMTP inbox; it does not use existing browser profiles or send real email. It unsubscribes and removes its temporary profile afterward. Internet access and a desktop session are required. Results and failure diagnostics go to ignored `test-results/push-live-chrome.json`. To test installed Microsoft Edge instead, set `PUSH_BROWSER_CHANNEL=msedge`; its report uses `push-live-msedge.json`. Push-provider or browser registration failures make this test fail even when deterministic tests pass. This desktop check does not verify physical Android background delivery or whether the OS shows a banner while Do Not Disturb is enabled.

## Production with Podman

```sh
podman build -t printhive:latest -f Containerfile .
podman volume create printhive-data
podman run -d --name printhive --restart=always \
  --env-file /path/to/production.env \
  -p 127.0.0.1:4321:4321 -v printhive-data:/data \
  localhost/printhive:latest
```

Set `APP_ORIGIN` to the public HTTPS origin and use a new production confirmation secret. Set `SMTP_HOST`, `SMTP_PORT=465`, `SMTP_SECURE=true`, `SMTP_USERNAME`, `SMTP_PASSWORD`, and `SMTP_FROM` to your Cloudflare SMTPS configuration and verified sender. TLS certificate verification is enabled; unencrypted SMTP is rejected in production. Credentials and secrets are runtime environment variables, never build inputs. The app runs as root inside the container. With rootless Podman, container root maps to the invoking host user. A bind mount must be writable under that mapping; named volumes work with the supplied configuration.

Use the required Bun version for SMTP delivery. Bun 1.3.12 can lose Cloudflare's SMTP greeting and report `Greeting never received` even when OpenSSL works. Bun 1.4.3 was verified with the standard Nodemailer transport and TLS certificate verification enabled.

Production runs one web process with one local filesystem volume at `/data`. SQLite WAL does not make shared/network filesystems or multiple replicas safe. `bun run start` validates runtime configuration and applies migrations before launching the standalone server. `/api/health` checks database/schema access. The container retains `src/lib`, migrations, and operational CLIs for provisioning and cleanup:

```sh
podman exec -i printhive bun run operator:add your-username < /path/to/protected-password-file
podman exec printhive bun run cleanup
```

For systemd, install the example Quadlet in `deploy/printhive.container` under `~/.config/containers/systemd/`, put environment configuration at `~/.config/printhive/production.env` (mode 0600), and install the cleanup service/timer under `~/.config/systemd/user/`. Then run `systemctl --user daemon-reload`, `systemctl --user start printhive.service`, and `systemctl --user enable --now printhive-cleanup.timer`. Enable user lingering if it must run without a login session. Adjust the Podman executable path for your distribution.

Terminate HTTPS at a reverse proxy. `deploy/nginx.conf` supplies large-upload settings. Disable request buffering, allow at least 500 MiB and 30-minute uploads, and overwrite forwarded headers. Enable `TRUST_PROXY=true` only when all requests arrive through that trusted proxy and the backend port is private. Otherwise a client could spoof its rate-limit identity. If using a CDN, its plan-specific upload limit may be smaller than 500 MiB: route uploads directly through your own HTTPS proxy when necessary. Never log request bodies, Authorization headers, or confirmation query strings; use URL paths without queries in access logs.

## Data, cleanup, and operations

Errors and warnings are printed to stderr as one JSON record per line, with a timestamp, level, operation, and underlying error details. No logging service or extra configuration is required. Follow container output with `podman logs --since 10m -f printhive` (or `docker logs` with the same arguments). Cleanup/migration/provisioning CLIs also log failures and exit nonzero; for the scheduled cleanup service use `journalctl --user -u printhive-cleanup.service`.

For email failures, look for `email.send_failed`. It includes the mail purpose, job ID, SMTP host/port, TLS mode, whether authentication is configured, elapsed time, and the SMTP error code, response code, server response, command stage, and stack when available. For example, an authentication rejection may have `code: "EAUTH"` and `responseCode: 535`; connection or TLS failures retain their underlying diagnostics. `submission.failed` includes the original cause if confirmation delivery fails. `job.notification_failed` means the status was saved but its email failed. Storage, database, confirmation, and request failures are also logged; expected HTTP rejections use warning level. A failure can produce several records as it propagates through these operations.

Logs omit request bodies, email content, submission titles/notes, SQL bindings, cookies, and authorization headers. Error text is scrubbed for configured SMTP credentials, confirmation secrets, email addresses, and URL query strings. SMTP wire/debug logging is deliberately disabled. Public error responses remain generic; detailed diagnostics stay in the server output.

`DATA_DIR` contains `printhive.sqlite` plus SQLite WAL/SHM sidecars and `files/<uuid>.stl`. Upload temporaries use `.stl.part`. Defaults: two concurrent uploads, 30-minute upload capabilities, and three unconfirmed submissions per email. Total storage limits are managed through filesystem quotas on the host. The application enforces the 500 MiB per-file size limit. Confirmed files and history are retained indefinitely.

Run cleanup every 15 minutes. It atomically removes expired unconfirmed jobs, deletes their files and expired sessions, and removes unreferenced files older than two hours. Active reservations/finalization check database deadlines, so cleanup cannot enqueue missing files. Crashed uploads are collected after their upload deadline; expired confirmed jobs are never deleted. Cleanup runs externally; the web process only schedules push delivery.

Migrations are ordered SQL files in `migrations/`, tracked in `schema_migrations`. Run `bun run db:migrate` before direct maintenance commands; dev/start do this automatically. Apply schema changes through new numbered migration files. Do not edit an already applied migration.

For a consistent backup, stop the web process and cleanup timer, then copy the **entire data directory**, including SQLite sidecars and all STL files, as one snapshot. Restart after the copy completes. Alternatively use a filesystem snapshot covering the whole volume while no writers run. Do not copy only the SQLite main file from a running WAL database. Keep environment secrets in a separate encrypted backup. Restore to an empty volume with the same ownership, restore runtime configuration, then start exactly one instance and check `/api/health`, the queue, and an operator download. Test restore procedures before relying on a backup.

Rotating `CONFIRMATION_SECRET` invalidates every outstanding confirmation and upload link; submitters must resubmit. Existing confirmed jobs and operator sessions are unchanged. Secure session cookies require HTTPS in production. The public title/settings and private contact/notes distinction is shown to submitters before they submit.

## Future hosting changes

Database, file storage, mail, and token operations are separated in `src/lib/server`. A move to Vercel requires changing the Astro adapter, moving SQLite to durable remote database access, replacing Bun-specific SQL/password/I/O/runtime functions as needed, and using direct signed object-storage uploads and downloads. A 500 MiB file must not pass through a Vercel Function request body. Local SQLite/files are deliberately not presented as a serverless backend.

API/library references: [Astro Node adapter](https://docs.astro.build/en/guides/integrations-guide/node/) and [Bun SQL](https://bun.sh/docs/runtime/sql).

## Browser print preview package

The reusable source is maintained separately in the sibling time_estimator repository's browser directory. PrintHive consumes its source archive under vendor and a thin application adapter. The browser library, STL importer and optional renderer do not depend on the native/server estimator SDK. No package publication or deployment is implied.

Development pre-bundles the preview entry points used by workers so first file selection does not trigger a dependency-discovery reload. The build runs bun run preview:runtime to provision checksum-pinned Orca engine assets under public/preview-engine. The package bundles a small, independently compiled C++ STL importer using Orca's repair sequence. Source and binary identities and license notices are included in that package. Engine files and input models are separate; local generation never uploads the model.

Model offers Auto orientation, selectable hull faces with hover highlighting, axis presets and Reset orientation. Auto uses Orca's own algorithm. Each file in a batch retains its own rotation, mirror option and copy count. Mirror and Copies appear beside file selection and apply to the active file; a row summary and the Previewing filename identify that file. Clicking a file opens its options directly beneath that row; clicking the selected row again collapses them without changing its preview. Copies and Mirror stay at the top of the expanded options. Default settings appear below the file list and provide material/color, infill, number of walls (2–6, default 2), layer height, supports, model units and scale for every existing and newly added part. More settings contains optional per-field overrides: Use default (or a blank scale) inherits the latest default value; Reset to defaults clears overrides while preserving copies and mirroring. Colors are resolved against each effective material. The single/batch API receives the effective settings for each part. Migration `011_wall_count.sql` stores wall count and gives existing jobs 2 walls. STL units default to millimeters. Meters (x1000) and inches (x25.4) are explicit choices; a tiny-file hint offers Use meters without silently rescaling. Scale accepts 0.01% through 10000% and multiplies the chosen units once, identically in preview and exported geometry. Before reserving an upload, a worker transforms every original triangle and bakes the selected units, grounds the model and writes binary STL with corrected normals/winding. The reservation uses the resulting size; already baked mirroring is submitted as mirror=0 to prevent a second reflection. Canceling preparation stops that worker. The original local File remains available for reset.

Supports shows the model with solid tree or regular support shapes and a vertical height/layer
slider. It does not show model infill, walls, support-interface lines or playback controls.
The model becomes translucent in Supports so supports underneath or inside it remain visible. When supports are disabled for the selected file, the Supports tab is gray and unavailable; turning supports off while viewing them returns to Model. No separate full slice starts when switching tabs.
The actual bed prefers the Prusa Core ONE+ (250 x 220 x 270 mm), switching to H2D
single-nozzle space (325 x 320 x 325 mm) when necessary. Oversized models retain a fit
message and unavailable estimate; the bed never silently expands.

One combined fast task starts in the background after a 150 ms settings debounce. It
prepares physical model sections and generated support regions once, then estimates model
and support printing together with shared cooling. It does not export G-code. The UI shows
Print time and Quick estimate; startup/finish and physical calibration remain outside this
approximation. The generated support regions are rendered as one color without exposing
internal interface classifications. A matching result is reused when switching views.
A page-local cache in src/lib/preview-cache.ts keeps completed estimates and support shapes when switching files or returning to previous settings. It keys immutable File references and canonical effective profiles, rotation, mirroring, combined unit/percentage scale, infill, wall count, layer height, support type and engine asset hashes. Copies and display color do not affect this per-copy calculation. New File objects conservatively recalculate even if names match. Changed inputs cancel stale workers; only completed, matching-runtime results enter the cache. Removed files are released; least-recently-used results are evicted beyond 20 entries or an estimated 128 MiB retained-data budget. The budget estimates JavaScript storage rather than measuring total browser memory. Native worker heaps and viewer GPU resources are not cached. Reloading or closing the page clears these results; this is not persistent browser storage or a server cache.
Estimates remain per copy, not combined-plate or queue durations.

The engine is source-built and bundled with the independently reusable browser package.
No native/server estimator installation or server slicing/cache service is required.
Inventory material names do not automatically resolve production filament profiles;
the separate printer JSON files use resolved Orca 2.4.2 stock 0.4 mm / Generic PLA presets for Core ONE and H2D. They remain editable; physical timing is not calibrated. See [configuration, precedence and selection](docs/preview-settings.md).
Browser limits remain different from desktop Orca. Integrity uses Web Crypto or the same
SHA-256 fallback on ordinary HTTP development addresses.

Migration 004 adds the normal support setting while preserving jobs, custom materials, file references and event history. Run normal startup migrations before using Regular supports on an existing database.

The browser regression checks native orientation, clickable faces, regular supports, the actual saved STL orientation, per-file mirror/copy isolation, actual exported mirrored vertices, original bytes for untouched files, one background request for timing/support shapes, slider reuse without another slice, dropdown isolation, unit-converted uploads, Core ONE/H2D/oversize selection and mobile layout. PREVIEW_UNIT_MODEL optionally checks a local meter-exported STL through the unit correction, support preview and saved-upload geometry. PREVIEW_SMOKE_MODEL can point to a local STL for an additional local-only generation and cutaway screenshot check. Screenshots are written to ignored test-results/.


The 0.5 integration passes 65 unit checks (366 assertions), the production build and
full desktop/mobile browser flow, including the attached meter-exported case, explicit
unit correction, pose/export and independent per-file settings. A local HTTP development check
observed about 1.5 seconds for the synthetic bracket and 3.0 seconds
for the corrected key case from selection/unit choice through estimate availability.
Switching to Supports made no additional engine request; neither file was uploaded.
These are two development observations, not a general performance or physical-accuracy
claim. The source library records its narrower engine comparisons separately.

Default settings and page-local result reuse pass 71 unit checks (409 assertions), type checking, the production build and both browser flows. The settings flow observes real fast_shapes worker requests: switching files and restoring previous support settings starts no additional task, while changed support settings regenerate. It also verifies inherited values for newly added parts, explicit overrides, reset behavior, scaled saved-STL dimensions and desktop/mobile layout.

Per-printer configuration and invalid-scale recovery pass 72 unit checks (430 assertions), type checking, the production build, HTTP/SMTP checks and desktop/mobile browser flows, including the supplied meter-exported case. The form reveals invalid scales before native validation tries to focus hidden inputs; required title/email checks remain active.


Per-model More settings includes an optional support overhang angle (whole degrees,
0–90). Blank uses the printer profile's default: 35° for Core ONE, 30° for H2D. The angle affects
both generated supports and the shared time estimate, and is saved with each part.
A prominent No supports needed notice appears after successful empty generation in
either view. Migration 005 preserves older submissions and their history, adding only
a nullable angle field. See [support settings and compatibility](docs/preview-settings.md#per-model-support-angle-and-older-submissions).
