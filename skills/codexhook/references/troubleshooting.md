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

On macOS or Linux, use `~/.local/bin/codexhook`. On Windows, use
`%USERPROFILE%\.local\bin\codexhook.cmd`. Tell the user that the corresponding
`.local/bin` directory is missing from this environment's `PATH`.

## Listener is down

Ask the user to repair and restart it:

```sh
npx codexhook@latest setup
```

For restart without repair:

```sh
# macOS
launchctl kickstart -k gui/$(id -u)/dev.codexhook.daemon

# Linux
systemctl --user restart codexhook.service

# Windows PowerShell
Start-ScheduledTask -TaskName Codexhook
```

macOS and Windows logs are in `~/.codexhook/log/daemon.log`. On Linux, use
`journalctl --user -u codexhook.service`.

## Listener repeatedly exits

`doctor --json` distinguishes a missing recorded Node binary from a port
conflict and reports the selected port at `installation.manifest.port`. Setup
records the current Node path again. On macOS or Linux, inspect a conflicting
port with:

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
spent. The machine needs the Codex app on macOS or Windows, or `codex` on the
service `PATH`. Re-running setup captures the current `PATH`.

Closing the Codex app alone is supported. A persisted turn may require an app
refresh.

## An update broke delivery

Ask the user to reinstall the previously working npm version:

```sh
npx codexhook@<previous-version> setup
```

The installer retains the current and previous runtime directories.

## A hit returned 202 but nothing arrived

Read the newest `delivery_failed` entry in the platform log described above. A
`DesktopVisibilityUnconfirmed` failure means a fallback turn was submitted but
the open app did not expose it. The surrounding `transport_attempt_failed`
entries identify the failed connection and stage without logging the webhook
body or URL.

A limited-use hook is already spent. Never retry an ambiguous submission
automatically because that can duplicate a turn; mint a new URL only when the
user requests another attempt.
