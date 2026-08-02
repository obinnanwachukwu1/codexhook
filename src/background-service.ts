import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";

export const SERVICE_NAME = "dev.codexhook.daemon";
const WINDOWS_TASK_NAME = "Codexhook";

export interface BackgroundServicePaths {
  readonly definition: string;
  readonly runtime: string;
  readonly log: string;
}

export interface BackgroundServiceConfig extends BackgroundServicePaths {
  readonly nodePath: string;
  readonly dataDirectory: string;
  readonly environmentPath: string;
  readonly port: number;
}

function xml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function systemd(value: string): string {
  return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

function batch(value: string): string {
  return value.replaceAll("%", "%%");
}

export function renderLaunchAgent(
  config: BackgroundServiceConfig,
): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${SERVICE_NAME}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${xml(config.nodePath)}</string>
    <string>${xml(config.runtime)}</string>
    <string>serve</string>
    <string>--port</string>
    <string>${config.port}</string>
    <string>--data-directory</string>
    <string>${xml(config.dataDirectory)}</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>${xml(config.environmentPath)}</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>StandardOutPath</key><string>${xml(config.log)}</string>
  <key>StandardErrorPath</key><string>${xml(config.log)}</string>
</dict>
</plist>
`;
}

export function renderSystemdService(
  config: BackgroundServiceConfig,
): string {
  const command = [
    config.nodePath,
    config.runtime,
    "serve",
    "--port",
    String(config.port),
    "--data-directory",
    config.dataDirectory,
  ].map(systemd).join(" ");
  return `[Unit]
Description=Codexhook webhook daemon

[Service]
Environment=${systemd(`PATH=${config.environmentPath}`)}
ExecStart=${command}
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
`;
}

export function renderWindowsService(
  config: BackgroundServiceConfig,
): string {
  return `@echo off\r
set "PATH=${batch(config.environmentPath)}"\r
"${batch(config.nodePath)}" "${batch(config.runtime)}" serve --port ${config.port} --data-directory "${batch(config.dataDirectory)}" >> "${batch(config.log)}" 2>&1\r
`;
}

function launchctl(
  arguments_: ReadonlyArray<string>,
  ignoreFailure = false,
): void {
  try {
    execFileSync("/bin/launchctl", [...arguments_], { stdio: "pipe" });
  } catch (error) {
    if (ignoreFailure) return;
    const detail =
      error instanceof Error && "stderr" in error
        ? String(error.stderr).trim()
        : String(error);
    throw new Error(`launchctl ${arguments_[0]} failed: ${detail}`);
  }
}

function userId(): number {
  if (process.getuid == null) {
    throw new Error("launchd user services require a Unix user id");
  }
  return process.getuid();
}

function powershell(script: string, ignoreFailure = false): void {
  try {
    execFileSync(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", script],
      { stdio: "pipe" },
    );
  } catch (error) {
    if (ignoreFailure) return;
    const detail =
      error instanceof Error && "stderr" in error
        ? String(error.stderr).trim()
        : String(error);
    throw new Error(`Windows Task Scheduler failed: ${detail}`);
  }
}

function ps(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function systemctl(
  arguments_: ReadonlyArray<string>,
  ignoreFailure = false,
): void {
  try {
    execFileSync("systemctl", ["--user", ...arguments_], {
      stdio: "pipe",
    });
  } catch (error) {
    if (ignoreFailure) return;
    const detail =
      error instanceof Error && "stderr" in error
        ? String(error.stderr).trim()
        : String(error);
    throw new Error(`systemctl --user ${arguments_[0]} failed: ${detail}`);
  }
}

export function installBackgroundService(
  paths: BackgroundServicePaths,
  platform: NodeJS.Platform = process.platform,
): void {
  if (platform === "darwin") {
    const domain = `gui/${userId()}`;
    launchctl(["bootout", domain, paths.definition], true);
    launchctl(["bootstrap", domain, paths.definition]);
    launchctl(["kickstart", "-k", `${domain}/${SERVICE_NAME}`]);
    return;
  }
  if (platform === "linux") {
    systemctl(["daemon-reload"]);
    systemctl(["enable", "--now", path.basename(paths.definition)]);
    systemctl(["restart", path.basename(paths.definition)]);
    return;
  }
  if (platform === "win32") {
    const action = [
      `Stop-ScheduledTask -TaskName ${ps(WINDOWS_TASK_NAME)} -ErrorAction SilentlyContinue`,
      `$action = New-ScheduledTaskAction -Execute $env:ComSpec -Argument ${ps(`/d /s /c ""${paths.definition}""`)} -WorkingDirectory ${ps(path.dirname(paths.definition))}`,
      "$trigger = New-ScheduledTaskTrigger -AtLogOn",
      "$principal = New-ScheduledTaskPrincipal -UserId ([System.Security.Principal.WindowsIdentity]::GetCurrent().Name) -LogonType Interactive -RunLevel Limited",
      "$settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) -MultipleInstances IgnoreNew",
      `Register-ScheduledTask -TaskName ${ps(WINDOWS_TASK_NAME)} -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Force | Out-Null`,
      `Start-ScheduledTask -TaskName ${ps(WINDOWS_TASK_NAME)}`,
    ].join("; ");
    powershell(action);
    return;
  }
  throw new Error(`background installation is unsupported on ${platform}`);
}

export function startBackgroundService(
  paths: BackgroundServicePaths,
  platform: NodeJS.Platform = process.platform,
): void {
  if (platform === "darwin") {
    launchctl([
      "kickstart",
      "-k",
      `gui/${userId()}/${SERVICE_NAME}`,
    ]);
    return;
  }
  if (platform === "linux") {
    systemctl(["restart", path.basename(paths.definition)]);
    return;
  }
  if (platform === "win32") {
    powershell(`Start-ScheduledTask -TaskName ${ps(WINDOWS_TASK_NAME)}`);
    return;
  }
  throw new Error(`background installation is unsupported on ${platform}`);
}

export function removeBackgroundService(
  paths: BackgroundServicePaths,
  platform: NodeJS.Platform = process.platform,
): void {
  if (platform === "darwin") {
    launchctl(
      ["bootout", `gui/${userId()}`, paths.definition],
      true,
    );
  } else if (platform === "linux") {
    systemctl(
      ["disable", "--now", path.basename(paths.definition)],
      true,
    );
    systemctl(["daemon-reload"], true);
  } else if (platform === "win32") {
    powershell(
      [
        `Stop-ScheduledTask -TaskName ${ps(WINDOWS_TASK_NAME)} -ErrorAction SilentlyContinue`,
        `$runtime = ${ps(paths.runtime)}`,
        "Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'node.exe' -and $_.CommandLine -ne $null -and $_.CommandLine.Contains($runtime) -and $_.CommandLine -match '\\sserve(?:\\s|$)' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }",
        `Unregister-ScheduledTask -TaskName ${ps(WINDOWS_TASK_NAME)} -Confirm:$false -ErrorAction SilentlyContinue`,
      ].join("; "),
      true,
    );
  }
}

export function backgroundServiceExists(
  paths: BackgroundServicePaths,
  platform: NodeJS.Platform = process.platform,
): boolean {
  if (!existsSync(paths.definition)) return false;
  if (platform !== "win32") return true;
  try {
    execFileSync(
      "schtasks.exe",
      ["/Query", "/TN", WINDOWS_TASK_NAME],
      { stdio: "ignore" },
    );
    return true;
  } catch {
    return false;
  }
}
