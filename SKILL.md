---
name: skills-manager
description: Manage the skills depot. Import external skills, review inbox, approve/reject, list skills. Use when user says "import skill", "review skills", "skill inbox", "approve skill", "reject skill", "skills status", or "search skills".
disable-model-invocation: true
---

# Skills Manager

Manage skills through the **skills-depot** MCP server. All skills are stored in a centralized repo and served with global or project-level scoping.

## How It Works

- **Global skills** — visible to all Claude instances everywhere
- **Project skills** — only visible when Claude is running in that specific project
- **Inbox** — staging area for external skills pending your review

## IMPORTANT: Always pass your project name

Every MCP tool has a `project` parameter. **Always pass your current working directory name** (just the folder name, not the full path) as the `project` value. For example, if you're working in `/home/user/my-app`, pass `project: "my-app"`. This ensures project-scoped skills are correctly matched.

## Available Actions

When the user wants to manage skills, determine which action and use the corresponding MCP tool:

| User says | MCP tool to call | What it does |
|-----------|-----------------|--------------|
| "show my skills" / "skills status" | `list_skills` | Lists global + project skills |
| "what's in my inbox" / "review inbox" | `list_skills` (with include_inbox: true) | Shows pending skills |
| "read [skill]" / "show me [skill]" | `get_skill` | Shows full SKILL.md content |
| "import skill from [URL]" | `import_skill` | Fetches into inbox + safety scan |
| "approve [skill]" | `approve_skill` | Moves from inbox to global/project |
| "reject [skill]" | `reject_skill` | Moves to rejected with reason |
| "search for [query]" | `search_skills` | Keyword search across all skills |

## Guardrails

1. **Never auto-approve** — always show safety analysis and wait for explicit user confirmation
2. **Always show the menu** — if the user's intent is unclear, show the actions table above
3. **Scope confirmation** — when approving, always ask: "Install as **global** (all projects) or **project-specific** (which project)?"
4. **Rejection requires a reason** — always ask why before rejecting
5. **Flag high-risk skills** — if import_skill returns 🔴 HIGH risk items, prominently warn the user

## Safety Analysis (shown after import)

The MCP server automatically scans imported skills for:
- Bash commands (especially eval/exec/source)
- File writes (especially to ~/.claude/ or system dirs)
- Network calls (curl/wget to unknown URLs)
- Env vars and secrets references
- MCP server spawning
- Scope creep (modifying Claude settings, disabling safety, package installs, obfuscation)
