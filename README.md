# codexhook

Give a Codex task an HTTP address.

> Codexhook is an independent, unofficial project. It is not affiliated with,
> endorsed by, or sponsored by OpenAI.

Codexhook is an opaque-token reverse map: a webhook URL identifies one Codex
task plus a small delivery policy. A local background listener accepts the
request, atomically consumes its allowance, and submits its body to Codex.

## Install

macOS and Node.js 24 or newer are required for v1.

```sh
npx codexhook@latest setup
```

This one command installs:

- a bundled, versioned runtime in `~/.local/share/codexhook/`;
- a launcher at `~/.local/bin/codexhook`;
- the Codex skill at `~/.codex/skills/codexhook/`;
- a per-user launchd service.

No terminal stays open and no sudo access is needed. launchd keeps the small
HTTP/SQLite listener available; Codex transports are opened only for a
delivery.

Setup is also update and repair:

```sh
npx codexhook@latest setup
```

Reinstall a known version to roll back:

```sh
npx codexhook@0.1.0 setup
```

The installer retains the current and previous runtime directories. It never
runs the service from npm's temporary npx cache.

## Create a webhook

Within a Codex task, `CODEX_THREAD_ID` supplies the task automatically:

```sh
codexhook url \
  --id deploy-finished \
  --expires-in 1h \
  --max-deliveries 1
```

The command prints one bearer-secret URL. POST any UTF-8 body up to 128 KiB:

```sh
curl --data-binary 'deployment succeeded' '<url>'
```

The listener returns `202` after accepting the hit. Delivery continues in the
background.

Available policy:

```text
--thread <id>             defaults to CODEX_THREAD_ID
--mode queue|steer        queue by default
--prepend-body <text>     defaults to "Webhook {hookId}:\n\n"
--expires-in <duration>   positive m/h/d/w duration or never; default 24h
--max-deliveries <count>  positive integer or unlimited
```

`--prepend-body ""` sends the body without a provenance prefix. Queue mode is
FIFO per task. Steer mode targets an active turn when possible.

Reusing an ID for the same task replaces the registration and invalidates its
old URL. An ID already owned by another task is rejected.

## Advertised URL

The listener always binds to `127.0.0.1:9465`. Configure a Tailscale or
reverse-proxy address as a machine-level advertised URL:

```sh
npx codexhook@latest setup \
  --base-url https://machine.example.ts.net/codexhook
```

This changes returned URLs only. It does not expose another network listener.
`CODEXHOOK_BASE_URL` remains an environment override.

## Manage and diagnose

```sh
codexhook list
codexhook revoke deploy-finished
codexhook revoke --thread "$CODEX_THREAD_ID"
codexhook revoke --all
codexhook doctor
```

`url` checks the listener before writing a registration. If it is down, the
command asks launchd to start it and waits for up to three seconds. It never
leaves an unusable hook row after a failed start.

`doctor` checks the durable runtime, recorded Node executable, installed skill,
launchd listener, and available Codex transports. Codex being temporarily
closed is reported as degraded availability, not a broken installation.

Remove the service, runtime, launcher, and skill:

```sh
codexhook uninstall
```

The webhook registry and logs are preserved. Delete them too with
`codexhook uninstall --purge`.

## Delivery and co-presence

Codexhook prefers the private, user-owned Desktop IPC router and the thread
follower protocol used by Desktop windows. This provides co-presence: a
connected open UI observes the turn.

If Desktop is closed or cleanly rejects an incompatible request, delivery
falls back in order to:

1. an already-running Codex app-server daemon;
2. the app-server binary bundled with ChatGPT Desktop;
3. `codex` on the service `PATH`.

A fallback can update the persisted task without making an already-open UI
render the turn immediately.

Fallback is governed by the submission boundary. Failures proven to happen
before submission try the next transport. A timeout, disconnect, malformed
success, or unknown error after a request is written is ambiguous and stops.
Codexhook never retries an ambiguous request because that could duplicate a
turn.

Limited-use URLs are consumed when the HTTP request is accepted, even if later
delivery fails. Delivery is best effort and has no retry queue.

## Security model

- Tokens contain 256 random bits; SQLite stores only SHA-256 digests.
- Expired, revoked, and fully consumed registrations are deleted.
- Request bodies are capped at 128 KiB.
- Delivery is rate-limited to 10 accepted hits per task per minute.
- App-server approval requests are declined.
- The listener is loopback-only.

Runtime data and JSON logs live under `~/.codexhook/` by default. Set
`CODEXHOOK_HOME` before setup to relocate them.

## Development

```sh
npm install
npm run check
```

`npm run build` emits normal TypeScript output for tests and a hermetic bundled
runtime at `dist/codexhook.mjs`. The npm package contains that one runtime file,
the skill, and user documentation—never `node_modules`.

Authored source, tests, scripts, and documentation have a hard 400-line limit
per file. Treat 300 lines as the extraction warning. `npm run check` enforces
the limit.
