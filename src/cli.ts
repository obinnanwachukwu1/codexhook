#!/usr/bin/env node

import { createUrl, listHooks, revoke } from "./commands/hooks.js";
import {
  doctor,
  serve,
  setup,
  uninstall,
} from "./commands/system.js";

const HELP = `codexhook — give a Codex task an HTTP address

Usage:
  codexhook setup [--base-url <url>] [--port <number>]
  codexhook url --id <id> [options]
  codexhook list [--json]
  codexhook revoke <id>
  codexhook revoke --thread <thread-id>
  codexhook revoke --all
  codexhook doctor [--json]
  codexhook uninstall [--purge]

URL options:
  --thread <id>               Defaults to CODEX_THREAD_ID
  --mode <queue|steer>        Default: queue
  --prepend-body <text>       Default: "Webhook {hookId}:\\n\\n"
  --expires-in <duration>     1h, 7d, 30d, or never; default: 24h
  --max-deliveries <count>    Positive integer or unlimited

Environment:
  CODEXHOOK_HOME
  CODEXHOOK_BASE_URL
  CODEXHOOK_CODEX_PATH
  CODEXHOOK_DESKTOP_IPC_PATH
  CODEX_THREAD_ID

Codexhook is an independent project and is not affiliated with OpenAI.
`;

async function main(): Promise<void> {
  const [command, ...arguments_] = process.argv.slice(2);
  switch (command) {
    case "setup":
      await setup(arguments_);
      break;
    case "url":
      await createUrl(arguments_);
      break;
    case "list":
      await listHooks(arguments_);
      break;
    case "revoke":
      await revoke(arguments_);
      break;
    case "doctor":
      await doctor(arguments_);
      break;
    case "uninstall":
      await uninstall(arguments_);
      break;
    case "serve":
      await serve(arguments_);
      break;
    case "help":
    case "--help":
    case "-h":
    case undefined:
      process.stdout.write(HELP);
      break;
    default:
      throw new Error(`unknown command: ${command}`);
  }
}

main().catch((error) => {
  process.stderr.write(
    `codexhook: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
});
