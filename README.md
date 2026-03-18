# WSO2 APIM 4.6.0 Distributed Deployment — MCP Server

> **Branch:** `cp-tm-gw` — **3-node topology** (Control Plane + Traffic Manager + Gateway)
> For the 4-node setup with a separate Key Manager, see branch [`cp-tm-gw-km`](../../tree/cp-tm-gw-km).


An [MCP (Model Context Protocol)](https://modelcontextprotocol.io) server that manages the full lifecycle of a **WSO2 API Manager 4.6.0 distributed deployment** (Traffic Manager, Key Manager, API Control Plane, Universal Gateway) with MySQL.

Use it with [GitHub Copilot CLI](https://docs.github.com/copilot/concepts/agents/about-copilot-cli) or any MCP-compatible client (Claude Desktop, VS Code, etc.).

---

## Deployment Architecture

```
┌────────────────────────────────────────────────────────────────────┐
│               WSO2 APIM 4.6.0 Distributed (4-node)                │
├───────────────┬───────────────┬─────────────────┬──────────────────┤
│Traffic Manager│  Key Manager  │API Control Plane│Universal Gateway │
│  (TM) :9445   │  (KM) :9446   │  (ACP) :9443    │   (GW) :9444     │
│  offset: 2    │  offset: 3    │  offset: 0      │   offset: 1      │
│               │               │                 │   API: 8244/8281 │
└──────┬────────┴───────┬───────┴────────┬────────┴──────────┬───────┘
       │                │                │                   │
       │   Token validation (KM→GW)      │ Artifact sync     │
       │   KM ←→ ACP key mgmt (9446)     │ ACP→GW (9443)     │
       │                │                │                   │
       │   Event hub JMS (5672) ACP→KM, ACP→GW              │
       │                                                      │
       └──────────── Throttle events :9613 / :9713 ───────────┘
                            │
                ┌───────────────────────┐
                │  MySQL (localhost:3306)│
                │  APIM_46_AM_DB         │  ← ACP, TM, KM
                │  APIM_46_SHARED_DB     │  ← All nodes
                └───────────────────────┘
```

**Start order:** TM → ACP → GW  
**Portal URLs (ACP):** `https://localhost:9443/publisher` | `/devportal` | `/admin`  

---

## Prerequisites

- **Node.js 18+** (tested on v20)
- **MySQL 8.x** running locally
- WSO2 APIM 4.6.0 ZIP files (point `config.json → zips` at them; the `extract_components` tool handles extraction):
  - `wso2am-tm-4.6.0.17.zip`
  - `wso2am-acp-4.6.0.18.zip`
  - `wso2am-universal-gw-4.6.0.zip`
- MySQL JDBC driver — **downloaded automatically** by the `setup_jdbc_driver` tool (no manual copy needed)

---

## Setup

### 1. Clone the repository

```bash
git clone https://github.com/<your-username>/wso2-apim-mcp-server.git
cd wso2-apim-mcp-server
npm install
```

### 2. Configure for your environment

```bash
cp config.example.json config.json
```

Edit `config.json`:

```jsonc
{
  "baseDir": "/path/to/your/distributed_deployment",      // ← change this
  "zips": {
    "tm":  "/path/to/wso2am-tm-4.6.0.17.zip",            // ← change this
    "acp": "/path/to/wso2am-acp-4.6.0.18.zip",           // ← change this
    "km":  "/path/to/wso2am-acp-4.6.0.18.zip",           // same as acp
    "gw":  "/path/to/wso2am-universal-gw-4.6.0.zip"      // ← change this
  },
  "jdbcDriver": {
    "version": "8.0.29",
    "downloadUrl": "https://repo1.maven.org/maven2/mysql/mysql-connector-java/8.0.29/mysql-connector-java-8.0.29.jar"
  },
  "mysql": {
    "host": "127.0.0.1",
    "port": 3306,
    "adminUser": "root",
    "adminPassword": "your-mysql-root-password"           // ← change this
  },
  ...
}
```

> ⚠️ `config.json` is git-ignored — your credentials stay local.

### 3. Register with GitHub Copilot CLI

Add to `~/.copilot/mcp-config.json`:

```json
{
  "mcpServers": {
    "wso2-apim": {
      "command": "node",
      "args": ["/absolute/path/to/wso2-apim-mcp-server/server.js"],
      "description": "WSO2 APIM 4.6.0 distributed deployment manager"
    }
  }
}
```

Then in Copilot CLI run `/mcp` to verify the server is loaded.

### 4. Register with Claude Desktop

Add to `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS):

```json
{
  "mcpServers": {
    "wso2-apim": {
      "command": "node",
      "args": ["/absolute/path/to/wso2-apim-mcp-server/server.js"]
    }
  }
}
```

---

## Quick Start (First-Time Setup)

After cloning, configuring `config.json`, and registering the MCP server, run these prompts **in order**:

```
1. "Extract all WSO2 APIM components"
2. "Download and install the MySQL JDBC driver"
3. "Set up the APIM databases"
4. "Start all APIM components"
```

> The `setup_jdbc_driver` tool downloads the MySQL connector automatically — no manual JAR download required.
> The `setup_databases` tool creates databases with **`CHARACTER SET latin1`** as required by WSO2 APIM.

The MCP server handles extraction, driver installation, database init, and sequenced startup automatically.

---

## Available Tools

| Tool | Description |
|------|-------------|
| `extract_components` | Extract component ZIPs into `baseDir` — KM auto-renamed from ACP zip |
| `setup_jdbc_driver` | Download MySQL JDBC driver from Maven Central, copy to all component lib dirs |
| `setup_databases` | Create MySQL databases, users, and run init scripts |
| `start_component` | Start one component: `tm`, `acp`, or `gw` — clears stale metadata, polls log every 2s |
| `start_all` | Start all 3 components in correct order (TM → ACP → GW), halts on first failure |
| `stop_component` | Gracefully stop one component using its shutdown script, confirms exit |
| `stop_all` | Stop all 3 components in correct order (GW → ACP → TM) |
| `check_status` | Live status of all 3 components + portal URLs |
| `view_logs` | Tail log lines for any component (supports `errors_only` filter) |
| `get_deployment_info` | Full topology, ports, credentials, and known issue fixes |

## Available Resources

| URI | Description |
|-----|-------------|
| `apim://config` | Full deployment config as JSON |
| `apim://toml/acp` | Live `deployment.toml` for ACP |
| `apim://toml/tm` | Live `deployment.toml` for TM |
| `apim://toml/km` | Live `deployment.toml` for KM |
| `apim://toml/gw` | Live `deployment.toml` for GW |

---

## Example Prompts

```
"Extract all WSO2 APIM components"
"Extract only the Traffic Manager"
"Download and install the MySQL JDBC driver"
"Set up the APIM databases"
"Start all APIM components"
"Start the WSO2 Traffic Manager"
"Start the Key Manager"
"Stop all APIM components"
"Check status of all APIM components"
"Show errors from the ACP logs"
"What are the gateway API endpoints?"
```

---


## Known Issues & Fixes

| Issue | Fix |
|-------|-----|
| Space in directory path breaks bash sessions | Use `distributed_deployment` (underscore) as the directory name |
| `&` in JDBC URL causes XML parse error | Use `?useSSL=false` only; set `autoReconnect` in `pool_options` |
| `create_admin_account` must be `true` on all nodes | Shared DB — first node to start creates the admin |
| Stale `.metadata` blocks config regeneration | Delete `repository/resources/conf/.metadata/metadata_*.properties` before restart |

---

## Database Configuration

Both databases are created with **`CHARACTER SET latin1`** (required by WSO2 APIM — do not use `utf8mb4`).

| Database | User | Purpose |
|----------|------|---------|
| `APIM_46_AM_DB` | `apim46_am_user` | APIs, Applications, Subscriptions, Throttling |
| `APIM_46_SHARED_DB` | `apim46_shared_user` | User management, Registry |

---

## Integration Guides

The server communicates over **stdio** (standard MCP transport), so it works with any MCP-compatible client. After cloning and running `npm install`, follow the guide for your client below.

> In all examples replace `/absolute/path/to/wso2-apim-mcp-server` with the real path on your machine.

---

### GitHub Copilot CLI

**Config file:** `~/.copilot/mcp-config.json`

```json
{
  "mcpServers": {
    "wso2-apim": {
      "command": "node",
      "args": ["/absolute/path/to/wso2-apim-mcp-server/server.js"],
      "description": "WSO2 APIM 4.6.0 distributed deployment manager"
    }
  }
}
```

Verify inside the CLI:
```
/mcp
```

---

### Claude Desktop

**Config file locations:**
| OS | Path |
|----|------|
| macOS | `~/Library/Application Support/Claude/claude_desktop_config.json` |
| Windows | `%APPDATA%\Claude\claude_desktop_config.json` |
| Linux | `~/.config/claude/claude_desktop_config.json` |

```json
{
  "mcpServers": {
    "wso2-apim": {
      "command": "node",
      "args": ["/absolute/path/to/wso2-apim-mcp-server/server.js"]
    }
  }
}
```

Restart Claude Desktop after saving. A 🔌 icon in the chat confirms the server is connected.

---

### VS Code (GitHub Copilot / Agent mode)

**Option A — User-level** (applies to all projects):

Open Command Palette → `Preferences: Open User Settings (JSON)` and add:

```json
{
  "mcp": {
    "servers": {
      "wso2-apim": {
        "type": "stdio",
        "command": "node",
        "args": ["/absolute/path/to/wso2-apim-mcp-server/server.js"]
      }
    }
  }
}
```

**Option B — Workspace-level** (per project):

Create `.vscode/mcp.json` in your project root:

```json
{
  "servers": {
    "wso2-apim": {
      "type": "stdio",
      "command": "node",
      "args": ["/absolute/path/to/wso2-apim-mcp-server/server.js"]
    }
  }
}
```

Switch Copilot Chat to **Agent mode** (`@` → select agent) to use the tools.

---

### Cursor

**Config file:** `~/.cursor/mcp.json`  *(or `.cursor/mcp.json` inside a project for workspace scope)*

```json
{
  "mcpServers": {
    "wso2-apim": {
      "command": "node",
      "args": ["/absolute/path/to/wso2-apim-mcp-server/server.js"]
    }
  }
}
```

Restart Cursor. The server appears under **Settings → MCP**.

---

### Windsurf (Codeium)

**Config file:** `~/.codeium/windsurf/mcp_config.json`

```json
{
  "mcpServers": {
    "wso2-apim": {
      "command": "node",
      "args": ["/absolute/path/to/wso2-apim-mcp-server/server.js"]
    }
  }
}
```

Restart Windsurf. Tools become available in the **Cascade** AI panel.

---

### Zed

**Config file:** `~/.config/zed/settings.json`

```json
{
  "context_servers": {
    "wso2-apim": {
      "command": {
        "path": "node",
        "args": ["/absolute/path/to/wso2-apim-mcp-server/server.js"]
      },
      "settings": {}
    }
  }
}
```

---

### Continue.dev

**Config file:** `~/.continue/config.json`

```json
{
  "mcpServers": [
    {
      "name": "wso2-apim",
      "command": "node",
      "args": ["/absolute/path/to/wso2-apim-mcp-server/server.js"]
    }
  ]
}
```

---

### Claude CLI (Claude Code)

**Install Claude CLI:** `npm install -g @anthropic-ai/claude-code`

**Option A — CLI command (recommended):**

```bash
claude mcp add wso2-apim node /absolute/path/to/wso2-apim-mcp-server/server.js
```

**Option B — Config file:** `~/.claude.json`

```json
{
  "mcpServers": {
    "wso2-apim": {
      "command": "node",
      "args": ["/absolute/path/to/wso2-apim-mcp-server/server.js"]
    }
  }
}
```

**Option C — Project scope:** `.mcp.json` in your project root

```json
{
  "mcpServers": {
    "wso2-apim": {
      "command": "node",
      "args": ["/absolute/path/to/wso2-apim-mcp-server/server.js"]
    }
  }
}
```

Verify the server is loaded:
```bash
claude mcp list
```

Then use it interactively:
```
claude> Start the Traffic Manager
claude> Start the Key Manager
claude> Check status of all APIM components
```

---

### Quick Reference

| Client | Config file | Restart required |
|--------|-------------|-----------------|
| GitHub Copilot CLI | `~/.copilot/mcp-config.json` | New session (`/mcp`) |
| Claude CLI (Code) | `~/.claude.json` or `claude mcp add` | No |
| Claude Desktop | `~/Library/Application Support/Claude/claude_desktop_config.json` | Yes |
| VS Code | User `settings.json` or `.vscode/mcp.json` | Reload window |
| Cursor | `~/.cursor/mcp.json` | Yes |
| Windsurf | `~/.codeium/windsurf/mcp_config.json` | Yes |
| Zed | `~/.config/zed/settings.json` | Yes |
| Continue.dev | `~/.continue/config.json` | Yes |

---

## Contributing

Contributions are welcome — whether it's a new tool, a bug fix, or better docs.

---

### Project Structure

```
wso2-apim-mcp-server/
├── server.js            # All MCP tools and resources (single-file server)
├── config.json          # Your local config (git-ignored)
├── config.example.json  # Committed template — update this when adding new config keys
├── package.json
└── README.md
```

> All tools and resources live in `server.js`. The file is structured in clearly labelled sections with comments like `// ── Tool: start_component`.

---

### Adding a New Tool

1. **Define the tool** in `server.js` using `server.tool()`:

```js
server.tool(
  "my_tool_name",                       // unique snake_case name
  "What this tool does (shown to AI)",  // description — be precise
  {
    // Zod schema for input parameters
    component: z.enum(["tm", "acp", "gw"]).describe("Which component"),
    dryRun:    z.boolean().default(false).describe("Preview without executing"),
  },
  async ({ component, dryRun }) => {
    // ... your logic ...
    return {
      content: [{ type: "text", text: "Result text here" }],
    };
  }
);
```

2. **Validate syntax** before committing:
```bash
node --check server.js
```

3. **Update `config.example.json`** if your tool needs new config keys.

4. **Update the Tools table** in this README.

5. **Add an example prompt** to the Example Prompts section.

---

### Modifying an Existing Tool

Each tool is a self-contained `server.tool(...)` block. Find the block by its comment header:

```
// ── Tool: start_component ──
```

Key conventions:
- Return `{ content: [{ type: "text", text: "..." }] }` for all responses
- Use emoji prefixes for status: `✅` success · `❌` error · `⚠️` warning · `⏭️` skipped · `🛑` stopped
- Poll in **2-second intervals** (not fixed sleeps) for long-running operations
- Always check `isRunning(key)` before starting/stopping
- Clear stale `.metadata` files before starting a component

---

### Adding a New Resource

Resources expose read-only data (config files, logs, etc.) to the AI context:

```js
server.resource(
  "my-resource-id",          // internal ID (kebab-case)
  "apim://my/uri",           // URI used in prompts
  "Human-readable description",
  async () => ({
    contents: [{
      uri: "apim://my/uri",
      mimeType: "text/plain",  // or "application/json"
      text: "... content ...",
    }],
  })
);
```

---

### Branch Strategy

| Branch | Purpose | PR target |
|--------|---------|-----------|
| `main` | 4-node topology (with KM) — source of truth | Open PRs here |
| `cp-tm-gw-km` | Stable 4-node snapshot | Synced from `main` |
| `cp-tm-gw` | 3-node snapshot (no KM) | Synced from `main` with KM stripped |

**Always open PRs against `main`.** The `cp-tm-gw-km` and `cp-tm-gw` branches are synced after each release.

> Note: This is the `cp-tm-gw` (3-node) branch. Changes to KM-specific tools are not applicable here.

When modifying `server.js`, if the change applies to both topologies, document that in your PR description so the maintainer can sync appropriately.

---

### Testing Your Changes

There is no automated test suite yet. To manually verify:

1. **Check syntax:**
   ```bash
   node --check server.js
   ```

2. **Run the server locally** and call it via the MCP inspector:
   ```bash
   npx @modelcontextprotocol/inspector node server.js
   ```
   This opens a browser UI where you can invoke tools directly.

3. **Test with your AI client** — restart the session and try the tool via a natural language prompt.

---

### Submitting a Pull Request

1. Fork the repo and create a branch: `git checkout -b feat/my-new-tool`
2. Make changes to `server.js` (and `config.example.json` / `README.md` as needed)
3. Validate: `node --check server.js`
4. Open a PR against `main` with a clear description of what the tool does and why

---


## License

MIT

---

## Changelog

### v1.3.0 — Extract Components + JDBC Driver Setup
- New `extract_components` tool: unzips TM/ACP/GW/KM into `baseDir` with automatic rename for KM
- New `setup_jdbc_driver` tool: downloads MySQL connector from Maven Central and copies to all component lib dirs
- `config.json` now supports `zips` (per-component zip paths) and `jdbcDriver` sections
- Full zero-to-running setup via MCP prompts only

### v1.2.0 — Graceful Stop + start_all / stop_all
- `stop_component` now calls the proper shutdown script (`gateway.sh stop` etc.) instead of `kill -9`
- Polls every 2s (up to 30s) to confirm the process has exited
- New `stop_all` tool: stops GW → ACP → KM → TM in one command
- New `start_all` tool: starts TM → KM → ACP → GW, halts on first failure

### v1.1.0 — Key Manager Node + Rapid Startup Polling
- New `wso2am-km-4.6.0` node extracted from ACP zip (`bin/key-manager.sh`)
- Port offset **3** → Management HTTPS: **9446**, HTTP: **9766**
- ACP and Gateway `[apim.key_manager]` now point to `https://localhost:9446/services/`
- KM subscribes to ACP event hub for key management events (`tcp://localhost:5672`)
- `start_component` now polls the log every **2 seconds** (up to 90s) and returns actual startup time + Management URL
- Updated MCP tools/resources to include `km` in all enums and `apim://toml/km` resource
- **Updated start order: TM → KM → ACP → GW**

### v1.0.0 — Initial Release
- 3-node topology: TM, ACP, GW
- MySQL database setup (`setup_databases` tool)
- `start_component`, `stop_component`, `check_status`, `view_logs`, `get_deployment_info`
- Multi-agent integration guides (Copilot CLI, Claude Desktop, VS Code, Cursor, Windsurf, Zed, Continue.dev)
