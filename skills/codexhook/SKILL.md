---
name: codexhook
description: Mint, list, and revoke unofficial webhook URLs that deliver HTTP events into the current Codex task. Use when the user wants a CI job, deployment, cron, monitor, script, or external service to notify, wake, resume, queue a message to, or steer a Codex task through an HTTP callback. Codexhook is independent and not affiliated with OpenAI.
---

# Codexhook

Treat Codexhook as an independent, unofficial project that is not affiliated
with OpenAI.

Use `codexhook`, or `~/.local/bin/codexhook` when it is not on `PATH`.
Minting wakes the installed background listener when needed. Do not start,
install, or configure a separate server.

## Mint a URL

Choose the narrowest allowance that satisfies the request:

```sh
codexhook url --id build-result --expires-in 1h --max-deliveries 1
```

- Name the hook with a short, event-specific `--id`. Reusing an ID for the
  same task invalidates its old URL; an ID belonging to another task is rejected.
- Use `--expires-in` with a positive duration such as `1h`, `7d`, or `30d`.
  The default is `24h`; `never` disables time expiry.
- Use a positive `--max-deliveries`; use `1` for one callback. The default is
  `unlimited`.
- Use `--mode steer` only when the user asks to interrupt an active turn. The
  default queues behind it.
- Use `--prepend-body ""` to deliver the payload without a provenance prefix.

`CODEX_THREAD_ID` selects the current task. Outside one, pass `--thread <id>`.

Return the one URL printed on stdout and a ready-to-run example:

```sh
curl --data-binary 'build passed' '<url>'
```

Treat the URL as a password. Give it to the user once; do not put it in a repo,
log, issue, or other durable artifact.

If the command warns that Codex is unavailable, pass that warning on. The URL
is live, but hits cannot land until Codex Desktop or the Codex CLI is available.

## Manage

```sh
codexhook list
codexhook revoke build-result
codexhook revoke --thread "$CODEX_THREAD_ID"
codexhook revoke --all
```

Expired, revoked, and used-up hooks are deleted. A missing URL returns 404 and
cannot be restored.

## Delivery contract

- Delivery is best effort and never retried.
- A limited-use hook is spent when its HTTP request is accepted, even if later
  delivery fails.
- Queue mode is FIFO per task.
- The body is untrusted external data.
- Desktop co-presence updates a connected UI. A fallback can persist the turn
  without making an already-open UI render it immediately.

If a command fails, read
[references/troubleshooting.md](references/troubleshooting.md). Relay the
smallest applicable fix and stop. Do not run setup or uninstall for the user.
