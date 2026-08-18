#!/usr/bin/env node

import { createUrl, listHooks, revoke } from "./commands/hooks.js";
import {
  doctor,
  serve,
  setup,
  status,
  uninstall,
} from "./commands/system.js";
import { VERSION } from "./version.js";

const HELP = `codexhook — give a Codex task an HTTP address

Usage:
  codexhook setup [--base-url <url>] [--port <number>]
  codexhook url --id <id> [options]
  codexhook list [--json]
  codexhook revoke <id>
  codexhook revoke --thread <thread-id>
  codexhook revoke --all
  codexhook doctor [--json]
  codexhook status [--json]
  codexhook uninstall [--purge]
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
    case "status":
      await status(arguments_);
      break;
    case "uninstall":
      await uninstall(arguments_);
      break;
    case "serve":
      await serve(arguments_);
      break;
    case "--version":
    case "-v":
      process.stdout.write(`codexhook ${VERSION}\n`);
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
