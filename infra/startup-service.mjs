/**
 * bosun — Startup Service Manager
 *
 * Cross-platform registration for auto-starting bosun on login/boot.
 * Supports:
 *   - Windows: Task Scheduler (schtasks)
 *   - macOS:   launchd (~/Library/LaunchAgents)
 *   - Linux:   systemd user units (~/.config/systemd/user)
 *
 * Usage:
 *   import { installStartupService, removeStartupService, getStartupStatus } from './startup-service.mjs';
 *
 *   await installStartupService({ daemon: true });  // Install with --daemon flag
 *   await removeStartupService();                   // Uninstall
 *   getStartupStatus();                             // Check current state
 */

import { execSync, spawnSync } from "node:child_process";
import {
  existsSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  unlinkSync,
} from "node:fs";
import { resolve, dirname, basename } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

const SERVICE_LABEL = "com.bosun.service";
const TASK_NAME = "Bosun";
const SYSTEMD_UNIT = "bosun.service";

// ── Platform Detection ───────────────────────────────────────────────────────

function getPlatform() {
  switch (process.platform) {
    case "win32":
      return "windows";
    case "darwin":
      return "macos";
    case "linux":
      return "linux";
    default:
      return "unsupported";
  }
}

// ── Path Helpers ─────────────────────────────────────────────────────────────

function getNodePath() {
  return process.execPath;
}

function getCliPath() {
  return resolve(__dirname, "..", "cli.mjs");
}

function getWorkingDirectory() {
  return __dirname;
}

function getLogDir() {
  const dir = resolve(__dirname, "..", "logs");
  mkdirSync(dir, { recursive: true });
  return dir;
}

// ── Windows: Task Scheduler ──────────────────────────────────────────────────

/**
 * Check whether the current process is running elevated (admin).
 */
function isElevated() {
  try {
    // net session succeeds only as admin
    execSync("net session", { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

/**
 * Get the Startup folder shortcut path (per-user, never needs admin).
 */
function getStartupShortcutPath() {
  const startupDir = resolve(
    homedir(),
    "AppData",
    "Roaming",
    "Microsoft",
    "Windows",
    "Start Menu",
    "Programs",
    "Startup",
  );
  return resolve(startupDir, `${TASK_NAME}.vbs`);
}

/**
 * Build the command string for launching bosun.
 */
function buildLaunchCommand({ daemon = true } = {}) {
  const nodePath = getNodePath();
  const cliPath = getCliPath();
  const daemonFlag = daemon ? " --daemon" : "";
  return `"${nodePath}" "${cliPath}"${daemonFlag}`;
}

function generateTaskSchedulerXml({ daemon = true } = {}) {
  const nodePath = getNodePath();
  const cliPath = getCliPath();
  const args = daemon ? `"${cliPath}" --daemon` : `"${cliPath}"`;

  return `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.4" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Description>Auto-start bosun AI orchestrator on login</Description>
    <Author>Bosun</Author>
    <URI>\\${TASK_NAME}</URI>
  </RegistrationInfo>
  <Triggers>
    <LogonTrigger>
      <Enabled>true</Enabled>
    </LogonTrigger>
  </Triggers>
  <Principals>
    <Principal id="Author">
      <LogonType>InteractiveToken</LogonType>
      <RunLevel>LeastPrivilege</RunLevel>
    </Principal>
  </Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <AllowHardTerminate>true</AllowHardTerminate>
    <StartWhenAvailable>true</StartWhenAvailable>
    <RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable>
    <AllowStartOnDemand>true</AllowStartOnDemand>
    <Enabled>true</Enabled>
    <Hidden>true</Hidden>
    <RunOnlyIfIdle>false</RunOnlyIfIdle>
    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>
    <Priority>7</Priority>
    <RestartOnFailure>
      <Interval>PT5M</Interval>
      <Count>3</Count>
    </RestartOnFailure>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>"${nodePath}"</Command>
      <Arguments>${args}</Arguments>
      <WorkingDirectory>${getWorkingDirectory()}</WorkingDirectory>
    </Exec>
  </Actions>
</Task>`;
}

/**
 * Attempt to run a schtasks command with UAC elevation via PowerShell.
 * Spawns an elevated PowerShell window and waits for completion.
 * @param {string} schtasksArgs - The schtasks arguments (e.g. '/Create /TN ...')
 * @returns {{ success: boolean, error?: string }}
 */
function runElevated(schtasksArgs) {
  // Build a PowerShell script that runs schtasks elevated and signals result
  const resultFile = resolve(__dirname, "..", ".cache", "elevation-result.txt");
  try {
    if (existsSync(resultFile)) unlinkSync(resultFile);
  } catch {
    /* ok */
  }

  // The inner script: run schtasks, write exit code to result file
  const innerScript = `
    try {
      $output = & schtasks ${schtasksArgs} 2>&1;
      $output | Out-String | Set-Content -Path '${resultFile.replace(/\\/g, "\\\\")}' -Encoding UTF8;
      if ($LASTEXITCODE -ne 0) { Add-Content -Path '${resultFile.replace(/\\/g, "\\\\")}' -Value "EXIT:$LASTEXITCODE" }
      else { Add-Content -Path '${resultFile.replace(/\\/g, "\\\\")}' -Value "EXIT:0" }
    } catch {
      "ERROR: $($_.Exception.Message)" | Set-Content -Path '${resultFile.replace(/\\/g, "\\\\")}' -Encoding UTF8;
      Add-Content -Path '${resultFile.replace(/\\/g, "\\\\")}' -Value "EXIT:1"
    }
  `.trim();

  // Encode the script as base64 for -EncodedCommand
  const encoded = Buffer.from(innerScript, "utf16le").toString("base64");

  // Launch elevated PowerShell with -Verb RunAs (this triggers the UAC prompt)
  const result = spawnSync(
    "powershell.exe",
    [
      "-NoProfile",
      "-Command",
      `Start-Process powershell.exe -ArgumentList '-NoProfile','-NonInteractive','-EncodedCommand','${encoded}' -Verb RunAs -Wait`,
    ],
    {
      stdio: "pipe",
      timeout: 60000, // 60s — UAC can take time
      windowsHide: false, // Must show the UAC dialog
    },
  );

  // Read result file
  try {
    if (existsSync(resultFile)) {
      const content = readFileSync(resultFile, "utf8").trim();
      unlinkSync(resultFile);
      const exitMatch = content.match(/EXIT:(\d+)/);
      const exitCode = exitMatch ? parseInt(exitMatch[1], 10) : 1;
      if (exitCode === 0) {
        return { success: true };
      }
      const errorMsg =
        content.replace(/EXIT:\d+/, "").trim() || "Elevated command failed";
      return { success: false, error: errorMsg };
    }
  } catch {
    /* fall through */
  }

  // No result file — user may have cancelled UAC
  if (result.status !== 0 || result.error) {
    return {
      success: false,
      error: result.error?.message || "UAC elevation was cancelled or failed",
    };
  }
  return {
    success: false,
    error: "Elevation result unknown — UAC may have been cancelled",
  };
}

/**
 * Install via Windows Startup folder (VBS wrapper). Never needs admin.
 * Creates a small VBScript that launches node with bosun.
 */
function installStartupFolder(options = {}) {
  const shortcutPath = getStartupShortcutPath();
  const launchCmd = buildLaunchCommand(options);

  // VBScript wrapper to start hidden (no flash console window)
  const vbsContent = `' Auto-generated by bosun setup
' Starts bosun on login via Startup folder
Set WshShell = CreateObject("WScript.Shell")
WshShell.CurrentDirectory = "${getWorkingDirectory().replace(/\\/g, "\\\\")}"
WshShell.Run ${JSON.stringify(launchCmd)}, 0, False
`;

  try {
    mkdirSync(dirname(shortcutPath), { recursive: true });
    writeFileSync(shortcutPath, vbsContent, "utf8");
    return {
      success: true,
      method: "Startup folder",
      name: basename(shortcutPath),
      path: shortcutPath,
    };
  } catch (err) {
    return {
      success: false,
      method: "Startup folder",
      error: err.message,
    };
  }
}

function removeStartupFolder() {
  const shortcutPath = getStartupShortcutPath();
  try {
    if (existsSync(shortcutPath)) {
      unlinkSync(shortcutPath);
    }
    return { success: true, method: "Startup folder" };
  } catch (err) {
    return { success: false, method: "Startup folder", error: err.message };
  }
}

function statusStartupFolder() {
  const shortcutPath = getStartupShortcutPath();
  return {
    installed: existsSync(shortcutPath),
    method: "Startup folder",
    path: shortcutPath,
  };
}

async function installWindows(options = {}) {
  const xmlContent = generateTaskSchedulerXml(options);
  const tmpXml = resolve(__dirname, "..", ".cache", `${TASK_NAME}.xml`);

  mkdirSync(dirname(tmpXml), { recursive: true });

  // Write as UTF-16 LE with BOM (required by schtasks)
  const buf = Buffer.from("\ufeff" + xmlContent, "utf16le");
  writeFileSync(tmpXml, buf);

  // Strategy 1: Try schtasks directly (works if already admin or policy allows)
  try {
    try {
      execSync(`schtasks /Delete /TN "${TASK_NAME}" /F`, { stdio: "ignore" });
    } catch {
      /* ok — task may not exist */
    }

    execSync(`schtasks /Create /TN "${TASK_NAME}" /XML "${tmpXml}" /F`, {
      stdio: "pipe",
    });

    try {
      unlinkSync(tmpXml);
    } catch {
      /* ok */
    }
    return { success: true, method: "Task Scheduler", name: TASK_NAME };
  } catch (directErr) {
    const isAccessDenied =
      directErr.message?.includes("Access is denied") ||
      directErr.message?.includes("access is denied") ||
      directErr.status === 1;

    if (!isAccessDenied) {
      try {
        unlinkSync(tmpXml);
      } catch {
        /* ok */
      }
      return {
        success: false,
        method: "Task Scheduler",
        error: directErr.message,
      };
    }

    // Strategy 2: Elevate via UAC prompt
    console.log(
      "  :help:  Admin access required — requesting elevation (UAC prompt)...",
    );

    // Delete + Create via elevated process
    const deleteArgs = `/Delete /TN "${TASK_NAME}" /F`;
    runElevated(deleteArgs); // ignore errors — may not exist

    const createArgs = `/Create /TN "${TASK_NAME}" /XML "${tmpXml.replace(/\\/g, "\\\\")}" /F`;
    const elevated = runElevated(createArgs);

    try {
      unlinkSync(tmpXml);
    } catch {
      /* ok */
    }

    if (elevated.success) {
      return {
        success: true,
        method: "Task Scheduler (elevated)",
        name: TASK_NAME,
      };
    }

    // Strategy 3: Fall back to Startup folder (no admin needed)
    console.log(
      "  :alert:  Task Scheduler elevation failed — falling back to Startup folder.",
    );
    console.log(
      "     (Startup folder works without admin, but has no auto-restart on failure)",
    );
    return installStartupFolder(options);
  }
}

async function removeWindows() {
  // Remove from both Task Scheduler and Startup folder (whichever exists)
  const results = [];

  // Try removing scheduled task
  try {
    execSync(`schtasks /Delete /TN "${TASK_NAME}" /F`, { stdio: "pipe" });
    results.push({ success: true, method: "Task Scheduler" });
  } catch (directErr) {
    const isAccessDenied =
      directErr.message?.includes("Access is denied") ||
      directErr.message?.includes("access is denied");

    if (isAccessDenied) {
      console.log(
        "  :help:  Admin access required — requesting elevation (UAC prompt)...",
      );
      const elevated = runElevated(`/Delete /TN "${TASK_NAME}" /F`);
      results.push({
        success: elevated.success,
        method: "Task Scheduler (elevated)",
        error: elevated.success ? undefined : elevated.error,
      });
    } else {
      // Task may simply not exist — that's fine
      results.push({ success: true, method: "Task Scheduler" });
    }
  }

  // Also remove startup folder shortcut if present
  const shortcutResult = removeStartupFolder();
  if (
    shortcutResult.success &&
    existsSync(getStartupShortcutPath()) === false
  ) {
    results.push(shortcutResult);
  }

  // Return combined result
  const anySuccess = results.some((r) => r.success);
  return {
    success: anySuccess,
    method: results.map((r) => r.method).join(" + "),
  };
}

function statusWindows() {
  // Check Task Scheduler first
  try {
    const output = execSync(`schtasks /Query /TN "${TASK_NAME}" /FO CSV /NH`, {
      encoding: "utf8",
      stdio: ["pipe", "pipe", "ignore"],
    }).trim();
    if (output && output.includes(TASK_NAME)) {
      const enabled = output.toLowerCase().includes("ready");
      return {
        installed: true,
        enabled,
        method: "Task Scheduler",
        name: TASK_NAME,
      };
    }
  } catch {
    /* not in Task Scheduler — check Startup folder */
  }

  // Check Startup folder fallback
  const folderStatus = statusStartupFolder();
  if (folderStatus.installed) {
    return { ...folderStatus, enabled: true };
  }

  return { installed: false, method: "Task Scheduler" };
}

// ── macOS: launchd ───────────────────────────────────────────────────────────

function getLaunchdPlistPath() {
  return resolve(
    homedir(),
    "Library",
    "LaunchAgents",
    `${SERVICE_LABEL}.plist`,
  );
}

function generateLaunchdPlist({ daemon = true } = {}) {
  const nodePath = getNodePath();
  const cliPath = getCliPath();
  const logDir = getLogDir();
  const home = homedir();
  const args = daemon ? [nodePath, cliPath, "--daemon"] : [nodePath, cliPath];

  const argsXml = args.map((a) => `        <string>${a}</string>`).join("\n");

  // Include Homebrew paths for both Apple Silicon (/opt/homebrew) and Intel (/usr/local)
  const pathValue = [
    `${home}/.local/bin`,
    "/opt/homebrew/bin",
    "/opt/homebrew/sbin",
    "/usr/local/bin",
    "/usr/bin",
    "/bin",
    "/usr/sbin",
    "/sbin",
  ].join(":");

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>${SERVICE_LABEL}</string>
    <key>ProgramArguments</key>
    <array>
${argsXml}
    </array>
    <key>WorkingDirectory</key>
    <string>${getWorkingDirectory()}</string>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <dict>
        <key>SuccessfulExit</key>
        <false/>
    </dict>
    <key>ThrottleInterval</key>
    <integer>30</integer>
    <key>AbandonProcessGroup</key>
    <true/>
    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key>
        <string>${pathValue}</string>
        <key>HOME</key>
        <string>${home}</string>
        <key>NODE_ENV</key>
        <string>production</string>
    </dict>
    <key>StandardOutPath</key>
    <string>${logDir}/startup.log</string>
    <key>StandardErrorPath</key>
    <string>${logDir}/startup.error.log</string>
</dict>
</plist>`;
}

async function installMacOS(options = {}) {
  const plistPath = getLaunchdPlistPath();
  const plistContent = generateLaunchdPlist(options);

  try {
    // Unload/bootout existing agent if present
    try {
      // Try modern bootout first (macOS 10.11+), fall back to legacy unload
      const uid = process.getuid?.() ?? "";
      if (uid !== "") {
        execSync(`launchctl bootout gui/${uid} "${plistPath}" 2>/dev/null || launchctl unload "${plistPath}" 2>/dev/null`, { stdio: "ignore", shell: true });
      } else {
        execSync(`launchctl unload "${plistPath}"`, { stdio: "ignore" });
      }
    } catch {
      /* ok — agent may not be loaded */
    }

    mkdirSync(dirname(plistPath), { recursive: true });
    writeFileSync(plistPath, plistContent, "utf8");

    // Prefer modern bootstrap domain (macOS 10.11+); fall back to legacy load
    let loaded = false;
    try {
      const uid = process.getuid?.() ?? "";
      if (uid !== "") {
        execSync(`launchctl bootstrap gui/${uid} "${plistPath}"`, { stdio: "pipe" });
        loaded = true;
      }
    } catch {
      /* fall through to legacy load */
    }
    if (!loaded) {
      execSync(`launchctl load "${plistPath}"`, { stdio: "pipe" });
    }

    return {
      success: true,
      method: "launchd",
      name: SERVICE_LABEL,
      path: plistPath,
    };
  } catch (err) {
    const isPermission =
      err.message?.includes("Permission denied") ||
      err.message?.includes("Operation not permitted") ||
      err.message?.includes("EACCES");

    if (!isPermission) {
      return { success: false, method: "launchd", error: err.message };
    }

    // Try with sudo — prompts for password in terminal via osascript or direct sudo
    console.log("  :help:  Permission required — requesting sudo access...");
    try {
      // Write plist to temp location first
      const tmpPlist = resolve(__dirname, "..", ".cache", `${SERVICE_LABEL}.plist`);
      mkdirSync(dirname(tmpPlist), { recursive: true });
      writeFileSync(tmpPlist, plistContent, "utf8");

      // Use osascript to prompt for admin credentials (shows macOS auth dialog)
      const escapedPlistPath = plistPath.replace(/'/g, "'\''");
      const escapedTmpPlist = tmpPlist.replace(/'/g, "'\''");
      const script = [
        `do shell script "`,
        `mkdir -p '${dirname(escapedPlistPath)}' && `,
        `cp '${escapedTmpPlist}' '${escapedPlistPath}' && `,
        `launchctl load '${escapedPlistPath}'`,
        `" with administrator privileges`,
      ].join("");

      execSync(`osascript -e '${script.replace(/'/g, "'\''")}'`, {
        stdio: "pipe",
        timeout: 60000,
      });

      try {
        unlinkSync(tmpPlist);
      } catch {
        /* ok */
      }

      return {
        success: true,
        method: "launchd (elevated)",
        name: SERVICE_LABEL,
        path: plistPath,
      };
    } catch (sudoErr) {
      return {
        success: false,
        method: "launchd",
        error:
          `Elevation failed: ${sudoErr.message}. You can install manually:\n` +
          `  sudo cp <plist> ${plistPath}\n` +
          `  launchctl load ${plistPath}`,
      };
    }
  }
}

async function removeMacOS() {
  const plistPath = getLaunchdPlistPath();
  try {
    try {
      // Prefer modern bootout; fall back to legacy unload
      const uid = process.getuid?.() ?? "";
      if (uid !== "") {
        execSync(
          `launchctl bootout gui/${uid} "${plistPath}" 2>/dev/null || launchctl unload "${plistPath}" 2>/dev/null`,
          { stdio: "ignore", shell: true },
        );
      } else {
        execSync(`launchctl unload "${plistPath}"`, { stdio: "ignore" });
      }
    } catch {
      /* ok */
    }
    if (existsSync(plistPath)) {
      unlinkSync(plistPath);
    }
    return { success: true, method: "launchd" };
  } catch (err) {
    const isPermission =
      err.message?.includes("Permission denied") ||
      err.message?.includes("Operation not permitted") ||
      err.message?.includes("EACCES");

    if (!isPermission) {
      return { success: false, method: "launchd", error: err.message };
    }

    // Elevate via osascript
    console.log("  :help:  Permission required — requesting sudo access...");
    try {
      const escapedPlistPath = plistPath.replace(/'/g, "'\\''");
      const script = `do shell script "launchctl unload '${escapedPlistPath}' 2>/dev/null; rm -f '${escapedPlistPath}'" with administrator privileges`;
      execSync(`osascript -e '${script.replace(/'/g, "'\\''")}'`, {
        stdio: "pipe",
        timeout: 60000,
      });
      return { success: true, method: "launchd (elevated)" };
    } catch (sudoErr) {
      return {
        success: false,
        method: "launchd",
        error: `Elevation failed: ${sudoErr.message}`,
      };
    }
  }
}

function statusMacOS() {
  const plistPath = getLaunchdPlistPath();
  if (!existsSync(plistPath)) {
    return { installed: false, method: "launchd" };
  }
  try {
    const output = execSync(`launchctl list`, {
      encoding: "utf8",
      stdio: ["pipe", "pipe", "ignore"],
    });
    const running = output.includes(SERVICE_LABEL);
    return {
      installed: true,
      enabled: true,
      running,
      method: "launchd",
      name: SERVICE_LABEL,
      path: plistPath,
    };
  } catch {
    return {
      installed: true,
      enabled: true,
      method: "launchd",
      path: plistPath,
    };
  }
}

// ── Linux: systemd user unit ─────────────────────────────────────────────────

/**
 * Check if systemd user session (--user) is available.
 * Not all Linux environments support it (e.g., WSL1, containers, no logind).
 */
function hasSystemdUser() {
  try {
    execSync("systemctl --user --no-pager status", {
      stdio: "ignore",
      timeout: 5000,
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Get the crontab-based fallback marker.
 */
function getCronMarker() {
  return `# bosun-autostart`;
}

function getSystemdUnitPath() {
  return resolve(homedir(), ".config", "systemd", "user", SYSTEMD_UNIT);
}

function generateSystemdUnit({ daemon = false } = {}) {
  // systemd handles daemonization — we do NOT use --daemon flag here
  const nodePath = getNodePath();
  const cliPath = getCliPath();
  const logDir = getLogDir();

  return `[Unit]
Description=bosun — AI Orchestrator Supervisor
Documentation=https://www.npmjs.com/package/bosun
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=${nodePath} ${cliPath}
WorkingDirectory=${getWorkingDirectory()}
Restart=on-failure
RestartSec=30
StandardOutput=append:${logDir}/startup.log
StandardError=append:${logDir}/startup.error.log
Environment=NODE_ENV=production
Environment=HOME=${homedir()}
Environment=PATH=${homedir()}/.local/bin:/usr/local/bin:/usr/bin:/bin

[Install]
WantedBy=default.target
`;
}

async function installLinux(options = {}) {
  const unitPath = getSystemdUnitPath();
  // systemd handles service lifecycle — never pass --daemon
  const unitContent = generateSystemdUnit({ ...options, daemon: false });

  // Strategy 1: systemd --user (preferred, no root needed)
  if (hasSystemdUser()) {
    try {
      mkdirSync(dirname(unitPath), { recursive: true });
      writeFileSync(unitPath, unitContent, "utf8");

      execSync("systemctl --user daemon-reload", { stdio: "pipe" });
      execSync(`systemctl --user enable ${SYSTEMD_UNIT}`, { stdio: "pipe" });
      execSync(`systemctl --user start ${SYSTEMD_UNIT}`, { stdio: "pipe" });

      return {
        success: true,
        method: "systemd",
        name: SYSTEMD_UNIT,
        path: unitPath,
      };
    } catch (err) {
      const isPermission =
        err.message?.includes("Permission denied") ||
        err.message?.includes("EACCES") ||
        err.message?.includes("Access denied");

      if (!isPermission) {
        return { success: false, method: "systemd", error: err.message };
      }

      // Try with sudo for the systemctl commands (unit file is user-space)
      console.log("  :help:  Permission required — trying sudo...");
      try {
        // The unit file write doesn't need sudo (it's in ~/.config)
        // but systemctl might if the session isn't fully initialized
        execSync(`sudo systemctl --user daemon-reload`, { stdio: "inherit" });
        execSync(`sudo systemctl --user enable ${SYSTEMD_UNIT}`, {
          stdio: "inherit",
        });
        execSync(`sudo systemctl --user start ${SYSTEMD_UNIT}`, {
          stdio: "inherit",
        });

        return {
          success: true,
          method: "systemd (sudo)",
          name: SYSTEMD_UNIT,
          path: unitPath,
        };
      } catch (sudoErr) {
        console.log(
          "  :alert:  systemd with sudo failed — falling back to crontab.",
        );
        // Fall through to crontab
      }
    }
  } else {
    console.log("  :help:  systemd user session not available — using crontab.");
  }

  // Strategy 2: crontab @reboot fallback (works everywhere, no root needed)
  return installCrontab(options);
}

/**
 * Install via crontab @reboot entry. Works on any Linux without root.
 */
function installCrontab(options = {}) {
  const nodePath = getNodePath();
  const cliPath = getCliPath();
  const logDir = getLogDir();
  const marker = getCronMarker();
  const daemon = options.daemon !== false ? " --daemon" : "";
  const cronLine = `@reboot cd ${getWorkingDirectory()} && ${nodePath} ${cliPath}${daemon} >> ${logDir}/startup.log 2>> ${logDir}/startup.error.log ${marker}`;

  try {
    // Get current crontab
    let existing = "";
    try {
      existing = execSync("crontab -l", {
        encoding: "utf8",
        stdio: ["pipe", "pipe", "ignore"],
      });
    } catch {
      /* no crontab yet — that's fine */
    }

    // Remove any existing bosun entry
    const lines = existing.split("\n").filter((l) => !l.includes(marker));
    lines.push(cronLine);

    // Write new crontab
    const newCrontab =
      lines
        .join("\n")
        .replace(/\n{3,}/g, "\n\n")
        .trim() + "\n";
    execSync("crontab -", {
      input: newCrontab,
      stdio: ["pipe", "pipe", "pipe"],
    });

    return {
      success: true,
      method: "crontab @reboot",
      name: "crontab",
    };
  } catch (err) {
    return {
      success: false,
      method: "crontab",
      error: err.message,
    };
  }
}

async function removeLinux() {
  const results = [];

  // Remove systemd unit if present
  const unitPath = getSystemdUnitPath();
  if (existsSync(unitPath)) {
    try {
      try {
        execSync(`systemctl --user stop ${SYSTEMD_UNIT}`, { stdio: "ignore" });
      } catch {
        /* ok */
      }
      try {
        execSync(`systemctl --user disable ${SYSTEMD_UNIT}`, {
          stdio: "ignore",
        });
      } catch {
        /* ok */
      }
      unlinkSync(unitPath);
      execSync("systemctl --user daemon-reload", { stdio: "ignore" });
      results.push({ success: true, method: "systemd" });
    } catch (err) {
      const isPermission =
        err.message?.includes("Permission denied") ||
        err.message?.includes("EACCES");

      if (isPermission) {
        console.log("  :help:  Permission required — trying sudo...");
        try {
          execSync(`sudo systemctl --user stop ${SYSTEMD_UNIT}`, {
            stdio: "inherit",
          });
          execSync(`sudo systemctl --user disable ${SYSTEMD_UNIT}`, {
            stdio: "inherit",
          });
          if (existsSync(unitPath)) unlinkSync(unitPath);
          execSync("sudo systemctl --user daemon-reload", { stdio: "inherit" });
          results.push({ success: true, method: "systemd (sudo)" });
        } catch (sudoErr) {
          results.push({
            success: false,
            method: "systemd",
            error: sudoErr.message,
          });
        }
      } else {
        results.push({ success: false, method: "systemd", error: err.message });
      }
    }
  }

  // Remove crontab entry if present
  const marker = getCronMarker();
  try {
    const existing = execSync("crontab -l", {
      encoding: "utf8",
      stdio: ["pipe", "pipe", "ignore"],
    });
    if (existing.includes(marker)) {
      const filtered =
        existing
          .split("\n")
          .filter((l) => !l.includes(marker))
          .join("\n")
          .replace(/\n{3,}/g, "\n\n")
          .trim() + "\n";
      execSync("crontab -", {
        input: filtered,
        stdio: ["pipe", "pipe", "pipe"],
      });
      results.push({ success: true, method: "crontab" });
    }
  } catch {
    /* no crontab — fine */
  }

  if (results.length === 0) {
    return { success: true, method: "none (nothing to remove)" };
  }

  const anySuccess = results.some((r) => r.success);
  return {
    success: anySuccess,
    method: results.map((r) => r.method).join(" + "),
    error: anySuccess
      ? undefined
      : results
          .map((r) => r.error)
          .filter(Boolean)
          .join("; "),
  };
}

function statusLinux() {
  // Check systemd first
  const unitPath = getSystemdUnitPath();
  if (existsSync(unitPath)) {
    try {
      const output = execSync(`systemctl --user is-active ${SYSTEMD_UNIT}`, {
        encoding: "utf8",
        stdio: ["pipe", "pipe", "ignore"],
      }).trim();
      return {
        installed: true,
        enabled: true,
        running: output === "active",
        method: "systemd",
        name: SYSTEMD_UNIT,
        path: unitPath,
      };
    } catch {
      return {
        installed: true,
        enabled: true,
        running: false,
        method: "systemd",
        name: SYSTEMD_UNIT,
        path: unitPath,
      };
    }
  }

  // Check crontab fallback
  const marker = getCronMarker();
  try {
    const existing = execSync("crontab -l", {
      encoding: "utf8",
      stdio: ["pipe", "pipe", "ignore"],
    });
    if (existing.includes(marker)) {
      return {
        installed: true,
        enabled: true,
        method: "crontab @reboot",
        name: "crontab",
      };
    }
  } catch {
    /* no crontab */
  }

  return { installed: false, method: "systemd" };
}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Install bosun as a startup service.
 * @param {{ daemon?: boolean }} options  Whether to start in daemon mode (default: true)
 * @returns {Promise<{ success: boolean, method: string, error?: string, name?: string, path?: string }>}
 */
export async function installStartupService(options = {}) {
  const opts = { daemon: true, ...options };
  const platform = getPlatform();

  switch (platform) {
    case "windows":
      return installWindows(opts);
    case "macos":
      return installMacOS(opts);
    case "linux":
      return installLinux(opts);
    default:
      return {
        success: false,
        method: "none",
        error: `Unsupported platform: ${process.platform}`,
      };
  }
}

/**
 * Remove bosun from startup services.
 * @returns {Promise<{ success: boolean, method: string, error?: string }>}
 */
export async function removeStartupService() {
  const platform = getPlatform();

  switch (platform) {
    case "windows":
      return removeWindows();
    case "macos":
      return removeMacOS();
    case "linux":
      return removeLinux();
    default:
      return {
        success: false,
        method: "none",
        error: `Unsupported platform: ${process.platform}`,
      };
  }
}

/**
 * Get the current startup service status.
 * @returns {{ installed: boolean, enabled?: boolean, running?: boolean, method: string, name?: string, path?: string }}
 */
export function getStartupStatus() {
  const platform = getPlatform();

  switch (platform) {
    case "windows":
      return statusWindows();
    case "macos":
      return statusMacOS();
    case "linux":
      return statusLinux();
    default:
      return { installed: false, method: "none" };
  }
}

/**
 * Get human-readable platform method name.
 * @returns {string}
 */
export function getStartupMethodName() {
  const platform = getPlatform();
  switch (platform) {
    case "windows":
      return "Windows Task Scheduler";
    case "macos":
      return "macOS launchd";
    case "linux":
      return "systemd user service";
    default:
      return "unsupported";
  }
}
