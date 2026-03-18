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

function isRunning(key) {
  const pidFile = componentPath(key, CONFIG.components[key].pidFile);
  if (!existsSync(pidFile)) return false;
  const pid = readFileSync(pidFile, "utf8").trim();
  try { process.kill(Number(pid), 0); return true; } catch { return false; }
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
  "Gracefully stop a WSO2 APIM 4.6.0 component using its shutdown script (tm | km | acp | gw). Stop order: GW → ACP → KM → TM.",
  { component: z.enum(["km", "tm", "acp", "gw"]).describe("Component to stop") },
  async ({ component }) => {
    const c = CONFIG.components[component];

    if (!isRunning(component)) {
      return { content: [{ type: "text", text: `⚠️  ${c.label} is not running.` }] };
    }

    const script = componentPath(component, c.script);
    try {
      await execAsync(`"${script}" stop`);

      // Poll every 2s (up to 30s) to confirm the process has exited
      const stopped = await new Promise((resolve) => {
        let attempts = 0;
        const iv = setInterval(() => {
          attempts++;
          if (!isRunning(component)) { clearInterval(iv); resolve(true); }
          else if (attempts >= 15) { clearInterval(iv); resolve(false); }
        }, 2000);
      });

      return {
        content: [{
          type: "text",
          text: stopped
            ? `🛑 ${c.label} stopped successfully.`
            : `⚠️  ${c.label} stop command issued but process may still be running. Check with check_status.`,
        }],
      };
    } catch (err) {
      return { content: [{ type: "text", text: `❌ Failed to stop ${c.label}:\n${err.message}` }] };
    }
  }
);

// ── Tool: stop_all ───────────────────────────────────────────────────────────
server.tool(
  "stop_all",
  "Gracefully stop all WSO2 APIM 4.6.0 components in the correct order: GW → ACP → KM → TM.",
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
      try {
        const script = componentPath(component, c.script);
        await execAsync(`"${script}" stop`);
        const stopped = await new Promise((resolve) => {
          let attempts = 0;
          const iv = setInterval(() => {
            attempts++;
            if (!isRunning(component)) { clearInterval(iv); resolve(true); }
            else if (attempts >= 15) { clearInterval(iv); resolve(false); }
          }, 2000);
        });
        results.push(stopped
          ? `🛑 ${c.label} — stopped`
          : `⚠️  ${c.label} — stop issued, may still be running`);
      } catch (err) {
        results.push(`❌ ${c.label} — error: ${err.message}`);
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
      const running  = isRunning(key);
      const started  = running && hasStarted(key);
      const icon     = started ? "✅" : running ? "⏳" : "🔴";
      const status   = started ? "Running" : running ? "Starting..." : "Stopped";
      return `${icon} ${c.label.padEnd(22)} port ${c.mgtPort}   ${status}`;
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

// ── Tool: setup_databases ────────────────────────────────────────────────────
server.tool(
  "setup_databases",
  "Create MySQL databases and users for WSO2 APIM 4.6.0 and run initialization scripts.",
  {},
  async () => {
    const { host, port, adminUser, adminPassword } = CONFIG.mysql;
    const { amDb, sharedDb } = CONFIG.databases;
    const acp = CONFIG.components.acp;
    const acpBase = `${CONFIG.baseDir}/${acp.dir}`;
    const mysqlCmd = (db, sql) =>
      `mysql -u ${adminUser} -p${adminPassword} -h ${host} -P ${port} ${db} -e "${sql}" 2>&1`;

    const sqlStatements = `
CREATE DATABASE IF NOT EXISTS ${amDb.name} CHARACTER SET latin1;
CREATE DATABASE IF NOT EXISTS ${sharedDb.name} CHARACTER SET latin1;
CREATE USER IF NOT EXISTS '${amDb.user}'@'%' IDENTIFIED WITH mysql_native_password BY '${amDb.password}';
CREATE USER IF NOT EXISTS '${amDb.user}'@'localhost' IDENTIFIED WITH mysql_native_password BY '${amDb.password}';
CREATE USER IF NOT EXISTS '${sharedDb.user}'@'%' IDENTIFIED WITH mysql_native_password BY '${sharedDb.password}';
CREATE USER IF NOT EXISTS '${sharedDb.user}'@'localhost' IDENTIFIED WITH mysql_native_password BY '${sharedDb.password}';
GRANT ALL PRIVILEGES ON ${amDb.name}.* TO '${amDb.user}'@'%';
GRANT ALL PRIVILEGES ON ${amDb.name}.* TO '${amDb.user}'@'localhost';
GRANT ALL PRIVILEGES ON ${sharedDb.name}.* TO '${sharedDb.user}'@'%';
GRANT ALL PRIVILEGES ON ${sharedDb.name}.* TO '${sharedDb.user}'@'localhost';
FLUSH PRIVILEGES;
    `.trim().replace(/\n/g, " ");

    try {
      await execAsync(`mysql -u ${adminUser} -p${adminPassword} -h ${host} -P ${port} -e "${sqlStatements}" 2>&1`);
      await execAsync(`mysql -u ${adminUser} -p${adminPassword} -h ${host} -P ${port} ${sharedDb.name} < "${acpBase}/dbscripts/mysql.sql" 2>&1`);
      await execAsync(`mysql -u ${adminUser} -p${adminPassword} -h ${host} -P ${port} ${amDb.name} < "${acpBase}/dbscripts/apimgt/mysql.sql" 2>&1`);

      return {
        content: [{
          type: "text",
          text: `✅ Databases set up successfully!\n\n` +
                `  ${amDb.name}     → user: ${amDb.user}\n` +
                `  ${sharedDb.name} → user: ${sharedDb.user}\n` +
                `  Password (both): ${amDb.password}`,
        }],
      };
    } catch (err) {
      return { content: [{ type: "text", text: `❌ Database setup failed:\n${err.message}` }] };
    }
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
    if (params.updatesUsername    !== undefined) { set(rawCfg, "updates.credentials.username", params.updatesUsername); changed.push(`updates.credentials.username = "${params.updatesUsername}"`); }
    if (params.updatesPassword    !== undefined) { set(rawCfg, "updates.credentials.password", params.updatesPassword); changed.push(`updates.credentials.password = ****`); }
    if (params.zipTm              !== undefined) { set(rawCfg, "zips.tm", params.zipTm); changed.push(`zips.tm = "${params.zipTm}"`); }
    if (params.zipAcp             !== undefined) { set(rawCfg, "zips.acp", params.zipAcp); changed.push(`zips.acp = "${params.zipAcp}"`); }
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

🧩 Components & Ports:
   Component           Dir                        Offset  Mgt HTTPS
   ─────────────────────────────────────────────────────────────────
   Key Manager         wso2am-km-4.6.0               3     9446
   Traffic Manager     wso2am-tm-4.6.0               2     9445
   API Control Plane   wso2am-acp-4.6.0              0     9443
   Universal Gateway   wso2am-universal-gw-4.6.0     1     9444 (API: 8244/8281)

🗄️  Databases (MySQL @ localhost:3306):
   APIM_46_AM_DB      → apim46_am_user   / APIM46_DB@123
   APIM_46_SHARED_DB  → apim46_shared_user / APIM46_DB@123
   MySQL admin        → root / Admin@123

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
   Used by ACP and Gateway for token validation/generation

▶️  Start Order:  TM → KM → ACP → GW
⏹️  Stop Order:   GW → ACP → KM → TM

⚠️  Known Issues & Fixes:
   1. Space in directory path breaks bash sessions
      → Base dir uses underscore: distributed_deployment
   2. Ampersand (&) in JDBC URLs causes XML parse errors
      → Use single ?useSSL=false param; set autoReconnect in pool_options
   3. create_admin_account must be true on all nodes (shared DB)
   4. Delete .metadata files before restart to force config regeneration
      Path: repository/resources/conf/.metadata/
`,
    }],
  })
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
      const zipPath = zips[key];
      const targetDir = `${CONFIG.baseDir}/${c.dir}`;

      if (!zipPath) {
        results.push(`⚠️  ${c.label} — no zip path in config.zips.${key}`);
        continue;
      }
      if (!existsSync(zipPath)) {
        results.push(`❌ ${c.label} — zip not found: ${zipPath}`);
        continue;
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
