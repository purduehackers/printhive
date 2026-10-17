# PrintHive

An Astro + React 3D printing queue running on Bun. SQLite is accessed through `Bun.SQL`; original STLs stay in a private directory on disk. The public queue lists printing and queued jobs, while operators can download files, manage statuses, and view history.

## Local development

Requires Bun 1.3.12 or newer. All project commands use Bun.

React and ReactDOM are pinned to 19.2.7 for production SSR compatibility with Bun 1.3.12. The test suite includes a production-rendering regression check; run it before upgrading that pair.

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

Provision an operator by piping a password from a password manager or protected file into the CLI:

```sh
bun run operator:add your-username < /path/to/protected-password-file
```

Passwords must have 12–1024 characters and are hashed with Argon2id. Running the command again resets that account's password, activates it, and revokes its sessions. The CLI reads stdin, so passwords need not appear in process arguments or shell history. Operators can be disabled with `UPDATE operators SET active = 0 WHERE username = ?` in SQLite; inactive accounts immediately lose access.

## How it works

- A metadata request creates a pending job and returns a short-lived AES-256-GCM upload capability. The browser sends the STL as a raw streamed body, with progress and cancellation. The server independently enforces the 500 MiB limit, declared size, concurrency, upload deadline, and STL structure. It uses bounded file reads/writes and atomically renames validated files.
- A confirmation email is sent synchronously. Submission succeeds only after SMTP accepts it. SMTP failure deletes the pending database row and file. SMTP acceptance does not guarantee inbox delivery. A lost response or ambiguous SMTP failure may leave an unusable email; its link cannot enqueue an incomplete or deleted job.
- Confirmation links contain an encrypted job ID, purpose, version, and expiry. No token is stored in SQLite. Opening a link does not change state; the user must press **Confirm print**. The link and database deadline expire after 24 hours. Repeated confirmation cannot move or reopen a job.
- The queue orders confirmed jobs by queue timestamp, then ID for ties, and refreshes every 15 seconds. Email, notes, original filenames, and downloads are private. Multiple jobs may print at once. Completed, canceled, and failed jobs remain in operator history.
- Operators use hashed random sessions with a 12-hour expiry. Mutations require the configured origin. Login and reservation requests are rate limited. Status writes compare versions, update history transactionally, and then send email. Email failure produces a visible operator warning and preserves the saved status. There is no automatic retry or durable email outbox.
- Allowed transitions: queued → printing/canceled/failed; printing → completed/canceled/failed; completed/canceled/failed → queued. Requeue adds a job to the end. No-op writes do not email.
- Preview parsing runs in a worker, reads bounded slices, and samples at most 100,000 triangles. Preview cancellation terminates the worker. Three.js resources are released when files change. Color and X mirroring affect the preview; operator instructions preserve the original bytes. Units are assumed to be millimeters. No slicing or printability analysis is performed. Submission still works if preview/WebGL is unavailable.

## Verification

```sh
bun run check
bun test tests
bun run build
bun run test:e2e
bun run test:browser
```

`test:e2e` runs the built standalone server against an isolated SQLite directory and a local SMTP sink, testing real HTTP streaming, mail failure, privacy, authentication, download integrity, confirmation, and persistence across restarts. `test:browser` also exercises the actual UI, worker preview, and mobile layout with Playwright. Install its browser once with `bun --bun playwright install chromium`. These tests never use your configured SMTP account or database. The optional `LARGE_UPLOAD_TEST=1 bun run test:e2e` adds a near-500-MiB streamed upload. Test screenshots go to ignored `test-results/`.

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

Run cleanup every 15 minutes. It atomically removes expired unconfirmed jobs, deletes their files and expired sessions, and removes unreferenced files older than two hours. Active reservations/finalization check database deadlines, so cleanup cannot enqueue missing files. Crashed uploads are collected after their upload deadline; expired confirmed jobs are never deleted. No scheduled process runs inside the web server.

Migrations are ordered SQL files in `migrations/`, tracked in `schema_migrations`. Run `bun run db:migrate` before direct maintenance commands; dev/start do this automatically. Apply schema changes through new numbered migration files. Do not edit an already applied migration.

For a consistent backup, stop the web process and cleanup timer, then copy the **entire data directory**, including SQLite sidecars and all STL files, as one snapshot. Restart after the copy completes. Alternatively use a filesystem snapshot covering the whole volume while no writers run. Do not copy only the SQLite main file from a running WAL database. Keep environment secrets in a separate encrypted backup. Restore to an empty volume with the same ownership, restore runtime configuration, then start exactly one instance and check `/api/health`, the queue, and an operator download. Test restore procedures before relying on a backup.

Rotating `CONFIRMATION_SECRET` invalidates every outstanding confirmation and upload link; submitters must resubmit. Existing confirmed jobs and operator sessions are unchanged. Secure session cookies require HTTPS in production. The public title/settings and private contact/notes distinction is shown to submitters before they submit.

## Future hosting changes

Database, file storage, mail, and token operations are separated in `src/lib/server`. A move to Vercel requires changing the Astro adapter, moving SQLite to durable remote database access, replacing Bun-specific SQL/password/I/O/runtime functions as needed, and using direct signed object-storage uploads and downloads. A 500 MiB file must not pass through a Vercel Function request body. Local SQLite/files are deliberately not presented as a serverless backend.

API/library references: [Astro Node adapter](https://docs.astro.build/en/guides/integrations-guide/node/) and [Bun SQL](https://bun.sh/docs/runtime/sql).
