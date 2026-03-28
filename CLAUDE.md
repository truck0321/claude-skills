# Claude Skills Depot

MCP server that manages Claude Code skills from a centralized GitHub repo.

## Architecture

```
claude-skills/          # This repo — the MCP server
  server/src/index.ts   # TypeScript MCP server (Express + StreamableHTTP)
  SKILL.md              # The "skills-manager" skill (tells Claude how to use the tools)
  Dockerfile            # node:22-slim, builds TS inside container
  docker-compose.yml    # Deploys to mcp.axiodev.com via nginx-proxy

truck0321/mcpdepot      # Separate repo — the skills data store
  global/               # Skills available to all projects
  projects/{name}/      # Skills scoped to a specific project (matched by cwd name)
  inbox/                # Staging area for imported skills pending review
  rejected/             # Rejected skills with reasons
  registry.json         # Tracks all skills, sources, and status
```

## How It Works

- Server clones `mcpdepot` on startup, `git pull` on every read, `git commit && push` on every write
- Skills are just directories containing a `SKILL.md` file (and optional supporting files)
- Project matching: Claude passes its working directory name as `project` param; server looks in `projects/{name}/`
- In stdio mode, project auto-detects from cwd basename as fallback

## MCP Tools

| Tool | Description |
|------|-------------|
| `list_skills` | List global + project + inbox skills |
| `get_skill` | Read a skill's full SKILL.md |
| `import_skill` | Clone from GitHub URL or local path into inbox |
| `approve_skill` | Move from inbox to global or project scope |
| `reject_skill` | Move from inbox to rejected with reason |
| `search_skills` | Keyword search across skill names and descriptions |

## Deployment

- **Production**: `mcp.axiodev.com` via Docker on prod server (N:\Dev\claude-skills)
- **Proxy**: nginx-proxy with Let's Encrypt auto-SSL
- **No auth on MCP endpoint** — Claude Code's HTTP MCP client requires OAuth 2.1 flow which we don't implement; server is on a private domain behind HTTPS

## Environment Variables

| Var | Required | Description |
|-----|----------|-------------|
| `TRANSPORT` | No | `stdio` (default) or `http` |
| `PORT` | No | HTTP port (default: 3000) |
| `SKILLS_REPO_URL` | No | Git repo URL (default: truck0321/mcpdepot) |
| `SKILLS_REPO_LOCAL` | No | Local clone path (default: ~/.skills-depot/mcpdepot) |
| `SKILLS_PROJECT` | No | Override project name (default: cwd basename in stdio mode) |
| `GIT_TOKEN` | For push | GitHub PAT with Contents read/write on mcpdepot |
| `GIT_USER` | No | Git commit author name (default: skills-depot) |
| `GIT_EMAIL` | No | Git commit author email (default: skills-depot@automated) |

## Installing the MCP Server

**Remote (from any machine):**
```json
{
  "mcpServers": {
    "skills-depot": {
      "type": "http",
      "url": "https://mcp.axiodev.com/mcp"
    }
  }
}
```

**Local (stdio mode):**
```json
{
  "mcpServers": {
    "skills-depot": {
      "command": "node",
      "args": ["C:/_dev/claude-skills/server/dist/index.js"]
    }
  }
}
```

## Development

```bash
cd server
npm install
npm run build      # Compile TypeScript
npm run dev        # Watch mode
npm start          # Run compiled server (stdio)
```

## Deploy to Production

```powershell
# On prod server (N:\Dev\claude-skills)
git pull; docker compose up -d --build
```

## Key Design Decisions

- **Git-backed storage** over Docker volumes — skills survive container rebuilds, version history is free, accessible from any machine
- **No OAuth/auth** on MCP endpoint — Claude Code's HTTP client triggers OAuth Dynamic Client Registration on 401, which we don't implement
- **New McpServer per HTTP session** — a single shared McpServer instance causes `server.connect()` to detach previous transports, killing active sessions
- **No `express.json()` middleware** — StreamableHTTP transport handles its own body parsing; Express consuming the body first causes parse errors
- **node:22-slim over Alpine** — Alpine's OpenSSL build has cipher issues on the prod host
