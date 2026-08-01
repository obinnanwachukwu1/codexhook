# Codexhook troubleshooting

Run `codexhook doctor` first. It checks the durable runtime, recorded Node
binary, background listener, installed skill, and available Codex transports.
Diagnose the result and give the applicable command to the user; do not make
machine-level installation changes for them.

## Not installed

Ask the user to run:

```sh
npx codexhook@latest setup
```

This is the one-time install command and also the update and repair command.

## Command not found

Use `~/.local/bin/codexhook`. Tell the user that `~/.local/bin` is missing from
this environment's `PATH`.

## Listener is down

Ask the user to repair and restart it:

```sh
npx codexhook@latest setup
```

For restart without repair:

```sh
launchctl kickstart -k gui/$(id -u)/dev.codexhook.daemon
```

Logs are in `~/.codexhook/log/daemon.log`.

## Listener repeatedly exits

`doctor --json` distinguishes a missing recorded Node binary from a port
conflict and reports the selected port at `installation.manifest.port`. Setup
records the current Node path again. For a port conflict, inspect that port:

```sh
lsof -nP -iTCP:<port> -sTCP:LISTEN
```

A fresh install tries port 9465 and automatically selects an available high
port when necessary. Existing installs keep their selected port so active local
URLs stay valid. If the user intentionally wants a different port, ask them to
run `npx codexhook@latest setup --port <port>` and warn that existing local URLs
will change.

## Codex unavailable

Hooks still accept hits, but delivery is dropped and any delivery allowance is
spent. The machine needs Codex Desktop or `codex` on the service `PATH`.
Re-running setup captures the current `PATH`.

Closing Codex Desktop alone is supported: codexhook tries a managed app-server,
the app-bundled binary, and then the Codex CLI. A persisted turn may require a
Desktop refresh.

## An update broke delivery

Ask the user to reinstall the previously working npm version:

```sh
npx codexhook@<previous-version> setup
```

The installer retains the current and previous runtime directories.

## A hit returned 202 but nothing arrived

Read the newest `delivery_failed` entry in
`~/.codexhook/log/daemon.log`. A limited-use hook is already spent. Never retry
an ambiguous submission automatically because that can duplicate a turn; mint
a new URL only when the user requests another attempt.
