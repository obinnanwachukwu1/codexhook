# codexhook

Let CI jobs, deploys, scripts, and monitors send messages to a Codex task.

> Codexhook is an independent, unofficial project. It is not affiliated with,
> endorsed by, or sponsored by OpenAI.

Codexhook gives a task a webhook URL. When something posts to that URL, the
body arrives in the task as a message. The task can wait for work happening
outside Codex and continue when the result is ready.

## Quick start

Codexhook requires macOS and Node.js 24 or newer.

```sh
npx codexhook@latest setup
```

Setup installs the Codex skill and starts a per-user background service.
launchd keeps it running after the setup command exits.

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
When Codex Desktop is open, the message and turn appear in the open task. If
Desktop is closed, codexhook can deliver through another local Codex runtime.
The task may need a refresh when Desktop opens again.

Delivery is best effort and has no retry queue. A limited-use hook is spent
when its HTTP request is accepted, even when the message later fails to arrive.
This avoids duplicate turns after an uncertain delivery result.

## Manage hooks

```sh
codexhook list
codexhook revoke build-result
codexhook revoke --thread "$CODEX_THREAD_ID"
codexhook revoke --all
codexhook doctor
```

`doctor` checks the installation, background service, and available Codex
connections. Use `doctor --json` for structured output.

Run setup again to update or repair codexhook:

```sh
npx codexhook@latest setup
```

Install a known version to roll back:

```sh
npx codexhook@<version> setup
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

The listener stays on loopback unless you forward it yourself. Runtime data and
logs live in `~/.codexhook/`. Set `CODEXHOOK_HOME` before setup to move them.

## Development

```sh
npm install
npm run check
```

`npm run check` builds the package and runs the test suite. The clean-install
workflow also installs the packed release on a fresh macOS runner, exercises a
webhook, tests daemon recovery, and checks uninstall.

Authored files have a hard limit of 400 lines. Consider splitting a file at
300 lines.

MIT licensed.
