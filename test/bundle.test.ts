import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";

const execFileAsync = promisify(execFile);

test("the published single-file runtime starts and exposes only public commands", async () => {
  const runtime = path.resolve("dist/codexhook.mjs");
  const { stdout, stderr } = await execFileAsync(
    process.execPath,
    [runtime, "--help"],
    { timeout: 5_000 },
  );

  assert.equal(stderr, "");
  assert.match(stdout, /codexhook setup/);
  assert.match(stdout, /codexhook uninstall/);
  assert.match(stdout, /codexhook status/);
  assert.doesNotMatch(stdout, /codexhook ensure/);
  assert.doesNotMatch(stdout, /codexhook service/);
  assert.doesNotMatch(stdout, /codexhook serve/);
  assert.doesNotMatch(stdout, /CODEXHOOK_HOME/);
  assert.doesNotMatch(stdout, /--prepend-body/);

  const urlHelp = await execFileAsync(
    process.execPath,
    [runtime, "url"],
    { timeout: 5_000 },
  );
  assert.equal(urlHelp.stderr, "");
  assert.match(urlHelp.stdout, /codexhook url --id <id>/);
  assert.match(urlHelp.stdout, /--prepend-body/);
  assert.match(urlHelp.stdout, /--max-deliveries/);

  const version = await execFileAsync(
    process.execPath,
    [runtime, "--version"],
    { timeout: 5_000 },
  );
  assert.equal(version.stderr, "");
  assert.match(version.stdout, /^codexhook \d+\.\d+\.\d+\n$/);
});
