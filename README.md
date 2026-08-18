# codexhook

Let CI jobs, deploys, scripts, and monitors send messages to a Codex task.

> Codexhook is an independent, unofficial project. It is not affiliated with,
> endorsed by, or sponsored by OpenAI.

Codexhook gives a task a webhook URL. When something posts to that URL, the
body arrives in the task as a message. The task can wait for work happening
outside Codex and continue when the result is ready.

## Quick start

Codexhook requires macOS, Windows, or Linux and Node.js 24 or newer.

```sh
npx codexhook@latest setup
```

Setup installs the Codex skill and starts a per-user background service. It
runs after the setup command exits and starts again when you sign in.

Ask Codex for a webhook:

```text
Create a one-shot webhook named build-result that expires in one hour.
```

Codex returns a URL and a command to hit it:

```sh
curl --data-binary 'build passed on main' '<url>'
```

The task receives:

```text
Webhook build-result:

build passed on main
```

You can also create the URL directly:

```sh
codexhook url \
  --id build-result \
  --expires-in 1h \
  --max-deliveries 1
```

`CODEX_THREAD_ID` selects the current task. Use `--thread <id>` when running
the command elsewhere.

## Control a webhook

Hooks expire after 24 hours by default and can be used any number of times.
Set a shorter lifetime or a delivery limit for callbacks that should not stay
active:

```sh
codexhook url \
  --id deploy-finished \
  --expires-in 30m \
  --max-deliveries 1
```

Expiry accepts minutes, hours, days, and weeks, such as `30m`, `1h`, `7d`, and
`2w`. Use `never` or `unlimited` when the hook should have no corresponding
limit.

Queue mode is the default. A message waits for the current turn to finish, then
starts the next turn. Use `--mode steer` when the message should enter a turn
that is already running.

Each message starts with `Webhook {hookId}:`. Pass `--prepend-body ""` to send
the body without that prefix.

Reusing an ID for the same task replaces the old URL. An ID that belongs to
another task is rejected.

## Reach the listener

On a fresh install, Codexhook tries `127.0.0.1:9465`. If another service is
using it, setup selects an available high port and keeps that choice for later
runs. Local scripts can use the URL as printed.

Choose a specific local port when you need one:

```sh
npx codexhook@latest setup --port 12345
```

For another machine or hosted service, forward that address with Tailscale or a
reverse proxy and record the external address:

```sh
npx codexhook@latest setup \
  --base-url https://mac.example.ts.net/codexhook
```

Future hooks use the recorded address. Codexhook keeps listening on loopback;
Tailscale or the proxy handles the network connection.

## Delivery behavior

The webhook responds with `202` after accepting a hit. Delivery continues in
the background.

Queue delivery is FIFO for each task. Steer delivery targets the active turn.
On macOS and Windows, codexhook uses the open Codex app when that task is
active. If the app cannot accept the message, codexhook falls back to a local
Codex runtime. When the app is open, codexhook confirms that the task can see
the fallback turn before recording the delivery as complete. Linux uses a
running Codex app-server daemon or the Codex CLI.

Delivery is best effort and has no retry queue. A limited-use hook is spent
when its HTTP request is accepted, even when the message later fails to arrive.
This avoids duplicate turns after an uncertain delivery result.

## Manage hooks

```sh
codexhook list
codexhook revoke build-result
codexhook revoke --thread "$CODEX_THREAD_ID"
codexhook revoke --all
codexhook status
codexhook doctor
```

`status` reports daemon readiness, local task access, delivery availability, and
Desktop IPC availability. `doctor` additionally checks the installed runtime,
background service, skill, and Codex connections. Use `--json` with either
command for structured output.

Run setup again to update or repair codexhook:

```sh
npx codexhook@latest setup
```

Remove codexhook with:

```sh
codexhook uninstall
```

Uninstall keeps the webhook registry and logs. Add `--purge` to delete them.

## Security

A webhook URL is a password. Anyone who has it can send text to its Codex task,
and the body arrives as untrusted external data.

- Tokens contain 256 random bits.
- The registry stores token hashes.
- Expired, revoked, and used-up URLs return `404`.
- Request bodies are limited to 128 KiB.
- Accepted hits are limited to 10 per task per minute.
- Codexhook declines approval requests from delivered turns.

The listener stays on loopback unless you forward it yourself. Runtime data
lives in `~/.codexhook/`. Set `CODEXHOOK_HOME` before setup to move it.

## Development

```sh
npm install
npm run check
```

`npm run check` builds the package and runs the test suite. Clean-install
workflows install the packed release on fresh macOS, Windows, and Linux
runners, exercise a webhook, test daemon recovery, and check uninstall.

Authored files have a hard limit of 400 lines. Consider splitting a file at
300 lines.

MIT licensed.
