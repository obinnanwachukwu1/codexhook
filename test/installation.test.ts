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
  assert.match(readFileSync(paths.launchAgent, "utf8"), /--data-directory/);
  assert.match(
    readFileSync(paths.launchAgent, "utf8"),
    /<string>--port<\/string>\s*<string>51234<\/string>/,
  );
});

test("Windows setup uses ordinary files and a Task Scheduler launcher", () => {
  const { home, runtime, skill } = fixture();
  const manifest = setupInstallation({
    home,
    runtimeSource: runtime,
    skillSource: skill,
    platform: "win32",
    activate: false,
  });
  const paths = installationPaths(home, "win32");

  assert.equal(path.extname(paths.shim), ".cmd");
  assert.ok(existsSync(path.join(paths.currentLink, "codexhook.mjs")));
  assert.equal(
    installedRuntimePath(paths, "win32"),
    path.join(paths.currentLink, "codexhook.mjs"),
  );
  assert.match(readFileSync(paths.shim, "utf8"), /codexhook\.mjs/);
  assert.match(readFileSync(paths.shim, "utf8"), /CODEXHOOK_LAUNCHER/);
  assert.match(readFileSync(paths.shim, "utf8"), /del "%~f0"/);
  assert.match(readFileSync(paths.launchAgent, "utf8"), /--data-directory/);
  assert.match(
    readFileSync(paths.launchAgent, "utf8"),
    new RegExp(String(manifest.port)),
  );
});

test("Linux setup writes a restartable systemd user service", () => {
  const { home, runtime, skill } = fixture();
  setupInstallation({
    home,
    runtimeSource: runtime,
    skillSource: skill,
    platform: "linux",
    activate: false,
  });
  const paths = installationPaths(home, "linux");
  const unit = readFileSync(paths.launchAgent, "utf8");

  assert.match(paths.launchAgent, /\.config\/systemd\/user/);
  assert.match(unit, /Restart=on-failure/);
  assert.match(unit, /--data-directory/);
  assert.match(unit, /Environment="PATH=/);
  assert.match(unit, /WantedBy=default\.target/);
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
    baseUrl: "https://mac.example.test/codexhook",
    port: 51_234,
    activate: false,
  });
  const paths = installationPaths(home);
  const data = path.join(home, ".codexhook", "codexhook.sqlite");
  writeFileSync(data, "registry");

  uninstallInstallation({ home });
  assert.equal(existsSync(paths.currentLink), false);
  assert.equal(readInstallManifest(paths)?.port, 51_234);
  assert.equal(
    readInstallManifest(paths)?.baseUrl,
    "https://mac.example.test/codexhook",
  );
  assert.equal(readFileSync(data, "utf8"), "registry");

  const reinstalled = setupInstallation({
    home,
    runtimeSource: runtime,
    skillSource: skill,
    activate: false,
  });
  assert.equal(reinstalled.port, 51_234);
  assert.equal(reinstalled.baseUrl, "https://mac.example.test/codexhook");

  uninstallInstallation({ home, purge: true });
  assert.equal(existsSync(paths.runtimeRoot), false);
  assert.equal(existsSync(path.dirname(data)), false);
});

test("launchd XML escapes executable paths and environment values", () => {
  const paths = installationPaths("/Users/a&b");
  const plist = renderLaunchAgent(paths, "/path/a&b/node", "/bin:/a&b");
  assert.match(plist, /a&amp;b/);
  assert.doesNotMatch(plist, /<string>\/path\/a&b/);
});
