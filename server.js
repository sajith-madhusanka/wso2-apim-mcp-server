// WSO2 APIM 4.6.0 Distributed Deployment — MCP Server
// Exposes tools and resources for managing the deployment lifecycle.
//
// Configuration is loaded from config.json next to this file.
// Copy config.example.json → config.json and edit for your environment.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { exec, execSync, spawn } from "child_process";
import { promisify } from "util";
import { readFileSync, writeFileSync, existsSync } from "fs";
import { createRequire } from "module";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { z } from "zod";

const execAsync = promisify(exec);

// ─── Interactive update runner ────────────────────────────────────────────────
// Runs wso2update via spawn so we can handle interactive prompts:
//   • Credential prompts  → auto-feed username/password from config
//   • Conflict prompts    → auto-respond based on conflictResolution strategy
//   • "Continue?" prompts → always confirm with 'y'
//
// Returns { stdout, stderr, conflicts, exitCode }
//   conflicts: array of { file, resolution } describing every conflict found
function runUpdateInteractive(toolPath, args, { cwd, env, credentials, conflictResolution = "keep-local", timeoutMs = 300000 }) {
  return new Promise((resolve) => {
    const proc = spawn(toolPath, args, {
      cwd,
      env,
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    const conflicts = [];
    let timer;

    const feed = (text) => {
      try { proc.stdin.write(text); } catch { /* stdin may be closed */ }
    };

    // Keep a rolling buffer to catch prompts that span chunk boundaries
    let buffer = "";

    const handleChunk = (chunk) => {
      const text = chunk.toString();
      stdout += text;
      buffer += text;

      // Only process the latest 512 chars to avoid re-matching old output
      if (buffer.length > 512) buffer = buffer.slice(-512);

      // ── Credential prompts ──────────────────────────────────────────────────
      if (/email\s*[:\?]/i.test(buffer) || /username\s*[:\?]/i.test(buffer)) {
        if (credentials?.username) {
          feed(credentials.username + "\n");
          buffer = "";
        }
      }
      if (/password\s*[:\?]/i.test(buffer)) {
        if (credentials?.password) {
          feed(credentials.password + "\n");
          buffer = "";
        }
      }

      // ── Conflict prompts ────────────────────────────────────────────────────
      // WSO2 update tool: "CONFLICT (content): <file>" or "Modified: <file>"
      const conflictLine = buffer.match(/CONFLICT[^\n]*:\s*([^\n]+)/i);
      if (conflictLine) {
        conflicts.push({ file: conflictLine[1].trim(), resolution: conflictResolution });
      }

      // "Do you want to keep your local changes? [Y/n]:" or similar
      if (/keep\s+(your|local)\s+change/i.test(buffer) || /keep.*\[Y\/n\]/i.test(buffer)) {
        const answer = conflictResolution === "keep-local" ? "y\n" : "n\n";
        feed(answer);
        buffer = "";
      }

      // "Do you want to use the updated version? [y/N]:"
      if (/use.*updated\s+version/i.test(buffer) || /overwrite.*\[y\/N\]/i.test(buffer)) {
        const answer = conflictResolution === "use-update" ? "y\n" : "n\n";
        feed(answer);
        buffer = "";
      }

      // Generic continue/confirm prompts
      if (/\bdo you want to continue\b.*\[y\/N\]/i.test(buffer) ||
          /\bcontinue\?.*\[y\/N\]/i.test(buffer)) {
        feed("y\n");
        buffer = "";
      }
    };

    proc.stdout.on("data", handleChunk);
    proc.stderr.on("data", (chunk) => {
      const text = chunk.toString();
      stderr += text;
      // stderr can also contain prompts
      buffer += text;
      handleChunk(Buffer.from(""));  // re-run prompt detection with updated buffer
    });

    timer = setTimeout(() => {
      proc.kill("SIGTERM");
      resolve({ stdout, stderr, conflicts, exitCode: -1, timedOut: true });
    }, timeoutMs);

    proc.on("close", (code) => {
      clearTimeout(timer);
      resolve({ stdout, stderr, conflicts, exitCode: code ?? 0, timedOut: false });
    });

    proc.on("error", (err) => {
      clearTimeout(timer);
      resolve({ stdout, stderr: err.message, conflicts, exitCode: -1, timedOut: false });
    });
  });
}

// ─── Load Configuration ───────────────────────────────────────────────────────

const __dirname = dirname(fileURLToPath(import.meta.url));
const configPath = join(__dirname, "config.json");

if (!existsSync(configPath)) {
  process.stderr.write(
    `ERROR: config.json not found.\n` +
    `Copy config.example.json to config.json and edit it for your environment.\n` +
    `  cp ${join(__dirname, "config.example.json")} ${configPath}\n`
  );
  process.exit(1);
}

const CONFIG = JSON.parse(readFileSync(configPath, "utf8"));

// ─── Helpers ─────────────────────────────────────────────────────────────────

function componentPath(key, ...parts) {
  return [CONFIG.baseDir, CONFIG.components[key].dir, ...parts].join("/");
}

// Detect whether a component's JVM is running.
// Strategy (in order):
//   1. PID file exists + process.kill(pid, 0) succeeds → running (fast path)
//   2. No PID file / stale PID → scan `ps` for a Java process whose args
//      contain "-Dcarbon.home=<componentDir>" (reliable even after restarts
//      that left the PID file missing or outdated)
// Returns { running: boolean, pid: number|null, via: string }
function isRunningInfo(key) {
  const componentDir = `${CONFIG.baseDir}/${CONFIG.components[key].dir}`;
  const pidFile = `${componentDir}/${CONFIG.components[key].pidFile}`;

  // 1. PID-file fast path
  if (existsSync(pidFile)) {
    const raw = readFileSync(pidFile, "utf8").trim();
    const pid = Number(raw);
    if (pid > 0) {
      try { process.kill(pid, 0); return { running: true, pid, via: "pidfile" }; } catch { /* stale */ }
    }
  }

  // 2. Process scan fallback — find a Java process with -Dcarbon.home=<componentDir>
  try {
    const { stdout } = execSync(
      `ps ax -o pid,args | grep "Dcarbon.home=${componentDir}" | grep -v grep`,
      { encoding: "utf8" }
    );
    const line = stdout.trim().split("\n").find(l => l.trim().length > 0);
    if (line) {
      const pid = parseInt(line.trim().split(/\s+/)[0]);
      return { running: true, pid: isNaN(pid) ? null : pid, via: "ps-scan" };
    }
  } catch { /* grep exits 1 when nothing matches = not running */ }

  return { running: false, pid: null, via: "none" };
}

// Convenience boolean wrapper (used throughout existing code)
function isRunning(key) {
  return isRunningInfo(key).running;
}

function readLog(key, lines = 50) {
  const logFile = componentPath(key, CONFIG.components[key].logFile);
  if (!existsSync(logFile)) return "(log file not found)";
  try {
    const { stdout } = execSync(`tail -${lines} "${logFile}"`, { encoding: "utf8" });
    return stdout;
  } catch {
    return "(could not read log)";
  }
}

function hasStarted(key) {
  const logFile = componentPath(key, CONFIG.components[key].logFile);
  if (!existsSync(logFile)) return false;
  try {
    const content = execSync(`grep -c "Mgt Console URL" "${logFile}" 2>/dev/null || echo 0`, { encoding: "utf8" });
    return parseInt(content.trim()) > 0;
  } catch { return false; }
}

// ─── MCP Server ──────────────────────────────────────────────────────────────

const server = new McpServer({
  name: "wso2-apim",
  version: "1.0.0",
});

// ── Tool: start_component ────────────────────────────────────────────────────
server.tool(
  "start_component",
  "Start a WSO2 APIM 4.6.0 component (tm | acp | gw). Start order: tm → acp → gw.",
  { component: z.enum(["km", "tm", "acp", "gw"]).describe("Component to start: km, tm, acp, or gw") },
  async ({ component }) => {
    const c = CONFIG.components[component];
    if (isRunning(component)) {
      return { content: [{ type: "text", text: `✅ ${c.label} is already running (port ${c.mgtPort}).` }] };
    }

    // Clear stale metadata so config is regenerated fresh
    const metaBase = componentPath(component, "repository/resources/conf/.metadata");
    await execAsync(`rm -f "${metaBase}/metadata_config.properties" "${metaBase}/metadata_template.properties"`);

    const script = componentPath(component, c.script);
    await execAsync(`"${script}" start`);

    // Rapid-poll the log every 2s (up to 90s) for startup signal
    const logFile = componentPath(component, c.logFile);
    const pollResult = await new Promise((resolve) => {
      let attempts = 0;
      const maxAttempts = 45;
      const interval = setInterval(() => {
        attempts++;
        try {
          const log = readFileSync(logFile, "utf8");
          if (log.includes("Mgt Console URL")) {
            clearInterval(interval);
            const match = log.match(/Mgt Console URL\s*:\s*(\S+)/);
            resolve({ started: true, url: match ? match[1] : `https://localhost:${c.mgtPort}/carbon/`, elapsed: attempts * 2 });
          } else {
            const errLine = log.split("\n").reverse().find(l => l.includes("ERROR") && !l.includes("eventHub") && !l.includes("OutputEvent"));
            if (attempts >= maxAttempts) {
              clearInterval(interval);
              resolve({ started: false, error: errLine || "Timed out after 90s", elapsed: attempts * 2 });
            }
          }
        } catch { /* log not yet written */ }
      }, 2000);
    });

    if (pollResult.started) {
      return {
        content: [{
          type: "text",
          text: `✅ ${c.label} started in ~${pollResult.elapsed}s\n` +
                `Management URL: ${pollResult.url}\n` +
                `Credentials: admin / admin`,
        }],
      };
    } else {
      return {
        content: [{
          type: "text",
          text: `⚠️ ${c.label} did not confirm startup within 90s.\n` +
                `Last error: ${pollResult.error}\n` +
                `Check logs: ${logFile}`,
        }],
      };
    }
  }
);

// ── Tool: stop_component ─────────────────────────────────────────────────────
server.tool(
  "stop_component",
  "Gracefully stop a WSO2 APIM 4.6.0 component using its shutdown script (tm | km | acp | gw). " +
  "After issuing the stop command, polls the log every 2s for 'Halting JVM' to confirm clean shutdown. " +
  "Stop order: GW → ACP → KM → TM.",
  { component: z.enum(["km", "tm", "acp", "gw"]).describe("Component to stop") },
  async ({ component }) => {
    const c = CONFIG.components[component];

    const info = isRunningInfo(component);
    if (!info.running) {
      return { content: [{ type: "text", text: `⚠️  ${c.label} is not running (checked pidfile + ps-scan).` }] };
    }

    const script  = componentPath(component, c.script);
    const logFile = componentPath(component, c.logFile);

    try {
      await execAsync(`"${script}" stop`);
    } catch (err) {
      return { content: [{ type: "text", text: `❌ Failed to stop ${c.label}:\n${err.message}` }] };
    }

    // Poll the log every 2s (up to 60s) for "Halting JVM", also confirm process exit
    const result = await new Promise((resolve) => {
      let attempts = 0;
      const MAX = 30; // 30 × 2s = 60s
      let lastLogSize = 0;
      const logLines = [];

      const iv = setInterval(() => {
        attempts++;

        // Collect any new log lines
        try {
          const content = readFileSync(logFile, "utf8");
          if (content.length > lastLogSize) {
            const newText = content.slice(lastLogSize);
            lastLogSize = content.length;
            newText.split("\n").filter(Boolean).forEach(l => logLines.push(l));
          }
          if (logLines.some(l => l.includes("Halting JVM"))) {
            clearInterval(iv);
            return resolve({ stopped: true, how: "log", elapsed: attempts * 2, logLines });
          }
        } catch { /* log not yet readable */ }

        // Also check process is gone (belt-and-suspenders)
        if (!isRunning(component)) {
          clearInterval(iv);
          return resolve({ stopped: true, how: "process", elapsed: attempts * 2, logLines });
        }

        if (attempts >= MAX) {
          clearInterval(iv);
          resolve({ stopped: false, elapsed: MAX * 2, logLines });
        }
      }, 2000);
    });

    const recentLines = result.logLines.slice(-6).join("\n");
    if (result.stopped) {
      const howMsg = result.how === "log"
        ? `✅ "Halting JVM" confirmed in log after ${result.elapsed}s`
        : `✅ Process exited after ${result.elapsed}s (log confirmation pending)`;
      return {
        content: [{
          type: "text",
          text: `🛑 ${c.label} stopped.\n${howMsg}\n\nLast log lines:\n${recentLines || "(none)"}`,
        }],
      };
    }
    return {
      content: [{
        type: "text",
        text: `⚠️  ${c.label} stop command issued but "Halting JVM" not seen after ${result.elapsed}s.\nCheck with check_status or view_logs.\n\nLast log lines:\n${recentLines || "(none)"}`,
      }],
    };
  }
);

// ── Tool: stop_all ───────────────────────────────────────────────────────────
server.tool(
  "stop_all",
  "Gracefully stop all WSO2 APIM 4.6.0 components in the correct order: GW → ACP → KM → TM. " +
  "After each stop command, polls the log every 2s for 'Halting JVM' to confirm clean shutdown.",
  {},
  async () => {
    const stopOrder = ["gw", "acp", "km", "tm"];
    const results = [];

    for (const component of stopOrder) {
      const c = CONFIG.components[component];
      if (!isRunning(component)) {
        results.push(`⚪ ${c.label} — already stopped`);
        continue;
      }

      const script  = componentPath(component, c.script);
      const logFile = componentPath(component, c.logFile);

      try {
        await execAsync(`"${script}" stop`);
      } catch (err) {
        results.push(`❌ ${c.label} — error issuing stop: ${err.message.split("\n")[0]}`);
        continue;
      }

      // Poll log for "Halting JVM" (up to 60s)
      const result = await new Promise((resolve) => {
        let attempts = 0;
        const MAX = 30;
        let lastLogSize = 0;
        const logLines = [];

        const iv = setInterval(() => {
          attempts++;

          try {
            const content = readFileSync(logFile, "utf8");
            if (content.length > lastLogSize) {
              const newText = content.slice(lastLogSize);
              lastLogSize = content.length;
              newText.split("\n").filter(Boolean).forEach(l => logLines.push(l));
            }
            if (logLines.some(l => l.includes("Halting JVM"))) {
              clearInterval(iv);
              return resolve({ stopped: true, how: "log", elapsed: attempts * 2 });
            }
          } catch { /* log not yet readable */ }

          if (!isRunning(component)) {
            clearInterval(iv);
            return resolve({ stopped: true, how: "process", elapsed: attempts * 2 });
          }

          if (attempts >= MAX) {
            clearInterval(iv);
            resolve({ stopped: false, elapsed: MAX * 2 });
          }
        }, 2000);
      });

      if (result.stopped) {
        const howMsg = result.how === "log"
          ? `"Halting JVM" in log (${result.elapsed}s)`
          : `process exited (${result.elapsed}s)`;
        results.push(`🛑 ${c.label} — stopped [${howMsg}]`);
      } else {
        results.push(`⚠️  ${c.label} — stop issued but "Halting JVM" not seen after ${result.elapsed}s`);
      }
    }

    return { content: [{ type: "text", text: "Stop All Results:\n" + results.join("\n") }] };
  }
);

// ── Tool: start_all ──────────────────────────────────────────────────────────
server.tool(
  "start_all",
  "Start all WSO2 APIM 4.6.0 components in the correct order: TM → KM → ACP → GW.",
  {},
  async () => {
    const startOrder = ["tm", "km", "acp", "gw"];
    const results = [];

    for (const component of startOrder) {
      const c = CONFIG.components[component];
      if (isRunning(component)) {
        results.push(`✅ ${c.label} — already running (port ${c.mgtPort})`);
        continue;
      }
      try {
        // Clear stale metadata
        const metaBase = componentPath(component, "repository/resources/conf/.metadata");
        await execAsync(`rm -f "${metaBase}/metadata_config.properties" "${metaBase}/metadata_template.properties"`);

        const script = componentPath(component, c.script);
        await execAsync(`"${script}" start`);

        const logFile = componentPath(component, c.logFile);
        const pollResult = await new Promise((resolve) => {
          let attempts = 0;
          const iv = setInterval(() => {
            attempts++;
            try {
              const log = readFileSync(logFile, "utf8");
              if (log.includes("Mgt Console URL")) {
                clearInterval(iv);
                resolve({ started: true, elapsed: attempts * 2 });
              } else if (attempts >= 45) {
                clearInterval(iv);
                const errLine = log.split("\n").reverse().find(l => l.includes("ERROR") && !l.includes("eventHub") && !l.includes("OutputEvent"));
                resolve({ started: false, error: errLine || "Timed out after 90s" });
              }
            } catch { /* log not yet written */ }
          }, 2000);
        });

        results.push(pollResult.started
          ? `✅ ${c.label} — started in ~${pollResult.elapsed}s (port ${c.mgtPort})`
          : `❌ ${c.label} — failed: ${pollResult.error}`);

        if (!pollResult.started) break; // Don't start dependent components if one fails
      } catch (err) {
        results.push(`❌ ${c.label} — error: ${err.message}`);
        break;
      }
    }

    return { content: [{ type: "text", text: "Start All Results:\n" + results.join("\n") }] };
  }
);

// ── Tool: check_status ───────────────────────────────────────────────────────
server.tool(
  "check_status",
  "Check running status of all WSO2 APIM 4.6.0 components.",
  {},
  async () => {
    const rows = Object.entries(CONFIG.components).map(([key, c]) => {
      const info     = isRunningInfo(key);
      const started  = info.running && hasStarted(key);
      const icon     = started ? "✅" : info.running ? "⏳" : "🔴";
      const status   = started ? "Running" : info.running ? "Starting..." : "Stopped";
      const pidNote  = info.running ? ` (pid ${info.pid ?? "?"}, via ${info.via})` : "";
      return `${icon} ${c.label.padEnd(22)} port ${c.mgtPort}   ${status}${pidNote}`;
    });

    return {
      content: [{
        type: "text",
        text: "WSO2 APIM 4.6.0 Component Status\n" +
              "─".repeat(55) + "\n" +
              rows.join("\n") + "\n\n" +
              "Portals (when ACP is running):\n" +
              "  Publisher  → https://localhost:9443/publisher\n" +
              "  DevPortal  → https://localhost:9443/devportal\n" +
              "  Admin      → https://localhost:9443/admin\n" +
              "  Credentials: admin / admin",
      }],
    };
  }
);

// ── Tool: view_logs ──────────────────────────────────────────────────────────
server.tool(
  "view_logs",
  "View recent log lines for a WSO2 APIM 4.6.0 component.",
  {
    component: z.enum(["km", "tm", "acp", "gw"]).describe("Component whose logs to view"),
    lines:     z.number().min(10).max(500).default(50).describe("Number of lines to show (default 50)"),
    errors_only: z.boolean().default(false).describe("Show only ERROR/FATAL lines"),
  },
  async ({ component, lines, errors_only }) => {
    const c = CONFIG.components[component];
    const logFile = componentPath(component, c.logFile);

    if (!existsSync(logFile)) {
      return { content: [{ type: "text", text: `Log file not found: ${logFile}` }] };
    }

    let cmd = errors_only
      ? `grep -E "ERROR|FATAL" "${logFile}" | grep -v "eventHub\\|OutputEvent" | tail -${lines}`
      : `tail -${lines} "${logFile}"`;

    try {
      const { stdout } = await execAsync(cmd);
      return {
        content: [{
          type: "text",
          text: `📋 ${c.label} logs (${errors_only ? "errors only" : `last ${lines} lines`}):\n\n${stdout || "(no output)"}`,
        }],
      };
    } catch {
      return { content: [{ type: "text", text: "(failed to read logs)" }] };
    }
  }
);

// ── Tool: tail_logs ───────────────────────────────────────────────────────────
// Opens a new terminal window following a component log file with tail -f.
// Supports macOS, Linux (GNOME, KDE, XFCE, xterm), and Windows.
server.tool(
  "tail_logs",
  "Open a new terminal window running 'tail -f' on a WSO2 APIM component's log file. " +
  "The terminal stays open so you can watch new log lines as they arrive in real time. " +
  "Optionally filter to only ERROR/FATAL lines using grep. " +
  "Supports macOS Terminal, Linux (gnome-terminal, konsole, xfce4-terminal, xterm), and Windows cmd. " +
  "Returns immediately after launching the terminal window.",
  {
    component: z.enum(["km", "tm", "acp", "gw"]).describe("Component whose log to follow"),
    errors_only: z.boolean().default(false)
      .describe("When true, pipe through grep to show only ERROR/FATAL lines"),
  },
  async ({ component, errors_only }) => {
    const c = CONFIG.components[component];
    const logFile = componentPath(component, c.logFile);

    if (!existsSync(logFile)) {
      return { content: [{ type: "text", text: `Log file not found: ${logFile}` }] };
    }

    const tailCmd = errors_only
      ? `tail -f "${logFile}" | grep -E "ERROR|FATAL"`
      : `tail -f "${logFile}"`;

    const platform = process.platform;
    let opened = false;
    let method = "";

    if (platform === "darwin") {
      // macOS: AppleScript to open Terminal
      const script = `tell application "Terminal" to activate\ntell application "Terminal" to do script "${tailCmd.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
      try {
        await execAsync(`osascript << 'ASCRIPT'\n${script}\nASCRIPT`);
        opened = true; method = "macOS Terminal";
      } catch { /* fall through */ }

    } else if (platform === "win32") {
      // Windows: PowerShell Start-Process to open a new cmd/PowerShell window
      const winCmd = `Get-Content -Wait "${logFile.replace(/\//g, "\\")}"${errors_only ? " | Select-String 'ERROR|FATAL'" : ""}`;
      try {
        spawn("powershell", ["-NoProfile", "-Command", `Start-Process powershell -ArgumentList '-NoExit','-Command',"${winCmd.replace(/"/g, '\\"')}"`], { detached: true, stdio: "ignore" }).unref();
        opened = true; method = "Windows PowerShell";
      } catch { /* fall through */ }

    } else {
      // Linux: try common terminal emulators in order
      const terminals = [
        ["gnome-terminal", ["--", "bash", "-c", `${tailCmd}; read`]],
        ["konsole",        ["-e", "bash", "-c", `${tailCmd}; read`]],
        ["xfce4-terminal", ["--command", `bash -c '${tailCmd.replace(/'/g, "'\\''")}; read'`]],
        ["mate-terminal",  ["--command", `bash -c '${tailCmd.replace(/'/g, "'\\''")}; read'`]],
        ["xterm",          ["-e", `bash -c '${tailCmd.replace(/'/g, "'\\''")}; read'`]],
      ];

      for (const [bin, args] of terminals) {
        try {
          await execAsync(`which ${bin}`);
          spawn(bin, args, { detached: true, stdio: "ignore" }).unref();
          opened = true; method = bin;
          break;
        } catch { /* not installed, try next */ }
      }
    }

    if (opened) {
      return {
        content: [{
          type: "text",
          text: `🖥️  Opened new terminal (${method}) tailing ${c.label} logs:\n  File: ${logFile}\n  Filter: ${errors_only ? "ERROR/FATAL only" : "all lines"}\n\nClose the terminal window when done.`,
        }],
      };
    }

    // No terminal could be opened — return manual command
    return {
      content: [{
        type: "text",
        text: `⚠️  Could not detect a supported terminal emulator on ${platform}.\n\nRun this manually in a terminal:\n  ${tailCmd}`,
      }],
    };
  }
);

// ── Tool: setup_databases ────────────────────────────────────────────────────
// Creates MySQL databases, users, and runs APIM init scripts.
// If either database already exists, pauses and asks the user whether to
// proceed with the existing databases or re-configure with new names.
server.tool(
  "setup_databases",
  "Create MySQL databases and users for WSO2 APIM 4.6.0 and run initialization scripts. " +
  "If either database already exists, the tool reports which ones exist and asks how to proceed. " +
  "Use action='use_existing' to continue with the current databases (skips re-running init scripts on those DBs). " +
  "Use action='reconfigure' to stop and update database names via the configure tool first. " +
  "Use action='force_reinit' to drop and recreate the databases (⚠️ data loss!).",
  {
    action: z.enum(["check", "use_existing", "force_reinit", "reconfigure"]).default("check")
      .describe(
        "'check' (default): detect existing databases and ask what to do. " +
        "'use_existing': skip init scripts for existing DBs, only create missing ones. " +
        "'force_reinit': DROP and recreate existing databases then run init scripts (⚠️ data loss!). " +
        "'reconfigure': do nothing — stop here so you can call configure with new DB names."
      ),
  },
  async ({ action }) => {
    const { host, port, adminUser, adminPassword } = CONFIG.mysql;
    const { amDb, sharedDb } = CONFIG.databases;
    const acp = CONFIG.components.acp;
    const acpBase = `${CONFIG.baseDir}/${acp.dir}`;

    const mysqlBase = `mysql -u ${adminUser} -p${adminPassword} -h ${host} -P ${port}`;

    // ── Step 1: Check which databases already exist ──────────────────────────
    let existingDbs = [];
    try {
      const { stdout } = await execAsync(
        `${mysqlBase} -e "SHOW DATABASES LIKE '${amDb.name}';" 2>&1 && ` +
        `${mysqlBase} -e "SHOW DATABASES LIKE '${sharedDb.name}';" 2>&1`
      );
      if (stdout.includes(amDb.name))    existingDbs.push(amDb.name);
      if (stdout.includes(sharedDb.name)) existingDbs.push(sharedDb.name);
    } catch (err) {
      return { content: [{ type: "text", text: `❌ Could not connect to MySQL:\n${err.message}` }] };
    }

    // ── Step 2: If action=check and DBs exist → pause and ask ───────────────
    if (action === "check" && existingDbs.length > 0) {
      return {
        content: [{
          type: "text",
          text:
            `⚠️  The following database(s) already exist on ${host}:${port}:\n` +
            existingDbs.map(d => `  • ${d}`).join("\n") +
            `\n\nPlease choose how to proceed by calling setup_databases again with one of these actions:\n\n` +
            `  action="use_existing"  — Skip init scripts for existing databases; only create missing ones.\n` +
            `                           Safe if this is a re-run and data should be kept.\n\n` +
            `  action="force_reinit"  — ⚠️  DROP and recreate ALL databases, then re-run init scripts.\n` +
            `                           Use only if you want a completely fresh setup (DATA WILL BE LOST).\n\n` +
            `  action="reconfigure"   — Stop here. Call configure first with new amDbName / sharedDbName values,\n` +
            `                           then call setup_databases again.\n\n` +
            `Current database names:\n` +
            `  AM DB:     ${amDb.name}  (user: ${amDb.user})\n` +
            `  Shared DB: ${sharedDb.name}  (user: ${sharedDb.user})`,
        }],
      };
    }

    // ── Step 3: handle reconfigure (just return guidance) ───────────────────
    if (action === "reconfigure") {
      return {
        content: [{
          type: "text",
          text:
            `ℹ️  No changes made. To use different database names:\n\n` +
            `1. Call configure with new database names. Example:\n` +
            `     configure(amDbName="APIM_46_AM_DB_V2", sharedDbName="APIM_46_SHARED_DB_V2")\n\n` +
            `2. Then call setup_databases again (action="check").\n\n` +
            `Current names: ${amDb.name}, ${sharedDb.name}`,
        }],
      };
    }

    // ── Step 4: force_reinit — drop existing databases first ────────────────
    if (action === "force_reinit" && existingDbs.length > 0) {
      const dropSql = existingDbs.map(d => `DROP DATABASE IF EXISTS ${d};`).join(" ");
      try {
        await execAsync(`${mysqlBase} -e "${dropSql}" 2>&1`);
      } catch (err) {
        return { content: [{ type: "text", text: `❌ Failed to drop databases:\n${err.message}` }] };
      }
      existingDbs = []; // all dropped — treat as fresh
    }

    // ── Step 5: Create databases, users, grants ──────────────────────────────
    // For use_existing: only create databases that don't exist yet
    const createAmDb     = !existingDbs.includes(amDb.name);
    const createSharedDb = !existingDbs.includes(sharedDb.name);

    const createSql = [
      createAmDb     ? `CREATE DATABASE IF NOT EXISTS ${amDb.name} CHARACTER SET latin1;`     : "",
      createSharedDb ? `CREATE DATABASE IF NOT EXISTS ${sharedDb.name} CHARACTER SET latin1;` : "",
      `CREATE USER IF NOT EXISTS '${amDb.user}'@'%' IDENTIFIED WITH mysql_native_password BY '${amDb.password}';`,
      `CREATE USER IF NOT EXISTS '${amDb.user}'@'localhost' IDENTIFIED WITH mysql_native_password BY '${amDb.password}';`,
      `CREATE USER IF NOT EXISTS '${sharedDb.user}'@'%' IDENTIFIED WITH mysql_native_password BY '${sharedDb.password}';`,
      `CREATE USER IF NOT EXISTS '${sharedDb.user}'@'localhost' IDENTIFIED WITH mysql_native_password BY '${sharedDb.password}';`,
      `GRANT ALL PRIVILEGES ON ${amDb.name}.* TO '${amDb.user}'@'%';`,
      `GRANT ALL PRIVILEGES ON ${amDb.name}.* TO '${amDb.user}'@'localhost';`,
      `GRANT ALL PRIVILEGES ON ${sharedDb.name}.* TO '${sharedDb.user}'@'%';`,
      `GRANT ALL PRIVILEGES ON ${sharedDb.name}.* TO '${sharedDb.user}'@'localhost';`,
      `FLUSH PRIVILEGES;`,
    ].filter(Boolean).join(" ");

    try {
      await execAsync(`${mysqlBase} -e "${createSql}" 2>&1`);
    } catch (err) {
      return { content: [{ type: "text", text: `❌ Failed to create databases/users:\n${err.message}` }] };
    }

    // ── Step 6: Run init scripts (skip for existing DBs in use_existing mode) ─
    const initResults = [];

    if (createSharedDb || action === "force_reinit") {
      try {
        await execAsync(`${mysqlBase} ${sharedDb.name} < "${acpBase}/dbscripts/mysql.sql" 2>&1`);
        initResults.push(`  ✅ ${sharedDb.name} — init script applied`);
      } catch (err) {
        initResults.push(`  ⚠️  ${sharedDb.name} — init script error (tables may already exist): ${err.message.split("\n")[0]}`);
      }
    } else {
      initResults.push(`  ⏭️  ${sharedDb.name} — skipped (existing database)`);
    }

    if (createAmDb || action === "force_reinit") {
      try {
        await execAsync(`${mysqlBase} ${amDb.name} < "${acpBase}/dbscripts/apimgt/mysql.sql" 2>&1`);
        initResults.push(`  ✅ ${amDb.name} — init script applied`);
      } catch (err) {
        initResults.push(`  ⚠️  ${amDb.name} — init script error (tables may already exist): ${err.message.split("\n")[0]}`);
      }
    } else {
      initResults.push(`  ⏭️  ${amDb.name} — skipped (existing database)`);
    }

    const actionLabel = action === "force_reinit" ? "force re-initialized" : action === "use_existing" ? "set up (skipped existing)" : "created fresh";
    return {
      content: [{
        type: "text",
        text:
          `✅ Databases ${actionLabel}!\n\n` +
          `  ${amDb.name}     → user: ${amDb.user}\n` +
          `  ${sharedDb.name} → user: ${sharedDb.user}\n` +
          `  Password (both): ${amDb.password}\n\n` +
          `Init scripts:\n` + initResults.join("\n"),
      }],
    };
  }
);

// ── Tool: configure ──────────────────────────────────────────────────────────
server.tool(
  "configure",
  "Set or update configuration values in config.json. " +
  "The AI agent calls this to store environment details (paths, credentials) — users do not need to edit config.json manually. " +
  "Only the fields you provide are updated; everything else is preserved.",
  {
    baseDir:            z.string().optional().describe("Absolute path where APIM component directories live"),
    mysqlHost:          z.string().optional().describe("MySQL host (default: 127.0.0.1)"),
    mysqlPort:          z.number().int().optional().describe("MySQL port (default: 3306)"),
    mysqlAdminUser:     z.string().optional().describe("MySQL admin username (e.g. root)"),
    mysqlAdminPassword: z.string().optional().describe("MySQL admin password"),
    amDbName:           z.string().optional().describe("AM database name (e.g. APIM_46_AM_DB). User and password auto-derived from name if not set."),
    sharedDbName:       z.string().optional().describe("Shared database name (e.g. APIM_46_SHARED_DB). User and password auto-derived from name if not set."),
    updatesUsername:    z.string().optional().describe("WSO2 account email for U2 updates"),
    updatesPassword:    z.string().optional().describe("WSO2 account password for U2 updates"),
    zipTm:              z.string().optional().describe("Absolute path to the TM zip file"),
    zipAcp:             z.string().optional().describe("Absolute path to the ACP zip file"),
    zipGw:              z.string().optional().describe("Absolute path to the GW zip file"),
    zipKm:              z.string().optional().describe("Absolute path to the KM zip file (usually same as ACP)"),
  },
  async (params) => {
    let rawCfg = {};
    try { rawCfg = JSON.parse(readFileSync(configPath, "utf8")); } catch { /* start fresh */ }

    const set = (obj, path, val) => {
      const keys = path.split(".");
      let cur = obj;
      for (let i = 0; i < keys.length - 1; i++) {
        if (!cur[keys[i]] || typeof cur[keys[i]] !== "object") cur[keys[i]] = {};
        cur = cur[keys[i]];
      }
      cur[keys[keys.length - 1]] = val;
    };

    const changed = [];

    if (params.baseDir            !== undefined) { set(rawCfg, "baseDir", params.baseDir); changed.push(`baseDir = "${params.baseDir}"`); }
    if (params.mysqlHost          !== undefined) { set(rawCfg, "mysql.host", params.mysqlHost); changed.push(`mysql.host = "${params.mysqlHost}"`); }
    if (params.mysqlPort          !== undefined) { set(rawCfg, "mysql.port", params.mysqlPort); changed.push(`mysql.port = ${params.mysqlPort}`); }
    if (params.mysqlAdminUser     !== undefined) { set(rawCfg, "mysql.adminUser", params.mysqlAdminUser); changed.push(`mysql.adminUser = "${params.mysqlAdminUser}"`); }
    if (params.mysqlAdminPassword !== undefined) { set(rawCfg, "mysql.adminPassword", params.mysqlAdminPassword); changed.push(`mysql.adminPassword = ****`); }

    // Database name changes — auto-derive user/password from name (lowercase, replace - with _)
    if (params.amDbName !== undefined) {
      const autoUser = params.amDbName.toLowerCase().replace(/-/g, "_") + "_user";
      const autoPass = params.amDbName.toLowerCase().replace(/-/g, "_") + "_pass";
      set(rawCfg, "databases.amDb.name", params.amDbName); changed.push(`databases.amDb.name = "${params.amDbName}"`);
      // Only override user/pass if not already customised
      if (!rawCfg.databases?.amDb?.user  || rawCfg.databases.amDb.user  === autoUser.replace(params.amDbName.toLowerCase(), "").trim()) {
        set(rawCfg, "databases.amDb.user", autoUser); changed.push(`databases.amDb.user = "${autoUser}" (auto)`);
      }
      if (!rawCfg.databases?.amDb?.password) {
        set(rawCfg, "databases.amDb.password", autoPass); changed.push(`databases.amDb.password = "${autoPass}" (auto)`);
      }
    }
    if (params.sharedDbName !== undefined) {
      const autoUser = params.sharedDbName.toLowerCase().replace(/-/g, "_") + "_user";
      const autoPass = params.sharedDbName.toLowerCase().replace(/-/g, "_") + "_pass";
      set(rawCfg, "databases.sharedDb.name", params.sharedDbName); changed.push(`databases.sharedDb.name = "${params.sharedDbName}"`);
      if (!rawCfg.databases?.sharedDb?.user) {
        set(rawCfg, "databases.sharedDb.user", autoUser); changed.push(`databases.sharedDb.user = "${autoUser}" (auto)`);
      }
      if (!rawCfg.databases?.sharedDb?.password) {
        set(rawCfg, "databases.sharedDb.password", autoPass); changed.push(`databases.sharedDb.password = "${autoPass}" (auto)`);
      }
    }

    if (params.updatesUsername    !== undefined) { set(rawCfg, "updates.credentials.username", params.updatesUsername); changed.push(`updates.credentials.username = "${params.updatesUsername}"`); }
    if (params.updatesPassword    !== undefined) { set(rawCfg, "updates.credentials.password", params.updatesPassword); changed.push(`updates.credentials.password = ****`); }
    if (params.zipTm              !== undefined) { set(rawCfg, "zips.tm", params.zipTm); changed.push(`zips.tm = "${params.zipTm}"`); }
    if (params.zipAcp             !== undefined) {
      set(rawCfg, "zips.acp", params.zipAcp); changed.push(`zips.acp = "${params.zipAcp}"`);
      // KM always uses the ACP archive — auto-set unless caller explicitly provided zipKm
      if (params.zipKm === undefined && params.zipAcp) {
        set(rawCfg, "zips.km", params.zipAcp); changed.push(`zips.km = "${params.zipAcp}" (auto from ACP)`);
      }
    }
    if (params.zipGw              !== undefined) { set(rawCfg, "zips.gw", params.zipGw); changed.push(`zips.gw = "${params.zipGw}"`); }
    if (params.zipKm              !== undefined) { set(rawCfg, "zips.km", params.zipKm); changed.push(`zips.km = "${params.zipKm}"`); }

    if (changed.length === 0) {
      return { content: [{ type: "text", text: "⚠️  No fields provided — nothing updated." }] };
    }

    writeFileSync(configPath, JSON.stringify(rawCfg, null, 2));

    // Apply to live CONFIG so the session picks up changes immediately
    Object.assign(CONFIG, JSON.parse(readFileSync(configPath, "utf8")));

    return {
      content: [{
        type: "text",
        text: `✅ config.json updated (${changed.length} field${changed.length > 1 ? "s" : ""}):\n` +
              changed.map(c => `   • ${c}`).join("\n"),
      }],
    };
  }
);

// ── Tool: get_deployment_info ────────────────────────────────────────────────
server.tool(
  "get_deployment_info",
  "Get the full WSO2 APIM 4.6.0 distributed deployment topology, ports, and database info.",
  {},
  async () => ({
    content: [{
      type: "text",
      text: `WSO2 API Manager 4.6.0 — Distributed Deployment
${"═".repeat(55)}

📁 Base Directory:
   ${CONFIG.baseDir}

🧩 Components & Fixed Port Offsets:
   These offsets are FIXED — always use exactly these values in deployment.toml [server] section.
   Component           Dir                        Offset  Mgt HTTPS
   ─────────────────────────────────────────────────────────────────
   Key Manager         wso2am-km-4.6.0               3     9446
   Traffic Manager     wso2am-tm-4.6.0               2     9445
   API Control Plane   wso2am-acp-4.6.0              0     9443
   Universal Gateway   wso2am-universal-gw-4.6.0     1     9444 (API: 8244/8281)

   deployment.toml [server] section example (TM):
     [server]
     offset = 2

🗄️  Databases (MySQL @ ${CONFIG.mysql?.host || "localhost"}:${CONFIG.mysql?.port || 3306}):
   ${CONFIG.databases?.amDb?.name || "APIM_46_AM_DB"}     → ${CONFIG.databases?.amDb?.user || "apim46_am_user"} / ${CONFIG.databases?.amDb?.password || "APIM46_DB@123"}
   ${CONFIG.databases?.sharedDb?.name || "APIM_46_SHARED_DB"} → ${CONFIG.databases?.sharedDb?.user || "apim46_shared_user"} / ${CONFIG.databases?.sharedDb?.password || "APIM46_DB@123"}
   MySQL admin → ${CONFIG.mysql?.adminUser || "root"} / ${CONFIG.mysql?.adminPassword || "Admin@123"}

🔗 Portal URLs (ACP):
   Publisher  https://localhost:9443/publisher
   DevPortal  https://localhost:9443/devportal
   Admin      https://localhost:9443/admin
   Credentials: admin / admin

🔗 Gateway API Endpoints:
   HTTPS  https://localhost:8244/{context}/{version}
   HTTP   http://localhost:8281/{context}/{version}

🔑 Key Manager (KM):
   Service URL  https://localhost:9446/services/
   KM binary: extracted from the ACP zip (wso2am-acp-*.zip) — started with bin/key-manager.sh

▶️  Start Order:  TM → KM → ACP → GW
⏹️  Stop Order:   GW → ACP → KM → TM

⚠️  Known Issues & Fixes:
   1. Space in directory path breaks bash sessions
      → Base dir uses underscore: distributed_deployment
   2. Ampersand (&) in JDBC URLs breaks XML parsing inside WSO2
      → Escape & as &amp; when combining multiple query params:
         url = "jdbc:mysql://localhost:3306/DB?useSSL=false&amp;autoReconnect=true"
   3. create_admin_account must be true on all nodes (shared DB)
   4. Delete .metadata files before restart to force config regeneration
      Path: repository/resources/conf/.metadata/
   5. Each component auto-starts a diagnostics agent (org.wso2.diagnostics.DiagnosticsApp)
      → Use the stop_diagnostics tool to stop it if needed
`,
    }],
  })
);

// ── Tool: stop_diagnostics ───────────────────────────────────────────────────
server.tool(
  "stop_diagnostics",
  "Stop the WSO2 runtime diagnostics agent (org.wso2.diagnostics.DiagnosticsApp) that auto-starts alongside each component. " +
  "Each component spawns its own diagnostics process from <component>/diagnostics-tool/. " +
  "This tool finds and terminates those processes without affecting the main server process.",
  {
    component: z.enum(["all", "tm", "km", "acp", "gw"]).default("all")
      .describe("Which component's diagnostics to stop, or 'all' for all components"),
  },
  async ({ component }) => {
    const targets = component === "all"
      ? Object.keys(CONFIG.components)
      : [component];

    const results = [];

    for (const key of targets) {
      const c = CONFIG.components[key];
      const componentDir = `${CONFIG.baseDir}/${c.dir}`;
      const diagMarker = `${componentDir}/diagnostics-tool`;

      try {
        // Find all java processes whose args include this component's diagnostics-tool path
        const { stdout } = await execAsync(
          `ps ax -o pid,args | grep "org.wso2.diagnostics.DiagnosticsApp" | grep -F "${diagMarker}" | grep -v grep`
        );

        const pids = stdout.trim().split("\n")
          .map(line => parseInt(line.trim().split(/\s+/)[0]))
          .filter(pid => !isNaN(pid));

        if (pids.length === 0) {
          results.push(`⚪ ${c.label} — diagnostics agent not running`);
          continue;
        }

        for (const pid of pids) {
          try {
            process.kill(pid, "SIGTERM");
          } catch { /* already gone */ }
        }

        // Brief wait and verify
        await new Promise(r => setTimeout(r, 1500));
        const stillAlive = pids.filter(pid => {
          try { process.kill(pid, 0); return true; } catch { return false; }
        });

        if (stillAlive.length > 0) {
          stillAlive.forEach(pid => { try { process.kill(pid, "SIGKILL"); } catch { /* ignore */ } });
          results.push(`🛑 ${c.label} — diagnostics agent (pid ${pids.join(", ")}) killed (SIGKILL)`);
        } else {
          results.push(`🛑 ${c.label} — diagnostics agent (pid ${pids.join(", ")}) stopped`);
        }
      } catch (err) {
        // grep exits with code 1 when no matching process found — that's "not running"
        if (err.code === 1) {
          results.push(`⚪ ${c.label} — diagnostics agent not running`);
        } else {
          results.push(`❌ ${c.label} — error: ${err.message.split("\n")[0]}`);
        }
      }
    }

    return { content: [{ type: "text", text: "Stop Diagnostics Results:\n" + results.join("\n") }] };
  }
);

// ── Tool: apply_config ───────────────────────────────────────────────────────
// Generates and writes deployment.toml for each component based on CONFIG values.
// Only deployment.toml is touched — no other files are modified.
server.tool(
  "apply_config",
  "Generate and write deployment.toml for each WSO2 APIM component based on current config.json values " +
  "(MySQL host/port, database names/users/passwords, admin credentials). " +
  "Only deployment.toml is written — no other files are touched. " +
  "Run this after configure and extract_components, before start_component. " +
  "Port offsets are FIXED per component and cannot be overridden.",
  {
    component: z.enum(["all", "tm", "km", "acp", "gw"]).default("all")
      .describe("Which component to configure, or 'all' for all components"),
  },
  async ({ component }) => {
    const targets = component === "all"
      ? Object.keys(CONFIG.components)
      : [component];

    const { host, port } = CONFIG.mysql;
    const { amDb, sharedDb } = CONFIG.databases;

    // Build JDBC URL — use &amp; if multiple params needed (XML-safe)
    const jdbcUrl = (dbName, extraParams = "") => {
      const base = `jdbc:mysql://${host}:${port}/${dbName}?useSSL=false`;
      return extraParams ? `${base}&amp;${extraParams}` : base;
    };

    // ── deployment.toml templates per component ──────────────────────────────
    const templates = {
      acp: () => `# =============================================================================
# WSO2 API Manager 4.6.0 - API Control Plane (ACP)
# Port offset: 0  →  Management HTTPS: 9443 | HTTP: 9763
# =============================================================================

[server]
hostname = "localhost"
offset = 0
base_path = "\${carbon.protocol}://\${carbon.host}:\${carbon.management.port}"
server_role = "control-plane"

[super_admin]
username = "admin"
password = "admin"
create_admin_account = true

[user_store]
type = "database_unique_id"

# ---------------------------------------------------------------------------
# Database: API Manager DB  (APIs, Applications, Subscriptions, Throttling)
# ---------------------------------------------------------------------------
[database.apim_db]
type = "mysql"
url = "${jdbcUrl(amDb.name)}"
username = "${amDb.user}"
password = "${amDb.password}"
driver = "com.mysql.cj.jdbc.Driver"

[database.apim_db.pool_options]
validationQuery = "SELECT 1"
autoReconnect = true

# ---------------------------------------------------------------------------
# Database: Shared DB  (User management, Registry)
# ---------------------------------------------------------------------------
[database.shared_db]
type = "mysql"
url = "${jdbcUrl(sharedDb.name)}"
username = "${sharedDb.user}"
password = "${sharedDb.password}"
driver = "com.mysql.cj.jdbc.Driver"

[database.shared_db.pool_options]
validationQuery = "SELECT 1"
autoReconnect = true

# Local H2 (IS-specific per-node data — keep as H2)
[database.local]
url = "jdbc:h2:./repository/database/WSO2CARBON_DB;DB_CLOSE_ON_EXIT=FALSE"

# ---------------------------------------------------------------------------
# Keystores
# ---------------------------------------------------------------------------
[keystore.tls]
file_name = "wso2carbon.jks"
type = "JKS"
password = "wso2carbon"
alias = "wso2carbon"
key_password = "wso2carbon"

# ---------------------------------------------------------------------------
# Gateway environment — points to the Universal Gateway (offset 1)
# GW Management: 9444 | GW API HTTPS: 8244 | GW API HTTP: 8281
# ---------------------------------------------------------------------------
[apim]
gateway_type = "Regular,APK,AWS,Azure,Kong,Envoy"

[[apim.gateway.environment]]
name = "Default"
type = "hybrid"
gateway_type = "Regular"
provider = "wso2"
display_in_api_console = true
description = "This is a hybrid gateway that handles both production and sandbox token traffic."
show_as_token_endpoint_url = true
service_url = "https://localhost:9444/services/"
username = "\${admin.username}"
password = "\${admin.password}"
ws_endpoint = "ws://localhost:9099"
wss_endpoint = "wss://localhost:8099"
http_endpoint = "http://localhost:8281"
https_endpoint = "https://localhost:8244"

# ---------------------------------------------------------------------------
# Key Manager — delegate token operations to external KM (offset 3 → 9446)
# ---------------------------------------------------------------------------
[apim.key_manager]
service_url = "https://localhost:9446/services/"
username = "\$ref{super_admin.username}"
password = "\$ref{super_admin.password}"

# ---------------------------------------------------------------------------
# Throttling — publish policies to Traffic Manager (offset 2)
# TM Binary:  tcp://localhost:9613  |  ssl://localhost:9713
# TM JMS/MB:  tcp://localhost:5674
# ---------------------------------------------------------------------------
[apim.throttling]
enable_data_publishing = true
enable_policy_deploy = true
enable_blacklist_condition = true
enable_persistence = true
throttle_decision_endpoints = ["tcp://localhost:5674"]

[[apim.throttling.url_group]]
traffic_manager_urls = ["tcp://localhost:9613"]
traffic_manager_auth_urls = ["ssl://localhost:9713"]

# ---------------------------------------------------------------------------
# CORS
# ---------------------------------------------------------------------------
[apim.cors]
allow_origins = "*"
allow_methods = ["GET","PUT","POST","DELETE","PATCH","OPTIONS"]
allow_headers = ["authorization","Access-Control-Allow-Origin","Content-Type","SOAPAction","apikey","Internal-Key"]
allow_credentials = false

[[event_handler]]
name = "userPostSelfRegistration"
subscriptions = ["POST_ADD_USER"]

[service_provider]
sp_name_regex = "^[\\\\sa-zA-Z0-9._-]*$"

[[event_listener]]
id = "token_revocation"
type = "org.wso2.carbon.identity.core.handler.AbstractIdentityHandler"
name = "org.wso2.is.notification.ApimOauthEventInterceptor"
order = 1

[event_listener.properties]
notification_endpoint = "https://localhost:\${mgt.transport.https.port}/internal/data/v1/notify"
username = "\${admin.username}"
password = "\${admin.password}"
'header.X-WSO2-KEY-MANAGER' = "default"
`,

      tm: () => `# =============================================================================
# WSO2 API Manager 4.6.0 - Traffic Manager (TM)
# Port offset: 2  →  Management HTTPS: 9445 | HTTP: 9765
#                    Binary:  tcp:9613 / ssl:9713
#                    JMS/MB:  tcp:5674
# =============================================================================

[server]
hostname = "localhost"
offset = 2
server_role = "traffic-manager"

[super_admin]
username = "admin"
password = "admin"
create_admin_account = true

[user_store]
type = "database_unique_id"

# ---------------------------------------------------------------------------
# Database: API Manager DB  (Throttling policies)
# ---------------------------------------------------------------------------
[database.apim_db]
type = "mysql"
url = "${jdbcUrl(amDb.name)}"
username = "${amDb.user}"
password = "${amDb.password}"
driver = "com.mysql.cj.jdbc.Driver"

[database.apim_db.pool_options]
validationQuery = "SELECT 1"
autoReconnect = true

# ---------------------------------------------------------------------------
# Database: Shared DB  (User management, Registry)
# ---------------------------------------------------------------------------
[database.shared_db]
type = "mysql"
url = "${jdbcUrl(sharedDb.name)}"
username = "${sharedDb.user}"
password = "${sharedDb.password}"
driver = "com.mysql.cj.jdbc.Driver"

[database.shared_db.pool_options]
validationQuery = "SELECT 1"
autoReconnect = true

# ---------------------------------------------------------------------------
# Keystores
# ---------------------------------------------------------------------------
[keystore.tls]
file_name = "wso2carbon.jks"
type = "JKS"
password = "wso2carbon"
alias = "wso2carbon"
key_password = "wso2carbon"

[truststore]
file_name = "client-truststore.jks"
type = "JKS"
password = "wso2carbon"

# ---------------------------------------------------------------------------
# Event Hub — TM does not subscribe to ACP event hub
# ---------------------------------------------------------------------------
[apim.event_hub]
enable = false
`,

      gw: () => `# =============================================================================
# WSO2 API Manager 4.6.0 - Universal Gateway (GW)
# Port offset: 1  →  Management HTTPS: 9444 | HTTP: 9764
#                    API HTTPS: 8244 | API HTTP: 8281
# =============================================================================

[server]
hostname = "localhost"
offset = 1
server_role = "gateway-worker"

[super_admin]
username = "admin"
password = "admin"
create_admin_account = true

[user_store]
type = "database_unique_id"

# ---------------------------------------------------------------------------
# Database: Shared DB  (Registry — gateway only needs shared_db)
# ---------------------------------------------------------------------------
[database.shared_db]
type = "mysql"
url = "${jdbcUrl(sharedDb.name)}"
username = "${sharedDb.user}"
password = "${sharedDb.password}"
driver = "com.mysql.cj.jdbc.Driver"

[database.shared_db.pool_options]
validationQuery = "SELECT 1"
autoReconnect = true

# ---------------------------------------------------------------------------
# Keystores
# ---------------------------------------------------------------------------
[keystore.tls]
file_name = "wso2carbon.jks"
type = "JKS"
password = "wso2carbon"
alias = "wso2carbon"
key_password = "wso2carbon"

[truststore]
file_name = "client-truststore.jks"
type = "JKS"
password = "wso2carbon"

# ---------------------------------------------------------------------------
# Key Manager — validate tokens via external KM (offset 3 → port 9446)
# ---------------------------------------------------------------------------
[apim.key_manager]
service_url = "https://localhost:9446/services/"
username = "\$ref{super_admin.username}"
password = "\$ref{super_admin.password}"

# ---------------------------------------------------------------------------
# Event Hub — pull API artifacts from ACP (offset 0 → port 9443 / JMS 5672)
# ---------------------------------------------------------------------------
[apim.event_hub]
enable = true
username = "\$ref{super_admin.username}"
password = "\$ref{super_admin.password}"
service_url = "https://localhost:9443/services/"
event_listening_endpoints = ["tcp://localhost:5672"]

# ---------------------------------------------------------------------------
# Throttling — send throttle data to Traffic Manager (offset 2)
# TM Binary:  tcp://localhost:9613  |  ssl://localhost:9713
# TM JMS/MB:  tcp://localhost:5674
# ---------------------------------------------------------------------------
[apim.throttling]
throttle_decision_endpoints = ["tcp://localhost:5674"]

[[apim.throttling.url_group]]
traffic_manager_urls = ["tcp://localhost:9613"]
traffic_manager_auth_urls = ["ssl://localhost:9713"]

[apim.sync_runtime_artifacts.gateway]
gateway_labels = ["Default"]

[apim.jwt]
enable = true
encoding = "base64"
header = "X-JWT-Assertion"
signing_algorithm = "SHA256withRSA"
enable_user_claims = true

[apim.oauth_config]
remove_outbound_auth_header = true
auth_header = "Authorization"

[apim.cors]
allow_origins = "*"
allow_methods = ["GET","PUT","POST","DELETE","PATCH","OPTIONS"]
allow_headers = ["authorization","Access-Control-Allow-Origin","Content-Type","SOAPAction","apikey","Internal-Key"]
allow_credentials = false

[apim.cache.gateway_token]
enable = true
expiry_time = 15

[apim.cache.resource]
enable = true

[apim.cache.jwt_claim]
enable = true
expiry_time = 900

[apim.analytics]
enable = false
`,

      km: () => `# =============================================================================
# WSO2 API Manager 4.6.0 - Key Manager (KM)
# Port offset: 3  →  Management HTTPS: 9446 | HTTP: 9766
# =============================================================================

[server]
hostname = "localhost"
offset = 3
server_role = "key-manager"

[super_admin]
username = "admin"
password = "admin"
create_admin_account = true

[user_store]
type = "database_unique_id"

# ---------------------------------------------------------------------------
# Database: API Manager DB  (OAuth2 tokens, applications, keys)
# ---------------------------------------------------------------------------
[database.apim_db]
type = "mysql"
url = "${jdbcUrl(amDb.name)}"
username = "${amDb.user}"
password = "${amDb.password}"
driver = "com.mysql.cj.jdbc.Driver"

[database.apim_db.pool_options]
validationQuery = "SELECT 1"
autoReconnect = true

# ---------------------------------------------------------------------------
# Database: Shared DB  (User management, Registry)
# ---------------------------------------------------------------------------
[database.shared_db]
type = "mysql"
url = "${jdbcUrl(sharedDb.name)}"
username = "${sharedDb.user}"
password = "${sharedDb.password}"
driver = "com.mysql.cj.jdbc.Driver"

[database.shared_db.pool_options]
validationQuery = "SELECT 1"
autoReconnect = true

# Local H2 (per-node IS data — keep as H2)
[database.local]
url = "jdbc:h2:./repository/database/WSO2CARBON_DB;DB_CLOSE_ON_EXIT=FALSE"

# ---------------------------------------------------------------------------
# Keystores
# ---------------------------------------------------------------------------
[keystore.tls]
file_name = "wso2carbon.jks"
type = "JKS"
password = "wso2carbon"
alias = "wso2carbon"
key_password = "wso2carbon"

[truststore]
file_name = "client-truststore.jks"
type = "JKS"
password = "wso2carbon"

# ---------------------------------------------------------------------------
# Event Hub — subscribe to key management events from ACP (offset 0 → 9443)
# ---------------------------------------------------------------------------
[apim.event_hub]
enable = true
username = "\$ref{super_admin.username}"
password = "\$ref{super_admin.password}"
service_url = "https://localhost:9443/services/"
event_listening_endpoints = ["tcp://localhost:5672"]

# ---------------------------------------------------------------------------
# Throttling — KM publishes OAuth events; connect to TM (offset 2)
# ---------------------------------------------------------------------------
[apim.throttling]
enable_data_publishing = false

[[apim.throttling.url_group]]
traffic_manager_urls = ["tcp://localhost:9613"]
traffic_manager_auth_urls = ["ssl://localhost:9713"]

[[event_handler]]
name = "userPostSelfRegistration"
subscriptions = ["POST_ADD_USER"]

[service_provider]
sp_name_regex = "^[\\\\sa-zA-Z0-9._-]*$"

[[event_listener]]
id = "token_revocation"
type = "org.wso2.carbon.identity.core.handler.AbstractIdentityHandler"
name = "org.wso2.is.notification.ApimOauthEventInterceptor"
order = 1

[event_listener.properties]
notification_endpoint = "https://localhost:\${mgt.transport.https.port}/internal/data/v1/notify"
username = "\${admin.username}"
password = "\${admin.password}"
'header.X-WSO2-KEY-MANAGER' = "default"
`,
    };

    const results = [];

    for (const key of targets) {
      const c = CONFIG.components[key];
      const confDir = componentPath(key, "repository/conf");
      const tomlPath = `${confDir}/deployment.toml`;

      if (!existsSync(confDir)) {
        results.push(`❌ ${c.label} — component not extracted (${confDir} not found). Run extract_components first.`);
        continue;
      }

      try {
        const content = templates[key]();
        writeFileSync(tomlPath, content, "utf8");
        results.push(`✅ ${c.label} — deployment.toml written: ${tomlPath}`);
      } catch (err) {
        results.push(`❌ ${c.label} — failed to write deployment.toml: ${err.message}`);
      }
    }

    return {
      content: [{
        type: "text",
        text: `Apply Config Results:\n\n` + results.join("\n") +
              `\n\nℹ️  Only deployment.toml was modified. Start order: TM → KM → ACP → GW`,
      }],
    };
  }
);

// ── Tool: extract_components ─────────────────────────────────────────────────
server.tool(
  "extract_components",
  "Extract WSO2 APIM component ZIP files into the base directory. ZIP paths must be set in config.json under 'zips'. KM is extracted from the ACP zip and renamed automatically.",
  {
    component: z.enum(["all", "tm", "km", "acp", "gw"]).default("all")
      .describe("Which component to extract, or 'all' for all components"),
    overwrite: z.boolean().default(false)
      .describe("If true, delete and re-extract even if the directory already exists"),
  },
  async ({ component, overwrite }) => {
    const zips = CONFIG.zips;
    if (!zips) {
      return { content: [{ type: "text", text: "❌ 'zips' section missing from config.json. Add zip paths for each component." }] };
    }

    const targets = component === "all"
      ? Object.keys(CONFIG.components)
      : [component];

    const results = [];

    for (const key of targets) {
      const c = CONFIG.components[key];
      const targetDir = `${CONFIG.baseDir}/${c.dir}`;

      // Component zip prefix patterns (U2 level suffix is ignored — match by prefix only)
      const prefixMap = {
        tm:  "wso2am-tm-",
        acp: "wso2am-acp-",
        gw:  "wso2am-universal-gw-",
        km:  "wso2am-acp-",   // KM reuses the ACP zip
      };
      const prefix = prefixMap[key];

      // Resolve the zip path: use config value if it exists, otherwise scan for any matching zip
      let zipPath = zips[key];
      if (!zipPath || !existsSync(zipPath)) {
        // Scan directories: config zip dir (if set), then baseDir, then cwd
        const searchDirs = [
          zipPath ? dirname(zipPath) : null,
          CONFIG.baseDir,
          dirname(configPath),
        ].filter(Boolean);

        let found = null;
        for (const dir of searchDirs) {
          try {
            const { stdout } = await execAsync(`ls "${dir}"/${prefix}*.zip 2>/dev/null | head -1`);
            const candidate = stdout.trim();
            if (candidate && existsSync(candidate)) { found = candidate; break; }
          } catch { /* no match in this dir */ }
        }

        if (found) {
          zipPath = found;
          results.push(`🔍 ${c.label} — located zip by prefix (${prefix}*): ${zipPath}`);
        } else {
          results.push(`❌ ${c.label} — no zip found matching prefix "${prefix}*.zip". Set path with configure tool or place zip in ${CONFIG.baseDir}`);
          continue;
        }
      }

      if (existsSync(targetDir)) {
        if (!overwrite) {
          results.push(`⏭️  ${c.label} — already extracted at ${targetDir} (use overwrite:true to re-extract)`);
          continue;
        }
        await execAsync(`rm -rf "${targetDir}"`);
      }

      try {
        // Get the root directory name packed inside the zip
        const { stdout: zipList } = await execAsync(`unzip -Z1 "${zipPath}" | head -1`);
        const packedRoot = zipList.trim().replace(/\/$/, "").split("/")[0];
        const extractedDir = `${CONFIG.baseDir}/${packedRoot}`;

        // Extract into baseDir
        await execAsync(`unzip -q "${zipPath}" -d "${CONFIG.baseDir}"`);

        // Rename if the packed root name differs from the target dir name
        if (packedRoot !== c.dir) {
          if (existsSync(extractedDir)) {
            await execAsync(`mv "${extractedDir}" "${targetDir}"`);
          }
        }

        results.push(`✅ ${c.label} — extracted to ${targetDir}`);
      } catch (err) {
        results.push(`❌ ${c.label} — extraction failed: ${err.message}`);
      }
    }

    return { content: [{ type: "text", text: "Extract Results:\n" + results.join("\n") }] };
  }
);

// ── Tool: setup_jdbc_driver ──────────────────────────────────────────────────
server.tool(
  "setup_jdbc_driver",
  "Download the MySQL JDBC driver JAR from Maven Central and copy it to every component's repository/components/lib/ directory.",
  {
    component: z.enum(["all", "tm", "km", "acp", "gw"]).default("all")
      .describe("Copy driver to this component only, or 'all' for all components"),
  },
  async ({ component }) => {
    const driverCfg = CONFIG.jdbcDriver || {
      version: "8.0.29",
      downloadUrl: "https://repo1.maven.org/maven2/mysql/mysql-connector-java/8.0.29/mysql-connector-java-8.0.29.jar",
    };

    const jarName = `mysql-connector-java-${driverCfg.version}.jar`;
    const tmpPath = `/tmp/${jarName}`;

    // Download if not already cached
    if (!existsSync(tmpPath)) {
      try {
        await execAsync(`curl -fsSL -o "${tmpPath}" "${driverCfg.downloadUrl}"`);
      } catch (err) {
        return { content: [{ type: "text", text: `❌ Download failed: ${err.message}\nURL: ${driverCfg.downloadUrl}` }] };
      }
    }

    const targets = component === "all"
      ? Object.keys(CONFIG.components)
      : [component];

    const results = [];

    for (const key of targets) {
      const c = CONFIG.components[key];
      const libDir = componentPath(key, "repository/components/lib");
      const destJar = `${libDir}/${jarName}`;

      if (!existsSync(`${CONFIG.baseDir}/${c.dir}`)) {
        results.push(`⚠️  ${c.label} — component directory not found (extract it first)`);
        continue;
      }

      try {
        await execAsync(`mkdir -p "${libDir}" && cp "${tmpPath}" "${destJar}"`);
        results.push(`✅ ${c.label} — ${jarName} copied to ${libDir}`);
      } catch (err) {
        results.push(`❌ ${c.label} — copy failed: ${err.message}`);
      }
    }

    return {
      content: [{
        type: "text",
        text: `JDBC Driver Setup (${jarName}):\n` + results.join("\n"),
      }],
    };
  }
);

// ── Tool: check_update_level ─────────────────────────────────────────────────
server.tool(
  "check_update_level",
  "Show the current WSO2 U2 update level for each component by reading their updates/config.json. No update tool binary required.",
  {
    component: z.enum(["all", "tm", "km", "acp", "gw"]).default("all")
      .describe("Component to check, or 'all' for all components"),
  },
  async ({ component }) => {
    const targets = component === "all"
      ? Object.keys(CONFIG.components)
      : [component];

    const rows = [];
    for (const key of targets) {
      const c = CONFIG.components[key];
      const cfgPath = componentPath(key, "updates/config.json");
      if (!existsSync(cfgPath)) {
        rows.push(`⚠️  ${c.label.padEnd(22)} — updates/config.json not found`);
        continue;
      }
      try {
        const u = JSON.parse(readFileSync(cfgPath, "utf8"));
        const level   = u["update-level"] ?? "unknown";
        const channel = u["channel"]       ?? "unknown";
        const product = u["product"]?.pattern ?? c.dir;
        rows.push(`✅ ${c.label.padEnd(22)} level: ${String(level).padEnd(6)}  channel: ${channel}  (${product})`);
      } catch {
        rows.push(`❌ ${c.label.padEnd(22)} — failed to parse updates/config.json`);
      }
    }

    return {
      content: [{
        type: "text",
        text: "WSO2 U2 Update Levels\n" + "─".repeat(60) + "\n" + rows.join("\n"),
      }],
    };
  }
);

// ── Tool: apply_updates ───────────────────────────────────────────────────────
server.tool(
  "apply_updates",
  "Apply WSO2 U2 updates to one or all components. Runs the update binary from each component's own home directory. " +
  "Handles interactive credential prompts automatically. " +
  "Conflicts (locally modified files that also changed in the update) are auto-resolved per conflictResolution strategy.",
  {
    component: z.enum(["all", "tm", "km", "acp", "gw"]).default("all")
      .describe("Component to update, or 'all' for all components"),
    level: z.number().int().positive().optional()
      .describe("Target U2 level (e.g. 20). Omit to update to the latest available level."),
    stopFirst: z.boolean().default(true)
      .describe("Stop the component before applying updates (recommended, default: true)"),
    conflictResolution: z.enum(["keep-local", "use-update"]).default("keep-local")
      .describe("How to resolve file conflicts: 'keep-local' (default, safe for config files) or 'use-update' (accept WSO2's version)"),
  },
  async ({ component, level, stopFirst, conflictResolution }) => {
    const updCfg = CONFIG.updates;

    const targets = component === "all"
      ? Object.keys(CONFIG.components)
      : [component];

    const results = [];

    for (const key of targets) {
      const c = CONFIG.components[key];
      const productDir = `${CONFIG.baseDir}/${c.dir}`;

      if (!existsSync(productDir)) {
        results.push(`⚠️  ${c.label} — directory not found, skipping`);
        continue;
      }

      // Resolve binary: prefer per-component bin/ dir, fall back to config toolPath
      const arch = process.arch;
      const binDir = `${productDir}/bin`;
      let toolPath = updCfg?.toolPath;
      try {
        const { stdout: lsOut } = await execAsync(`ls "${binDir}/wso2update_"* 2>/dev/null || true`);
        const bins = lsOut.trim().split("\n").filter(Boolean);
        if (bins.length > 0) {
          const match = bins.find(b => arch === "arm64" ? b.includes("arm64") : !b.includes("arm64"));
          toolPath = match ?? bins[0];
        }
      } catch { /* use fallback */ }

      if (!toolPath) {
        results.push(`❌ ${c.label} — no wso2update binary found in ${binDir} and 'updates.toolPath' not set.\nRun setup_update_tool first.`);
        continue;
      }
      if (!existsSync(toolPath)) {
        results.push(`❌ ${c.label} — binary not found at: ${toolPath}`);
        continue;
      }

      // Read current level before update
      let levelBefore = "unknown";
      try {
        const u = JSON.parse(readFileSync(`${productDir}/updates/config.json`, "utf8"));
        levelBefore = u["update-level"] ?? "unknown";
      } catch { /* ignore */ }

      // Stop component first if requested
      if (stopFirst && isRunning(key)) {
        try {
          results.push(`⏸  ${c.label} — stopping before update...`);
          const script = componentPath(key, c.script);
          await execAsync(`"${script}" stop`);
          await new Promise((resolve) => {
            let n = 0;
            const iv = setInterval(() => {
              n++;
              if (!isRunning(key) || n >= 15) { clearInterval(iv); resolve(); }
            }, 2000);
          });
        } catch (e) {
          results.push(`⚠️  ${c.label} — could not stop cleanly: ${e.message}`);
        }
      } else if (isRunning(key)) {
        results.push(`⚠️  ${c.label} — is still running; stop it first or use stopFirst:true`);
        continue;
      }

      // Build args
      const args = level !== undefined ? [`--level`, String(level)] : [];

      const env = { ...process.env };
      if (updCfg?.credentials?.username) env.WSO2_UPDATES_USERNAME = updCfg.credentials.username;
      if (updCfg?.credentials?.password) env.WSO2_UPDATES_PASSWORD = updCfg.credentials.password;

      const { stdout, stderr, conflicts, exitCode, timedOut } = await runUpdateInteractive(
        toolPath, args,
        {
          cwd: productDir,
          env,
          credentials: updCfg?.credentials,
          conflictResolution,
          timeoutMs: 300000,
        }
      );

      // Read new level
      let levelAfter = "unknown";
      try {
        const u = JSON.parse(readFileSync(`${productDir}/updates/config.json`, "utf8"));
        levelAfter = u["update-level"] ?? "unknown";
      } catch { /* ignore */ }

      if (timedOut) {
        results.push(`⏱️  ${c.label} — timed out after 5 minutes`);
        continue;
      }

      const upgraded = levelAfter !== levelBefore;
      const icon = exitCode !== 0 ? "❌" : upgraded ? "✅" : "⏭️ ";

      let entry = `${icon} ${c.label}\n` +
        `   Home:   ${productDir}\n` +
        `   Binary: ${toolPath}\n` +
        `   Level:  ${levelBefore} → ${levelAfter}${level ? ` (target: ${level})` : " (latest)"}`;

      if (conflicts.length > 0) {
        entry += `\n\n   ⚠️  ${conflicts.length} conflict(s) — resolved with strategy: "${conflictResolution}"`;
        entry += "\n   Conflicted files:";
        conflicts.forEach(f => { entry += `\n     • ${f.file}`; });
        if (conflictResolution === "keep-local") {
          entry += "\n   ℹ️  Local versions kept. Review manually if WSO2 fixes affect these files.";
        } else {
          entry += "\n   ℹ️  Update versions applied. Back up your config if needed.";
        }
      }

      if (exitCode !== 0) {
        entry += `\n\n   Exit code: ${exitCode}`;
        const errLines = (stderr || stdout).trim().split("\n").slice(-5).join("\n   ");
        if (errLines) entry += `\n   ${errLines}`;
      } else {
        const lastLines = stdout.trim().split("\n").slice(-3).join(" | ");
        if (lastLines) entry += `\n   Output: ${lastLines}`;
      }

      results.push(entry);
    }

    return { content: [{ type: "text", text: "Update Results:\n\n" + results.join("\n\n") }] };
  }
);

// ── Tool: revert_updates ──────────────────────────────────────────────────────
server.tool(
  "revert_updates",
  "Revert the last WSO2 U2 update applied to a component. Runs from the component's own home directory. " +
  "Handles interactive credential and conflict prompts automatically. The component must be stopped first.",
  {
    component: z.enum(["tm", "km", "acp", "gw"])
      .describe("Component to revert"),
    conflictResolution: z.enum(["keep-local", "use-update"]).default("keep-local")
      .describe("How to resolve any conflicts during revert: 'keep-local' (default) or 'use-update'"),
  },
  async ({ component, conflictResolution }) => {
    const updCfg = CONFIG.updates;
    const c = CONFIG.components[component];
    const productDir = `${CONFIG.baseDir}/${c.dir}`;

    // Resolve binary: prefer per-component bin/ dir, fall back to config toolPath
    const arch = process.arch;
    const binDir = `${productDir}/bin`;
    let toolPath = updCfg?.toolPath;
    try {
      const { stdout: lsOut } = await execAsync(`ls "${binDir}/wso2update_"* 2>/dev/null || true`);
      const bins = lsOut.trim().split("\n").filter(Boolean);
      if (bins.length > 0) {
        const match = bins.find(b => arch === "arm64" ? b.includes("arm64") : !b.includes("arm64"));
        toolPath = match ?? bins[0];
      }
    } catch { /* use fallback */ }

    if (!toolPath) {
      return { content: [{ type: "text", text: `❌ No wso2update binary found in ${binDir} and 'updates.toolPath' not set.\nRun setup_update_tool first.` }] };
    }
    if (!existsSync(toolPath)) {
      return { content: [{ type: "text", text: `❌ Update tool not found at: ${toolPath}` }] };
    }

    if (isRunning(component)) {
      return { content: [{ type: "text", text: `⚠️  ${c.label} is still running. Stop it before reverting.` }] };
    }

    let levelBefore = "unknown";
    try {
      const u = JSON.parse(readFileSync(`${productDir}/updates/config.json`, "utf8"));
      levelBefore = u["update-level"] ?? "unknown";
    } catch { /* ignore */ }

    const env = { ...process.env };
    if (updCfg?.credentials?.username) env.WSO2_UPDATES_USERNAME = updCfg.credentials.username;
    if (updCfg?.credentials?.password) env.WSO2_UPDATES_PASSWORD = updCfg.credentials.password;

    const { stdout, stderr, conflicts, exitCode, timedOut } = await runUpdateInteractive(
      toolPath, ["revert"],
      { cwd: productDir, env, credentials: updCfg?.credentials, conflictResolution, timeoutMs: 120000 }
    );

    if (timedOut) {
      return { content: [{ type: "text", text: `⏱️  Revert timed out after 2 minutes.` }] };
    }

    let levelAfter = "unknown";
    try {
      const u = JSON.parse(readFileSync(`${productDir}/updates/config.json`, "utf8"));
      levelAfter = u["update-level"] ?? "unknown";
    } catch { /* ignore */ }

    let text = `${exitCode === 0 ? "✅" : "❌"} ${c.label} revert ${exitCode === 0 ? "succeeded" : "failed"}.\n` +
      `   Home:   ${productDir}\n` +
      `   Binary: ${toolPath}\n` +
      `   Level:  ${levelBefore} → ${levelAfter}`;

    if (conflicts.length > 0) {
      text += `\n\n   ⚠️  ${conflicts.length} conflict(s) — resolved with strategy: "${conflictResolution}"`;
      conflicts.forEach(f => { text += `\n     • ${f.file}`; });
    }

    if (exitCode !== 0) {
      const errLines = (stderr || stdout).trim().split("\n").slice(-5).join("\n   ");
      text += `\n\n   Exit code: ${exitCode}\n   ${errLines}`;
    } else if (stdout.trim()) {
      text += `\n   Output: ${stdout.trim().split("\n").slice(-3).join(" | ")}`;
    }

    return { content: [{ type: "text", text }] };
  }
);


// ── Tool: setup_update_tool ───────────────────────────────────────────────────
server.tool(
  "setup_update_tool",
  "Download the WSO2 U2 update tool binary into each component's bin/ directory using the bundled update_tool_setup.sh script. " +
  "Runs per-component so each node has its own binary, matching WSO2's recommended approach. " +
  "Auto-detects OS/arch. Pass a specific component to set up only that one.",
  {
    component: z.enum(["all", "tm", "km", "acp", "gw"]).default("all")
      .describe("Which component(s) to set up the update tool for (default: all)"),
  },
  async ({ component = "all" }) => {
    const targets = component === "all"
      ? Object.keys(CONFIG.components)
      : [component];

    const arch = process.arch;
    const results = [];
    let lastBinary = null;

    for (const key of targets) {
      const c = CONFIG.components[key];
      const productDir = `${CONFIG.baseDir}/${c.dir}`;
      const setupScript = `${productDir}/bin/update_tool_setup.sh`;

      if (!existsSync(setupScript)) {
        results.push(`⚠️  ${c.label} — update_tool_setup.sh not found (component extracted?)`);
        continue;
      }

      try {
        await execAsync(`bash "${setupScript}"`, { timeout: 120000 });

        const binDir = `${productDir}/bin`;
        const { stdout: lsOut } = await execAsync(`ls "${binDir}/wso2update_"* 2>/dev/null || true`);
        const bins = lsOut.trim().split("\n").filter(Boolean);

        if (bins.length === 0) {
          results.push(`⚠️  ${c.label} — script ran but no binary found in ${binDir}`);
          continue;
        }

        const match = bins.find(b => arch === "arm64" ? b.includes("arm64") : !b.includes("arm64"));
        const chosen = match ?? bins[0];
        await execAsync(`chmod +x "${chosen}"`);
        lastBinary = chosen;
        results.push(`✅ ${c.label} — ${chosen}`);
      } catch (err) {
        results.push(`❌ ${c.label} — ${err.message.split("\n")[0]}`);
      }
    }

    // Save fallback toolPath to config.json (used if per-component binary is missing)
    if (lastBinary) {
      const configPath = new URL("./config.json", import.meta.url).pathname;
      let rawCfg = {};
      try { rawCfg = JSON.parse(readFileSync(configPath, "utf8")); } catch { /* new config */ }
      if (!rawCfg.updates) rawCfg.updates = {};
      rawCfg.updates.toolPath = lastBinary;
      writeFileSync(configPath, JSON.stringify(rawCfg, null, 2));
      if (!CONFIG.updates) CONFIG.updates = {};
      CONFIG.updates.toolPath = lastBinary;
    }

    const summary = results.join("\n");
    return {
      content: [{
        type: "text",
        text: `WSO2 Update Tool Setup:\n\n${summary}\n\n` +
              (lastBinary
                ? `Each component now has its own binary in its bin/ directory.\n` +
                  `apply_updates and revert_updates will use the per-component binary automatically.\n\n` +
                  `Next: set updates.credentials in config.json:\n` +
                  `  "credentials": { "username": "your@email", "password": "..." }`
                : `⚠️  No binaries were set up. Check that components are extracted first.`),
      }],
    };
  }
);


// ── Tool: toggle_diagnostics_startup ─────────────────────────────────────────
// Enables or disables the auto-start of the WSO2 runtime diagnostics agent
// by commenting / uncommenting the launch line in each component's startup script.
//
// The diagnostics tool is launched from the startup script (e.g. api-cp.sh, tm.sh, etc.)
// with a line like:
//   "$CARBON_HOME"/diagnostics-tool/bin/diagnostics.sh &
// This tool wraps that line in an if-block controlled by an env var, or simply
// comments it out depending on the action requested.
server.tool(
  "toggle_diagnostics_startup",
  "Enable or disable the auto-start of the WSO2 diagnostics agent (DiagnosticsApp) for each component. " +
  "When disabled, the diagnostics agent will NOT be launched when the component starts up. " +
  "This edits the component's startup shell script by commenting/uncommenting the diagnostics launch line. " +
  "Use stop_diagnostics to stop an already-running diagnostics agent.",
  {
    component: z.enum(["all", "tm", "km", "acp", "gw"]).default("all")
      .describe("Which component to affect, or 'all' for all components"),
    action: z.enum(["disable", "enable"]).default("disable")
      .describe("'disable' comments out the diagnostics launch; 'enable' restores it"),
  },
  async ({ component, action }) => {
    const targets = component === "all"
      ? Object.keys(CONFIG.components)
      : [component];

    // Map component key → startup script name patterns
    const scriptNames = {
      acp: ["api-cp.sh"],
      km:  ["key-manager.sh"],
      tm:  ["tm.sh", "traffic-manager.sh"],
      gw:  ["gateway.sh", "universal-gateway.sh"],
    };

    const DISABLE_MARKER = "# [DIAGNOSTICS DISABLED by MCP]";
    const results = [];

    for (const key of targets) {
      const c = CONFIG.components[key];
      const binDir = `${CONFIG.baseDir}/${c.dir}/bin`;
      const candidateNames = scriptNames[key] || [];

      // Find the actual startup script
      let startupScript = null;
      for (const name of candidateNames) {
        const candidate = `${binDir}/${name}`;
        if (existsSync(candidate)) { startupScript = candidate; break; }
      }

      // Fallback: scan for any .sh that contains the diagnostics launch line
      if (!startupScript) {
        try {
          const { stdout } = await execAsync(
            `grep -rl "diagnostics-tool/bin/diagnostics.sh" "${binDir}" 2>/dev/null | head -1`
          );
          const found = stdout.trim();
          if (found) startupScript = found;
        } catch { /* no match */ }
      }

      if (!startupScript) {
        results.push(`⚠️  ${c.label} — startup script not found in ${binDir}`);
        continue;
      }

      const content = readFileSync(startupScript, "utf8");

      // Patterns we look for
      const activePattern = /^("?\$CARBON_HOME"?\/diagnostics-tool\/bin\/diagnostics\.sh\s*&\s*)$/m;
      const disabledPattern = new RegExp(`^${DISABLE_MARKER.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\n# (.*)$`, "m");

      if (action === "disable") {
        if (content.includes(DISABLE_MARKER)) {
          results.push(`⚪ ${c.label} — diagnostics startup already disabled`);
          continue;
        }
        if (!activePattern.test(content)) {
          results.push(`⚠️  ${c.label} — diagnostics launch line not found in ${startupScript}`);
          continue;
        }
        const updated = content.replace(activePattern, `${DISABLE_MARKER}\n# $1`);
        writeFileSync(startupScript, updated, "utf8");
        results.push(`🔇 ${c.label} — diagnostics startup DISABLED in ${startupScript}`);

      } else {
        // enable: restore commented-out line
        if (!content.includes(DISABLE_MARKER)) {
          if (activePattern.test(content)) {
            results.push(`⚪ ${c.label} — diagnostics startup already enabled`);
          } else {
            results.push(`⚠️  ${c.label} — diagnostics launch line not found in ${startupScript}`);
          }
          continue;
        }
        const updated = content.replace(
          new RegExp(`${DISABLE_MARKER.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\n# `, "g"),
          ""
        );
        writeFileSync(startupScript, updated, "utf8");
        results.push(`🔔 ${c.label} — diagnostics startup ENABLED in ${startupScript}`);
      }
    }

    return { content: [{ type: "text", text: `Toggle Diagnostics Startup (action=${action}):\n` + results.join("\n") }] };
  }
);


server.resource(
  "deployment-config",
  "apim://config",
  "Full WSO2 APIM 4.6.0 distributed deployment configuration",
  async () => ({
    contents: [{
      uri: "apim://config",
      mimeType: "application/json",
      text: JSON.stringify(CONFIG, null, 2),
    }],
  })
);

server.resource(
  "deployment-toml-km",
  "apim://toml/km",
  "Key Manager deployment.toml template",
  async () => {
    const path = `${CONFIG.baseDir}/${CONFIG.components.km.dir}/repository/conf/deployment.toml`;
    const text = existsSync(path) ? readFileSync(path, "utf8") : "(file not found)";
    return { contents: [{ uri: "apim://toml/km", mimeType: "text/plain", text }] };
  }
);

server.resource(
  "deployment-toml-acp",
  "apim://toml/acp",
  "ACP deployment.toml template",
  async () => {
    const path = `${CONFIG.baseDir}/${CONFIG.components.acp.dir}/repository/conf/deployment.toml`;
    const text = existsSync(path) ? readFileSync(path, "utf8") : "(file not found)";
    return { contents: [{ uri: "apim://toml/acp", mimeType: "text/plain", text }] };
  }
);

server.resource(
  "deployment-toml-tm",
  "apim://toml/tm",
  "Traffic Manager deployment.toml template",
  async () => {
    const path = `${CONFIG.baseDir}/${CONFIG.components.tm.dir}/repository/conf/deployment.toml`;
    const text = existsSync(path) ? readFileSync(path, "utf8") : "(file not found)";
    return { contents: [{ uri: "apim://toml/tm", mimeType: "text/plain", text }] };
  }
);

server.resource(
  "deployment-toml-gw",
  "apim://toml/gw",
  "Gateway deployment.toml template",
  async () => {
    const path = `${CONFIG.baseDir}/${CONFIG.components.gw.dir}/repository/conf/deployment.toml`;
    const text = existsSync(path) ? readFileSync(path, "utf8") : "(file not found)";
    return { contents: [{ uri: "apim://toml/gw", mimeType: "text/plain", text }] };
  }
);

// ─── Start ───────────────────────────────────────────────────────────────────

const transport = new StdioServerTransport();
await server.connect(transport);
