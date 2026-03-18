# WSO2 APIM 4.6.0 Distributed Deployment — MCP Server

An [MCP (Model Context Protocol)](https://modelcontextprotocol.io) server that manages the full lifecycle of a **WSO2 API Manager 4.6.0 distributed deployment** — extraction, database setup, startup, shutdown, log viewing, and U2 updates — all through natural language prompts.

## Choose Your Topology

| Branch | Nodes | Description |
|--------|-------|-------------|
| [`cp-tm-gw`](../../tree/cp-tm-gw) | 3 | Control Plane + Traffic Manager + Gateway |
| [`cp-tm-gw-km`](../../tree/cp-tm-gw-km) | 4 | + separate Key Manager node (recommended for production) |

> `main` tracks the latest changes. Pick the branch that matches your deployment.

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
**Portal URLs (ACP):** `https://localhost:9443/publisher` | `/devportal` | `/admin`

---

## Prerequisites

- **Node.js 18+** (tested on v20)
- **MySQL 8.x** running locally
- WSO2 APIM 4.6.0 ZIP files (you only need to know where they are — the agent handles the rest):
  - `wso2am-tm-4.6.0.x.zip`
  - `wso2am-acp-4.6.0.x.zip` (also used for the KM node)
  - `wso2am-universal-gw-4.6.0.zip`

---

## Setup

### 1. Clone and install

```bash
git clone https://github.com/sajith-madhusanka/wso2-apim-mcp-server.git
cd wso2-apim-mcp-server
npm install
cp config.example.json config.json
```

> `config.json` is git-ignored and managed by the AI agent — you do not need to edit it manually.

### 2. Register with your AI client

Choose your client below, then proceed to **Getting Started**.

---

#### GitHub Copilot CLI

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

---

#### Claude Desktop

Add to your Claude Desktop config:

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

Restart Claude Desktop. A 🔌 icon confirms the server is connected.

---

#### Claude CLI (Claude Code)

```bash
claude mcp add wso2-apim node /absolute/path/to/wso2-apim-mcp-server/server.js
claude mcp list   # verify
```

Or add to `~/.claude.json` / `.mcp.json` (project scope) manually using the same format.

---

#### VS Code (GitHub Copilot Agent mode)

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

Or for workspace scope, create `.vscode/mcp.json` in your project root with the same `servers` block.

---

#### Other clients (Cursor, Windsurf, Zed, Continue.dev)

All use the same pattern — `command: "node"`, `args: ["/path/to/server.js"]`:

| Client | Config file |
|--------|-------------|
| Cursor | `~/.cursor/mcp.json` |
| Windsurf | `~/.codeium/windsurf/mcp_config.json` |
| Zed | `~/.config/zed/settings.json` (key: `context_servers`) |
| Continue.dev | `~/.continue/config.json` (key: `mcpServers` array) |

---

## Getting Started

Once the MCP server is registered, just tell the agent about your environment. The agent will call the `configure` tool to write `config.json` automatically — **no manual file editing needed**.

### First-time setup flow

Tell the agent (one message is enough):

```
"Set up a WSO2 APIM 4.6.0 distributed deployment.
 Base directory: /path/to/my/deployment
 WSO2 account: me@example.com / mypassword
 MySQL root password: MyPass123"
```

The agent will:
1. Call `configure` to save your paths and credentials to `config.json`
2. Ask you to download the APIM profile ZIPs from [wso2.com/api-manager](https://wso2.com/api-manager/) (Enterprise tab → version 4.6.0 → TM, ACP, GW ZIPs) and place them in your base directory
3. Call `extract_components` to unzip all components
4. Call `setup_jdbc_driver` to download and install the MySQL connector
5. Call `setup_databases` to create databases and run init scripts
6. Call `apply_config` to write deployment.toml for every node from config.json values
7. Call `start_all` to start all nodes in the correct order

### Subsequent sessions

```
"Start all APIM components"
"Check status of all components"
"Show errors from the ACP logs"
"Stop all components"
```

---

## Available Tools

| Tool | Description |
|------|-------------|
| `configure` | Save environment settings (paths, credentials, DB names) to `config.json` — called by the agent, not the user. Auto-sets `zips.km = zips.acp`. Supports `amDbName`/`sharedDbName` to rename databases. |
| `apply_config` | Write `deployment.toml` for each component from current config.json values (DB host/port/name/user/password). Only `deployment.toml` is modified. Port offsets are FIXED. |
| `extract_components` | Extract component ZIPs into `baseDir` — scans by prefix (e.g. `wso2am-tm-*.zip`) so U2-level suffix is ignored; KM auto-renamed from ACP zip |
| `setup_jdbc_driver` | Download MySQL JDBC driver from Maven Central, copy to all component lib dirs |
| `setup_databases` | Create MySQL databases, users, and run init scripts. If a database already exists, pauses and asks whether to use existing (`use_existing`), recreate (`force_reinit`), or stop to reconfigure (`reconfigure`) |
| `start_component` | Start one component: `tm`, `km`, `acp`, or `gw` — clears stale metadata, polls log every 2s |
| `start_all` | Start all components in correct order (TM → KM → ACP → GW), halts on first failure |
| `stop_component` | Gracefully stop one component using its shutdown script, confirms exit |
| `stop_all` | Stop all components in correct order (GW → ACP → KM → TM) |
| `stop_diagnostics` | Stop the runtime diagnostics agent (`org.wso2.diagnostics.DiagnosticsApp`) that auto-starts with each component |
| `toggle_diagnostics_startup` | Enable or disable auto-start of the diagnostics agent by editing the component startup script — set `action=disable` to prevent it launching on next start |
| `check_status` | Live status of all components + portal URLs |
| `view_logs` | Snapshot of recent log lines for any component (supports `errors_only` filter) |
| `tail_logs` | Open a new terminal window running `tail -f` on a component's log — supports macOS Terminal, Linux (gnome-terminal, konsole, xfce4-terminal, xterm), and Windows PowerShell |
| `setup_update_tool` | Download the WSO2 U2 binary into each component's `bin/` dir via the bundled `update_tool_setup.sh` |
| `check_update_level` | Show current U2 level for each component (reads `updates/config.json` — no binary needed) |
| `apply_updates` | Apply U2 updates per-component; handles credential and conflict prompts automatically |
| `revert_updates` | Revert the last U2 update on a component |
| `get_deployment_info` | Full topology, fixed port offsets, credentials, and known issue fixes |

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

The Key Manager is a **dedicated token-validation and key-management plane** that offloads OAuth2/JWT operations from the API Control Plane.

| Concern | Details |
|---------|---------|
| **Binary** | Uses the ACP zip (`wso2am-acp-4.6.0.x.zip`) — activated via `bin/key-manager.sh` |
| **Port** | HTTPS **9446** (offset 3) |
| **Databases** | `APIM_46_AM_DB` + `APIM_46_SHARED_DB` (same MySQL users as ACP) |
| **Event hub** | Subscribes to ACP JMS at `tcp://localhost:5672` |
| **Token validation** | Gateway calls `https://localhost:9446/services/` for every inbound API request |

```toml
# Key Manager deployment.toml highlights
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

WSO2 U2 (Update 2.0) delivers bug fixes and security patches as cumulative update levels. Each level is a superset of all previous levels.

### Workflow

```
1. "Set up the WSO2 update tool"             → setup_update_tool
   (downloads binary into each component's bin/ dir — one-time per machine)

2. "What U2 level are my APIM components on?" → check_update_level

3. "Update all APIM components to the latest U2 level"
   — or —
   "Update all components to U2 level 20"    → apply_updates (auto-stops each node first)

4. "Start all APIM components"               → start_all
```

> **Credential prompt:** If the update tool asks for a password, the agent feeds it automatically from `config.json` (set via `configure`).  
> **Conflicts:** Locally modified files that also changed in the update are auto-resolved. Default strategy is `keep-local` (safe for `deployment.toml`). Pass `conflictResolution: "use-update"` to accept WSO2's version.

To revert:
```
"Revert the last update on the ACP"         → revert_updates
```

---

## Database Configuration

Both databases are created with **`CHARACTER SET latin1`** (required by WSO2 APIM — do not use `utf8mb4`).

| Database | User | Purpose |
|----------|------|---------|
| `APIM_46_AM_DB` | `apim46_am_user` | APIs, Applications, Subscriptions, Throttling |
| `APIM_46_SHARED_DB` | `apim46_shared_user` | User management, Registry |

---

## Known Issues & Fixes

| Issue | Fix |
|-------|-----|
| Space in directory path breaks bash sessions | Use underscores in directory names (e.g. `distributed_deployment`) |
| `&` in JDBC URL causes XML parse error | Use `?useSSL=false` only; set `autoReconnect` in `[pool_options]` |
| `create_admin_account` must be `true` on all nodes | Shared DB has no admin until the first node creates it |
| Stale `.metadata` blocks config regeneration | Delete `repository/resources/conf/.metadata/metadata_*.properties` before restart |

---

## Contributing

Contributions are welcome — new tools, bug fixes, better docs.

### Project Structure

```
wso2-apim-mcp-server/
├── server.js            # All MCP tools and resources (single-file server)
├── config.json          # Your local config — git-ignored, managed by the agent
├── config.example.json  # Committed template — update when adding new config keys
├── package.json
└── README.md
```

### Adding a New Tool

1. **Define the tool** in `server.js` using `server.tool()`:

```js
server.tool(
  "my_tool_name",
  "What this tool does (shown to AI)",
  {
    component: z.enum(["tm", "acp", "gw"]).describe("Which component"),
    dryRun:    z.boolean().default(false).describe("Preview without executing"),
  },
  async ({ component, dryRun }) => {
    return { content: [{ type: "text", text: "Result" }] };
  }
);
```

2. `node --check server.js` to validate syntax.
3. Update `config.example.json` if new config keys are needed.
4. Add a row to the **Available Tools** table and an example prompt.

### Conventions

- Return `{ content: [{ type: "text", text: "..." }] }` for all responses
- Emoji status prefixes: `✅` success · `❌` error · `⚠️` warning · `⏭️` skipped · `🛑` stopped
- Poll in **2-second intervals** for long-running operations
- Always check `isRunning(key)` before starting/stopping

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

| Branch | Purpose | PR target |
|--------|---------|-----------|
| `main` | 4-node topology — source of truth | Open PRs here |
| `cp-tm-gw-km` | Stable 4-node snapshot | Synced from `main` |
| `cp-tm-gw` | 3-node snapshot (no KM) | Synced from `main` |

### Testing

```bash
node --check server.js                             # syntax check
npx @modelcontextprotocol/inspector node server.js # browser UI for manual tool calls
```

---

## License

MIT

---

## Changelog

### v1.8.0 — Config Propagation & Diagnostics Control
- New `apply_config` tool: generates and writes `deployment.toml` for each component from `config.json` values (MySQL host/port, DB names/users/passwords). Only `deployment.toml` is modified — no other files touched. Port offsets are FIXED per component (ACP:0, GW:1, TM:2, KM:3). Tested on all 4 nodes.
- New `stop_diagnostics` tool: stops `org.wso2.diagnostics.DiagnosticsApp` that auto-starts with each component. Finds process by `-Dapp.home=<component>/diagnostics-tool` path; SIGTERM → SIGKILL fallback.
- New `toggle_diagnostics_startup` tool: permanently disable/enable the auto-start of the diagnostics agent by commenting/uncommenting the launch line in each component's startup shell script. Use `action=disable` to prevent it launching on next start; `action=enable` to restore it.
- New `tail_logs` tool: opens a new terminal window running `tail -f` on a component's log file and returns immediately. Cross-platform: macOS Terminal (AppleScript), Linux (gnome-terminal → konsole → xfce4-terminal → xterm), Windows PowerShell. Supports `errors_only` filter.
- `configure`: auto-sets `zips.km = zips.acp` when `zipAcp` is provided (KM always uses the ACP archive)
- `extract_components`: prefix-based zip discovery (`wso2am-tm-*.zip`) — U2 level suffix in filename is ignored; KM prefix mapped to `wso2am-acp-*`
- `get_deployment_info`: port offsets labelled FIXED with deployment.toml `[server]` example; databases now read from live CONFIG; `&amp;` escaping documented for multi-param JDBC URLs
- Getting Started flow updated: configure → ZIPs → extract → JDBC → DB → **apply_config** → start

### v1.6.0 — Agent-managed Configuration
- New `configure` tool: agent writes `config.json` from conversation — users no longer need to edit it manually
- Interactive credential and conflict handling in `apply_updates` / `revert_updates` (spawn-based, auto-feeds stdin)
- `conflictResolution` parameter: `keep-local` (default) or `use-update`
- README rewritten: removed redundant setup steps, merged Quick Start into Getting Started, removed duplicate client registration sections

### v1.5.0 — Automated U2 Tool Setup
- New `setup_update_tool` tool: runs bundled `bin/update_tool_setup.sh` for all components, downloads the correct binary for the current OS/arch
- `apply_updates` / `revert_updates` resolve binary per-component from its own `bin/` dir

### v1.4.0 — WSO2 U2 Update Tools
- New `check_update_level`, `apply_updates`, `revert_updates` tools
- `config.json` gains `updates.toolPath` and `updates.credentials` section

### v1.3.0 — Extract Components + JDBC Driver Setup
- New `extract_components` tool: unzips TM/ACP/GW/KM with automatic KM rename
- New `setup_jdbc_driver` tool: downloads MySQL connector from Maven Central

### v1.2.0 — Graceful Stop + start_all / stop_all
- `stop_component` uses shutdown script instead of `kill -9`, polls for exit
- New `stop_all` (GW → ACP → KM → TM) and `start_all` (TM → KM → ACP → GW) tools

### v1.1.0 — Key Manager Node
- Separate KM node extracted from ACP zip (`bin/key-manager.sh`)
- KM `deployment.toml` with `server_role = "key-manager"`, offset 3

### v1.0.0 — Initial Release
- Tools: start/stop/check_status/view_logs/setup_databases/get_deployment_info
- Resources: `apim://config`, `apim://toml/{acp,tm,gw}`
