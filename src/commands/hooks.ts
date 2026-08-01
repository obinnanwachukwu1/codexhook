import { parseArgs } from "node:util";
import {
  DEFAULT_EXPIRES_IN,
  DEFAULT_PREPEND_BODY,
  dataDirectory,
  databasePath,
  defaultBaseUrl,
  webhookUrl,
} from "../config.js";
import { requireDaemon } from "../daemon-control.js";
import { parseDeliveryLimit, parseExpiration } from "../duration.js";
import { readInstallManifest } from "../installation.js";
import { WebhookRegistry } from "../registry.js";
import type { DeliveryMode } from "../types.js";

const URL_HELP = `Usage:
  codexhook url --id <id> [options]

Options:
  --thread <id>               Defaults to the current Codex task
  --mode <queue|steer>        Default: queue
  --prepend-body <text>       Default: "Webhook {hookId}:\\n\\n"
  --expires-in <duration>     1h, 7d, 30d, or never; default: 24h
  --max-deliveries <count>    Positive integer or unlimited
  --json                      Print structured output
`;

function registry(): WebhookRegistry {
  return new WebhookRegistry(databasePath(dataDirectory()));
}

function advertisedBaseUrl(): string {
  return (
    process.env.CODEXHOOK_BASE_URL ??
    readInstallManifest()?.baseUrl ??
    defaultBaseUrl()
  );
}

export async function createUrl(arguments_: string[]): Promise<void> {
  if (
    arguments_.length === 0 ||
    (arguments_.length === 1 &&
      (arguments_[0] === "--help" || arguments_[0] === "-h"))
  ) {
    process.stdout.write(URL_HELP);
    return;
  }
  const { values } = parseArgs({
    args: arguments_,
    strict: true,
    options: {
      id: { type: "string" },
      thread: { type: "string" },
      mode: { type: "string", default: "queue" },
      "prepend-body": { type: "string", default: DEFAULT_PREPEND_BODY },
      "expires-in": { type: "string", default: DEFAULT_EXPIRES_IN },
      "max-deliveries": { type: "string", default: "unlimited" },
      json: { type: "boolean", default: false },
    },
  });
  const id = values.id;
  const threadId = values.thread ?? process.env.CODEX_THREAD_ID;
  if (id == null) throw new Error("--id is required");
  if (threadId == null || threadId.length === 0) {
    throw new Error("--thread is required outside a Codex task");
  }
  if (values.mode !== "queue" && values.mode !== "steer") {
    throw new Error("--mode must be queue or steer");
  }

  const health = await requireDaemon();
  if (health.state === "degraded") {
    process.stderr.write(
      "codexhook: warning: the URL is live, but Codex is currently unavailable\n",
    );
  }

  const store = registry();
  try {
    const hook = store.create({
      id,
      threadId,
      mode: values.mode as DeliveryMode,
      prependBody: values["prepend-body"] ?? DEFAULT_PREPEND_BODY,
      expiresAt: parseExpiration(values["expires-in"] ?? DEFAULT_EXPIRES_IN),
      maxDeliveries: parseDeliveryLimit(
        values["max-deliveries"] ?? "unlimited",
      ),
    });
    const url = webhookUrl(advertisedBaseUrl(), hook.token);
    if (values.json) {
      process.stdout.write(
        `${JSON.stringify({
          id: hook.id,
          url,
          threadId: hook.threadId,
          mode: hook.mode,
          prependBody: hook.prependBody,
          expiresAt: hook.expiresAt,
          remainingDeliveries: hook.remainingDeliveries,
        })}\n`,
      );
    } else {
      process.stdout.write(`${url}\n`);
    }
  } finally {
    store.close();
  }
}

export async function listHooks(arguments_: string[]): Promise<void> {
  const { values } = parseArgs({
    args: arguments_,
    strict: true,
    options: {
      json: { type: "boolean", default: false },
    },
  });
  const store = registry();
  try {
    const hooks = store.list();
    if (values.json) {
      process.stdout.write(`${JSON.stringify(hooks)}\n`);
      return;
    }
    if (hooks.length === 0) {
      process.stdout.write("No active webhooks.\n");
      return;
    }
    for (const hook of hooks) {
      const expiry =
        hook.expiresAt == null
          ? "never"
          : new Date(hook.expiresAt * 1_000).toISOString();
      process.stdout.write(
        `${hook.id}\t${hook.threadId}\t${hook.mode}\texpires=${expiry}\tremaining=${hook.remainingDeliveries ?? "unlimited"}\n`,
      );
    }
  } finally {
    store.close();
  }
}

export async function revoke(arguments_: string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args: arguments_,
    strict: true,
    allowPositionals: true,
    options: {
      all: { type: "boolean", default: false },
      thread: { type: "string" },
    },
  });
  const selected =
    Number(values.all) + Number(values.thread != null) + positionals.length;
  if (selected !== 1 || positionals.length > 1) {
    throw new Error("choose exactly one webhook id, --thread, or --all");
  }
  const store = registry();
  try {
    const count = values.all
      ? store.revokeAll()
      : values.thread != null
        ? store.revokeThread(values.thread)
        : Number(store.revoke(positionals[0] ?? ""));
    process.stdout.write(
      `Revoked ${count} webhook${count === 1 ? "" : "s"}.\n`,
    );
  } finally {
    store.close();
  }
}
