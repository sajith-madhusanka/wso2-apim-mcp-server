# WSO2 APIM 4.6.0 Distributed Deployment — MCP Server

An [MCP (Model Context Protocol)](https://modelcontextprotocol.io) server that manages the full lifecycle of a **WSO2 API Manager 4.6.0 distributed deployment** (Traffic Manager, API Control Plane, Universal Gateway) with MySQL.

Use it with [GitHub Copilot CLI](https://docs.github.com/copilot/concepts/agents/about-copilot-cli) or any MCP-compatible client (Claude Desktop, VS Code, etc.).

---

## Deployment Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                  WSO2 APIM 4.6.0 Distributed                │
├──────────────────┬──────────────────┬───────────────────────┤
│  Traffic Manager │ API Control Plane│   Universal Gateway   │
│  (TM) port 9445  │ (ACP) port 9443  │  (GW) port 9444       │
│  offset: 2       │  offset: 0       │  offset: 1            │
│                  │                  │  API: 8244 / 8281      │
└──────────────────┴──────────────────┴───────────────────────┘
         │                  │                    │
         └──────────────────┴────────────────────┘
                            │
                ┌───────────────────────┐
                │  MySQL (localhost:3306)│
                │  APIM_46_AM_DB         │
                │  APIM_46_SHARED_DB     │
                └───────────────────────┘
```

**Start order:** TM → ACP → GW  
**Portal URLs (ACP):** `https://localhost:9443/publisher` | `/devportal` | `/admin`

---

## Prerequisites

- **Node.js 18+** (tested on v20)
- **MySQL 8.x** running locally
- WSO2 APIM 4.6.0 ZIPs extracted into your `baseDir`:
  - `wso2am-tm-4.6.0` (from `wso2am-tm-4.6.0.17.zip`)
  - `wso2am-acp-4.6.0` (from `wso2am-acp-4.6.0.18.zip`)
  - `wso2am-universal-gw-4.6.0` (from `wso2am-universal-gw-4.6.0.zip`)
- MySQL JDBC connector JAR (`mysql-connector-java-8.x.jar`) copied into each component's `repository/components/lib/`

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
  "baseDir": "/path/to/your/distributed_deployment",  // ← change this
  "mysql": {
    "host": "127.0.0.1",
    "port": 3306,
    "adminUser": "root",
    "adminPassword": "your-mysql-root-password"       // ← change this
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

## Available Tools

| Tool | Description |
|------|-------------|
| `start_component` | Start `tm`, `acp`, or `gw` (clears stale metadata automatically) |
| `stop_component` | Stop a component by PID |
| `check_status` | Live status of all 3 components + portal URLs |
| `view_logs` | Tail log lines for any component (supports `errors_only` filter) |
| `setup_databases` | Create MySQL databases, users, and run init scripts |
| `get_deployment_info` | Full topology, ports, credentials, and known issue fixes |

## Available Resources

| URI | Description |
|-----|-------------|
| `apim://config` | Full deployment config as JSON |
| `apim://toml/acp` | Live `deployment.toml` for ACP |
| `apim://toml/tm` | Live `deployment.toml` for TM |
| `apim://toml/gw` | Live `deployment.toml` for GW |

---

## Example Prompts

```
"Start the WSO2 Traffic Manager"
"Check status of all APIM components"
"Show errors from the ACP logs"
"Set up the MySQL databases for APIM"
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

## License

MIT
