import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  installationPaths,
  installedRuntimePath,
  readInstallManifest,
  renderLaunchAgent,
  setupInstallation,
  uninstallInstallation,
} from "../src/installation.js";

function fixture(): {
  home: string;
  runtime: string;
  skill: string;
} {
  const root = mkdtempSync(path.join(tmpdir(), "codexhook-install-"));
  const home = path.join(root, "home");
  const packageRoot = path.join(root, "package");
  const runtime = path.join(packageRoot, "codexhook.mjs");
  const skill = path.join(packageRoot, "skill");
  mkdirSync(path.join(skill, "agents"), { recursive: true });
  mkdirSync(path.join(skill, "references"), { recursive: true });
  writeFileSync(runtime, "#!/usr/bin/env node\n");
  writeFileSync(
    path.join(skill, "SKILL.md"),
    "---\nname: codexhook\ndescription: test\n---\n",
  );
  writeFileSync(path.join(skill, "agents", "openai.yaml"), "interface: {}\n");
  writeFileSync(path.join(skill, "references", "troubleshooting.md"), "# Help\n");
  return { home, runtime, skill };
}

test("setup creates a durable runtime, shim, skill, manifest, and plist", () => {
  const { home, runtime, skill } = fixture();
  const manifest = setupInstallation({
    home,
    runtimeSource: runtime,
    skillSource: skill,
    baseUrl: "https://host.example.test/codexhook",
    port: 51_234,
    activate: false,
  });
  const paths = installationPaths(home);
  const installed = installedRuntimePath(paths);

  assert.equal(manifest.baseUrl, "https://host.example.test/codexhook");
  assert.equal(manifest.port, 51_234);
  assert.equal(readInstallManifest(paths)?.version, manifest.version);
  assert.ok(installed != null && existsSync(installed));
  assert.ok(existsSync(paths.shim));
  assert.ok(existsSync(path.join(paths.skill, "references", "troubleshooting.md")));
  assert.match(readFileSync(paths.launchAgent, "utf8"), /KeepAlive/);
  assert.match(readFileSync(paths.launchAgent, "utf8"), /codexhook\.mjs/);
  assert.match(readFileSync(paths.launchAgent, "utf8"), /CODEXHOOK_HOME/);
  assert.match(
    readFileSync(paths.launchAgent, "utf8"),
    /<string>--port<\/string>\s*<string>51234<\/string>/,
  );
});

test("a local base URL follows a deliberate port change", () => {
  const { home, runtime, skill } = fixture();
  setupInstallation({
    home,
    runtimeSource: runtime,
    skillSource: skill,
    port: 51_234,
    activate: false,
  });
  const manifest = setupInstallation({
    home,
    runtimeSource: runtime,
    skillSource: skill,
    port: 51_235,
    activate: false,
  });
  assert.equal(manifest.baseUrl, "http://127.0.0.1:51235");
});

test("a custom base URL survives a deliberate port change", () => {
  const { home, runtime, skill } = fixture();
  setupInstallation({
    home,
    runtimeSource: runtime,
    skillSource: skill,
    baseUrl: "https://mac.example.test/codexhook",
    port: 51_234,
    activate: false,
  });
  const manifest = setupInstallation({
    home,
    runtimeSource: runtime,
    skillSource: skill,
    port: 51_235,
    activate: false,
  });
  assert.equal(manifest.baseUrl, "https://mac.example.test/codexhook");
});

test("legacy manifests without a port use 9465", () => {
  const { home, runtime, skill } = fixture();
  setupInstallation({
    home,
    runtimeSource: runtime,
    skillSource: skill,
    activate: false,
  });
  const paths = installationPaths(home);
  const legacy = JSON.parse(readFileSync(paths.manifest, "utf8")) as {
    port?: number;
  };
  delete legacy.port;
  writeFileSync(paths.manifest, `${JSON.stringify(legacy)}\n`);
  assert.equal(readInstallManifest(paths)?.port, 9465);
});

test("setup can repair in place from the durable runtime", () => {
  const { home, runtime, skill } = fixture();
  setupInstallation({
    home,
    runtimeSource: runtime,
    skillSource: skill,
    activate: false,
  });
  const paths = installationPaths(home);
  const installed = installedRuntimePath(paths);
  assert.ok(installed != null);

  setupInstallation({
    home,
    runtimeSource: installed,
    skillSource: path.join(path.dirname(installed), "skill"),
    activate: false,
  });
  assert.ok(existsSync(path.join(paths.skill, "SKILL.md")));
});

test("uninstall preserves data unless purge is explicit", () => {
  const { home, runtime, skill } = fixture();
  setupInstallation({
    home,
    runtimeSource: runtime,
    skillSource: skill,
    activate: false,
  });
  const data = path.join(home, ".codexhook", "codexhook.sqlite");
  writeFileSync(data, "registry");

  uninstallInstallation({ home });
  assert.equal(existsSync(installationPaths(home).runtimeRoot), false);
  assert.equal(readFileSync(data, "utf8"), "registry");

  uninstallInstallation({ home, purge: true });
  assert.equal(existsSync(path.dirname(data)), false);
});

test("launchd XML escapes executable paths and environment values", () => {
  const paths = installationPaths("/Users/a&b");
  const plist = renderLaunchAgent(paths, "/path/a&b/node", "/bin:/a&b");
  assert.match(plist, /a&amp;b/);
  assert.doesNotMatch(plist, /<string>\/path\/a&b/);
});
