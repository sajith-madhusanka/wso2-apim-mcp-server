// WSO2 APIM 4.6.0 Distributed Deployment — MCP Server
// Exposes tools and resources for managing the deployment lifecycle.
//
// Configuration is loaded from config.json next to this file.
// Copy config.example.json → config.json and edit for your environment.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { exec, execSync } from "child_process";
import { promisify } from "util";
import { readFileSync, existsSync } from "fs";
import { createRequire } from "module";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { z } from "zod";

const execAsync = promisify(exec);

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

// ─── Resources ───────────────────────────────────────────────────────────────

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
