# WSO2 APIM 4.6.0 Distributed Deployment — MCP Server

## Choose Your Topology

| Branch | Nodes | Description |
|--------|-------|-------------|
| [`cp-tm-gw`](../../tree/cp-tm-gw) | 3 | Control Plane + Traffic Manager + Gateway |
| [`cp-tm-gw-km`](../../tree/cp-tm-gw-km) | 4 | + separate Key Manager node (recommended for production) |

> `main` tracks the latest changes. Pick the branch that matches your deployment.


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

**Start order:** TM → KM → ACP → GW  
**Portal URLs (ACP):** `https://localhost:9443/publisher` | `/devportal` | `/admin`  
**Key Manager Management URL:** `https://localhost:9446/carbon/`

---

## Prerequisites

- **Node.js 18+** (tested on v20)
- **MySQL 8.x** running locally
- WSO2 APIM 4.6.0 ZIP files (point `config.json → zips` at them; the `extract_components` tool handles extraction):
  - `wso2am-tm-4.6.0.17.zip`
  - `wso2am-acp-4.6.0.18.zip` (used for both ACP and KM nodes)
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
  "updates": {
    "toolPath": "/path/to/wso2update_darwin",               // ← path to WSO2 update tool binary
    "credentials": {
      "username": "your-wso2-email@example.com",            // ← WSO2 account email
      "password": "your-wso2-account-password"              // ← WSO2 account password
    }
  },
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
| `start_component` | Start one component: `tm`, `km`, `acp`, or `gw` — clears stale metadata, polls log every 2s |
| `start_all` | Start all 4 components in correct order (TM → KM → ACP → GW), halts on first failure |
| `stop_component` | Gracefully stop one component using its shutdown script, confirms exit |
| `stop_all` | Stop all 4 components in correct order (GW → ACP → KM → TM) |
| `check_status` | Live status of all 4 components + portal URLs |
| `view_logs` | Tail log lines for any component (supports `errors_only` filter) |
| `setup_update_tool` | Download the WSO2 U2 binary via the bundled `update_tool_setup.sh` — auto-detects OS/arch, saves path to `config.json` |
| `check_update_level` | Show current U2 update level for each component (reads `updates/config.json`) |
| `apply_updates` | Apply WSO2 U2 updates — optionally pin to a specific level with `level` parameter |
| `revert_updates` | Revert the last U2 update applied to a component |
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
"Download and install the MySQL JDBC driver"
"Set up the APIM databases"
"Start all APIM components"
"Stop all APIM components"
"Check status of all APIM components"
"What U2 level are my APIM components on?"
"Update all APIM components to the latest U2 level"
"Update the Traffic Manager to U2 level 20"
"Revert the last update on the Gateway"
"Show errors from the ACP logs"
"What are the gateway API endpoints?"
```

---

## Key Manager Node

The Key Manager is a **dedicated token-validation and key-management plane** that offloads OAuth2/JWT operations from the API Control Plane.

### How it works

| Concern | Details |
|---------|---------|
| **Binary** | Uses the ACP zip (`wso2am-acp-4.6.0.18.zip`) — the script `bin/key-manager.sh` activates the KM profile |
| **Port** | HTTPS **9446** (offset 3), HTTP 9766 |
| **Databases** | `APIM_46_AM_DB` + `APIM_46_SHARED_DB` (same MySQL users as ACP) |
| **Event hub** | Subscribes to ACP JMS at `tcp://localhost:5672` for key management events |
| **Token validation** | Gateway calls `https://localhost:9446/services/` for every inbound API request |

### Node connectivity

```
GW  ──(token validation)──▶  KM :9446
ACP ──(key manager config)──▶ KM :9446
KM  ──(event hub subscribe)──▶ ACP JMS :5672
```

### `deployment.toml` highlights

```toml
[server]
hostname = "localhost"
server_role = "key-manager"
offset = 3

[apim.event_hub]
enable = true
service_url = "https://localhost:9443/services/"
event_listening_endpoints = ["tcp://localhost:5672"]
```

### Starting the Key Manager

```bash
./distributed_deployment/wso2am-km-4.6.0/bin/key-manager.sh start
```

Or via MCP tool:

```
"Start the Key Manager"
```

---

## WSO2 U2 Updates

WSO2 U2 (Update 2.0) delivers bug fixes, security patches, and improvements as cumulative update levels. Each level is a superset of all previous levels.

### Setup (One-time)

The WSO2 update tool binary is bundled with each product pack — **no manual download needed**. Just run:

```
"Set up the WSO2 update tool"   → setup_update_tool
```

This runs the bundled `bin/update_tool_setup.sh` script, which contacts the WSO2 update API, downloads the correct binary for your OS and architecture, and automatically saves the path to `config.json` as `updates.toolPath`.

Then add your WSO2 account credentials to `config.json`:

```json
"updates": {
  "toolPath": "/auto/detected/by/setup_update_tool",
  "credentials": {
    "username": "your-wso2-email@example.com",
    "password": "your-wso2-account-password"
  }
}
```

> 💡 `setup_update_tool` defaults to the `acp` component's bin dir. Pass `component: "tm"` (or any other) to use a different one.

<details>
<summary>Manual download (alternative)</summary>

If you prefer to download manually from **https://updates.wso2.com**:

| OS | Binary |
|----|--------|
| macOS (Intel) | `wso2update_darwin` |
| macOS (Apple Silicon) | `wso2update_darwin_arm64` |
| Linux (64-bit) | `wso2update_linux` |
| Windows | `wso2update_windows.exe` |

Set `updates.toolPath` in `config.json` to the absolute path of the binary.

</details>

### Update Workflow

```
1. "Set up the WSO2 update tool"             → setup_update_tool (first time only)
2. "Check the current U2 update level"       → check_update_level
3. "Stop all APIM components"                → stop_all
4. "Apply updates to all components"         → apply_updates (latest)
   — or —
   "Update all components to U2 level 20"   → apply_updates with level: 20
5. "Start all APIM components"               → start_all
```

### Reverting an Update

```
"Revert the last update on the ACP"         → revert_updates (component: acp)
```

> ⚠️ Always stop the component before updating or reverting. Use `stopFirst: true` (default) with `apply_updates` to auto-stop.

### Example Prompts

```
"Set up the WSO2 update tool"
"What U2 level are my APIM components on?"
"Update all APIM components to the latest U2 level"
"Update the Traffic Manager to U2 level 20"
"Revert the last update on the Gateway"
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

### v1.5.0 — Automated U2 Tool Setup
- New `setup_update_tool` tool: runs bundled `bin/update_tool_setup.sh`, downloads the correct wso2update binary for the current OS/arch, and auto-saves path to `config.json`
- No more manual binary download — full U2 workflow is now self-contained
- README: WSO2 U2 Updates section rewritten with simplified setup, manual-download collapsible, and updated workflow

### v1.4.0 — WSO2 U2 Update Tools
- New `check_update_level` tool: reads `updates/config.json` from each component — no binary needed
- New `apply_updates` tool: runs wso2update binary with optional `--level` flag to pin to a specific U2 level; auto-stops component before updating
- New `revert_updates` tool: reverts last applied update
- `config.json` gains `updates.toolPath` and `updates.credentials` section
- README: new WSO2 U2 Updates section with workflow, OS binary table, and example prompts

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
