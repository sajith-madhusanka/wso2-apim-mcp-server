# WSO2 APIM 4.6.0 MCP Server

An [MCP (Model Context Protocol)](https://modelcontextprotocol.io) server that manages the full lifecycle of a **WSO2 API Manager 4.6.0 distributed deployment** — extraction, database setup, configuration, startup, shutdown, log viewing, and U2 updates — all through natural language with your AI assistant.

## Choose Your Topology

| Branch | Nodes | Description |
|--------|-------|-------------|
| [`cp-tm-gw`](../../tree/cp-tm-gw) | 3 | Control Plane + Traffic Manager + Gateway |
| [`cp-tm-gw-km`](../../tree/cp-tm-gw-km) | 4 | + separate Key Manager node (recommended for production) |

> **Start here:** Pick the branch that matches your deployment, then follow the setup below.

---

## Architecture

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
**Portal URLs:** `https://localhost:9443/publisher` · `/devportal` · `/admin`

---

## Prerequisites

| Requirement | Details |
|-------------|---------|
| **Node.js** | v18 or later |
| **MySQL** | 8.x running locally |
| **APIM ZIPs** | Downloaded from [wso2.com/api-manager](https://wso2.com/api-manager/) → Enterprise → 4.6.0 |
| **WSO2 account** | Only needed for U2 updates — [wso2.com/user](https://wso2.com/user) |

ZIP files needed:
- `wso2am-tm-4.6.0.x.zip` (Traffic Manager)
- `wso2am-acp-4.6.0.x.zip` (Control Plane — also used for Key Manager)
- `wso2am-universal-gw-4.6.0.zip` (Gateway)

---

## Setup

### 1. Clone and install dependencies

```bash
git clone https://github.com/sajith-madhusanka/wso2-apim-mcp-server.git
cd wso2-apim-mcp-server
npm install
```

### 2. Configure environment variables

```bash
cp env.example .env
```

Edit `.env` with your values:

```bash
# Minimum required fields
APIM_BASE_DIR=/path/to/your/deployment     # where components will be extracted
APIM_MYSQL_ADMIN_PASSWORD=yourpassword     # MySQL root/admin password
APIM_ZIP_TM=/path/to/wso2am-tm-4.6.0.x.zip
APIM_ZIP_ACP=/path/to/wso2am-acp-4.6.0.x.zip
APIM_ZIP_GW=/path/to/wso2am-universal-gw-4.6.0.zip
```

Load the environment variables before starting your AI client:

```bash
source .env
```

> **One-time setup:** Run `source .env` in any terminal session before launching your AI assistant. All credentials and paths are read from these environment variables — no manual configuration is needed inside the AI chat.

### 3. Register the MCP server with your AI client

Pick your client:

<details>
<summary><strong>GitHub Copilot CLI</strong></summary>

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

Verify with `/mcp` in the CLI.

</details>

<details>
<summary><strong>Claude Desktop</strong></summary>

| OS | Config file |
|----|-------------|
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

Restart Claude Desktop. A 🔌 icon confirms the server is connected.

</details>

<details>
<summary><strong>Claude CLI (Claude Code)</strong></summary>

```bash
claude mcp add wso2-apim node /absolute/path/to/wso2-apim-mcp-server/server.js
claude mcp list   # verify
```

</details>

<details>
<summary><strong>VS Code (GitHub Copilot Agent mode)</strong></summary>

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

For workspace scope, create `.vscode/mcp.json` with the same `servers` block.

</details>

<details>
<summary><strong>Other clients (Cursor, Windsurf, Zed, Continue.dev)</strong></summary>

All use `command: "node"`, `args: ["/path/to/server.js"]`:

| Client | Config file |
|--------|-------------|
| Cursor | `~/.cursor/mcp.json` |
| Windsurf | `~/.codeium/windsurf/mcp_config.json` |
| Zed | `~/.config/zed/settings.json` (`context_servers` key) |
| Continue.dev | `~/.continue/config.json` (`mcpServers` array) |

</details>

### 4. Start your first deployment

Open your AI assistant and say:

```
Set up a WSO2 APIM 4.6.0 distributed deployment
```

The agent will:
1. Extract component ZIPs into your `APIM_BASE_DIR`
2. Download and install the MySQL JDBC driver
3. Create databases, users, and run init scripts
4. Write `deployment.toml` for every node
5. Start all nodes in the correct order (TM → KM → ACP → GW)

---

## Environment Variables Reference

All configuration lives in `.env`. The file is git-ignored — never committed.

| Variable | Default | Description |
|----------|---------|-------------|
| `APIM_BASE_DIR` | *(required)* | Directory where APIM components are extracted |
| `APIM_MYSQL_HOST` | `127.0.0.1` | MySQL host |
| `APIM_MYSQL_PORT` | `3306` | MySQL port |
| `APIM_MYSQL_ADMIN_USER` | `root` | MySQL admin username |
| `APIM_MYSQL_ADMIN_PASSWORD` | *(required)* | MySQL admin password |
| `APIM_AM_DB_NAME` | `APIM_46_AM_DB` | AM database name |
| `APIM_AM_DB_USER` | `apim46_am_user` | AM database user |
| `APIM_AM_DB_PASSWORD` | `APIM46_DB@123` | AM database password |
| `APIM_SHARED_DB_NAME` | `APIM_46_SHARED_DB` | Shared database name |
| `APIM_SHARED_DB_USER` | `apim46_shared_user` | Shared database user |
| `APIM_SHARED_DB_PASSWORD` | `APIM46_DB@123` | Shared database password |
| `APIM_ADMIN_USERNAME` | `admin` | APIM console username |
| `APIM_ADMIN_PASSWORD` | `admin` | APIM console password |
| `APIM_WSO2_USERNAME` | *(for U2 only)* | WSO2 account email |
| `APIM_WSO2_PASSWORD` | *(for U2 only)* | WSO2 account password |
| `APIM_ZIP_TM` | *(required)* | Path to TM ZIP archive |
| `APIM_ZIP_ACP` | *(required)* | Path to ACP ZIP archive |
| `APIM_ZIP_GW` | *(required)* | Path to GW ZIP archive |
| `APIM_JDBC_DRIVER_VERSION` | `8.0.29` | MySQL JDBC driver version (Maven Central) |
| `APIM_UPDATE_TOOL_PATH` | *(auto-set)* | Path to wso2update binary — set by `setup_update_tool` |
| `APIM_ZIP_KM` | *(auto-set)* | KM ZIP path — auto-copied from `APIM_ZIP_ACP` |

---

## Available Tools

| Tool | Description |
|------|-------------|
| `configure` | Update `.env` values during a session — called by the agent, not the user |
| `apply_config` | Write `deployment.toml` for each component from current env values (DB host/port/name/user/password). Port offsets are FIXED |
| `extract_components` | Extract component ZIPs into `APIM_BASE_DIR` — scans by prefix so U2-level suffix is ignored; KM auto-renamed from ACP zip |
| `setup_jdbc_driver` | Download MySQL JDBC driver from Maven Central, copy to all component `lib/` dirs |
| `setup_databases` | Create MySQL databases, users, and run init scripts. Detects existing databases and asks whether to reuse or recreate |
| `start_component` | Start one component: `tm`, `km`, `acp`, or `gw` — polls log every 2s for successful startup |
| `start_all` | Start all components in correct order (TM → KM → ACP → GW), halts on first failure |
| `stop_component` | Gracefully stop one component, polls log for "Halting JVM" confirmation |
| `stop_all` | Stop all components in reverse order (GW → ACP → KM → TM) |
| `stop_diagnostics` | Stop the runtime diagnostics agent that auto-starts with each component |
| `toggle_diagnostics_startup` | Disable or re-enable auto-start of the diagnostics agent in the startup script |
| `check_status` | Live status of all components — shows PID, detection method, and portal URLs |
| `view_logs` | Recent log lines for any component — supports `errors_only` filter |
| `tail_logs` | Open a new terminal window with `tail -f` on a component's log (macOS, Linux, Windows) |
| `setup_update_tool` | Download the WSO2 U2 binary into each component's `bin/` dir |
| `check_update_level` | Show current U2 level for each component |
| `apply_updates` | Apply U2 updates — handles credential prompts and file conflicts automatically |
| `revert_updates` | Revert the last U2 update on a component |
| `get_deployment_info` | Full topology, port offsets, credentials, and known issue fixes |

## Available Resources

| URI | Description |
|-----|-------------|
| `apim://config` | Full deployment config as JSON |
| `apim://toml/acp` | Live `deployment.toml` for ACP |
| `apim://toml/tm` | Live `deployment.toml` for TM |
| `apim://toml/km` | Live `deployment.toml` for KM |
| `apim://toml/gw` | Live `deployment.toml` for GW |

---

## Key Manager Node

The Key Manager is a dedicated token-validation plane that offloads OAuth2/JWT operations from the API Control Plane.

| Detail | Value |
|--------|-------|
| **Binary** | Uses the ACP zip (`wso2am-acp-4.6.0.x.zip`) — activated via `bin/key-manager.sh` |
| **Port** | HTTPS **9446** (offset 3) |
| **Databases** | `APIM_46_AM_DB` + `APIM_46_SHARED_DB` |
| **Event hub** | Subscribes to ACP JMS at `tcp://localhost:5672` |
| **Token validation** | Gateway calls `https://localhost:9446/services/` for every API request |

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

---

## WSO2 U2 Updates

WSO2 U2 delivers bug fixes and security patches as cumulative update levels.

### Workflow

```
1. "Set up the WSO2 update tool"                → setup_update_tool
2. "What U2 level are my components on?"         → check_update_level
3. "Update all components to the latest level"
   "Update all components to U2 level 20"       → apply_updates
4. "Start all APIM components"                   → start_all
```

> **Credentials** are read automatically from `APIM_WSO2_USERNAME` / `APIM_WSO2_PASSWORD` in `.env`.  
> **Conflicts:** Pass `conflictResolution: "keep-local"` (default, safe for `deployment.toml`) or `"use-update"` to accept WSO2's version.

To revert: `"Revert the last update on the ACP"` → `revert_updates`

---

## Database Configuration

Both databases use **`CHARACTER SET latin1`** (required by WSO2 APIM).

| Database | Default User | Purpose |
|----------|-------------|---------|
| `APIM_46_AM_DB` | `apim46_am_user` | APIs, Applications, Subscriptions, Throttling |
| `APIM_46_SHARED_DB` | `apim46_shared_user` | User management, Registry |

**MySQL connection limits:** With 4 nodes × 7 connection pools (`maxActive=50` each), total = 350 connections. Set `max_connections=500` in MySQL:

```sql
SET GLOBAL max_connections = 500;
```

To persist across restarts, add to `my.cnf [mysqld]`:
```ini
max_connections=500
```

---

## Contributing

### Project Structure

```
wso2-apim-mcp-server/
├── server.js          # All MCP tools and resources (single-file server)
├── .env               # Your local config — git-ignored, never committed
├── env.example       # Template — commit this when adding new variables
├── package.json
└── README.md
```

### Adding a New Tool

1. Define the tool in `server.js` using `server.tool()`:

```js
server.tool(
  "my_tool_name",
  "What this tool does (shown to the AI)",
  {
    component: z.enum(["tm", "acp", "gw", "km"]).describe("Which component"),
    dryRun:    z.boolean().default(false).describe("Preview without executing"),
  },
  async ({ component, dryRun }) => {
    return { content: [{ type: "text", text: "Result" }] };
  }
);
```

2. Validate syntax: `node --check server.js` (or `npx @modelcontextprotocol/inspector node server.js` for interactive testing)
3. Add a `env.example` entry if new environment variables are needed
4. Add a row to the **Available Tools** table in `README.md`

### Conventions

| Convention | Detail |
|-----------|--------|
| Response format | `{ content: [{ type: "text", text: "..." }] }` |
| Status prefixes | `✅` success · `❌` error · `⚠️` warning · `⏭️` skipped · `🛑` stopped |
| Long operations | Poll every 2 seconds, show progress |
| Before start/stop | Always call `isRunning(key)` first |
| Env var names | `APIM_` prefix, `SCREAMING_SNAKE_CASE` |
| New config values | Add to `env.example` with a comment, add to `buildConfig()` in `server.js` |

### Adding a Resource

```js
server.resource(
  "my-resource-id",
  "apim://my/uri",
  "Human-readable description",
  async () => ({
    contents: [{ uri: "apim://my/uri", mimeType: "text/plain", text: "..." }],
  })
);
```

### Branch Strategy

| Branch | Purpose |
|--------|---------|
| `main` | 4-node topology — source of truth, open PRs here |
| `cp-tm-gw-km` | Stable 4-node snapshot, synced from `main` |
| `cp-tm-gw` | 3-node snapshot (no KM), synced from `main` |

### Testing

```bash
node --check server.js                              # syntax check
npx @modelcontextprotocol/inspector node server.js  # interactive browser UI
```

---

## License

MIT
