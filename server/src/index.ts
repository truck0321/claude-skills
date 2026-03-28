#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import * as fs from "fs";
import * as path from "path";
import * as crypto from "crypto";
import { execSync } from "child_process";
import express from "express";

// --- Configuration ---

const TRANSPORT = process.env.TRANSPORT || "stdio";
const PORT = parseInt(process.env.PORT || "3000", 10);
const AUTH_TOKEN = process.env.SKILLS_DEPOT_TOKEN || "";

const REPO_URL = process.env.SKILLS_REPO_URL || "https://github.com/truck0321/mcpdepot.git";
const REPO_LOCAL = process.env.SKILLS_REPO_LOCAL || path.join(
  process.env.HOME || process.env.USERPROFILE || "/tmp",
  ".skills-depot",
  "mcpdepot"
);
// Default project: env var > cwd basename (stdio mode fallback)
const DEFAULT_PROJECT = process.env.SKILLS_PROJECT || (
  (process.env.TRANSPORT || "stdio") === "stdio" ? path.basename(process.cwd()) : ""
);

// Resolve project name: per-call param > default
function resolveProject(param?: string): string {
  return param || DEFAULT_PROJECT;
}

// Git identity for commits
const GIT_USER = process.env.GIT_USER || "skills-depot";
const GIT_EMAIL = process.env.GIT_EMAIL || "skills-depot@automated";
const GIT_TOKEN = process.env.GIT_TOKEN || "";

// Build authenticated URL for push
function authedRepoUrl(): string {
  if (!GIT_TOKEN) return REPO_URL;
  try {
    const url = new URL(REPO_URL);
    url.username = GIT_TOKEN;
    url.password = "x-oauth-basic";
    return url.toString();
  } catch {
    return REPO_URL;
  }
}

// Derived paths (inside the cloned repo)
const GLOBAL_DIR = path.join(REPO_LOCAL, "global");
const PROJECTS_DIR = path.join(REPO_LOCAL, "projects");
const INBOX_DIR = path.join(REPO_LOCAL, "inbox");
const REJECTED_DIR = path.join(REPO_LOCAL, "rejected");
const REGISTRY_PATH = path.join(REPO_LOCAL, "registry.json");

// --- Git Operations ---

function git(args: string, opts?: { cwd?: string }): string {
  const cwd = opts?.cwd || REPO_LOCAL;
  return execSync(`git ${args}`, { cwd, stdio: "pipe", timeout: 30000 }).toString().trim();
}

function ensureRepo(): void {
  if (fs.existsSync(path.join(REPO_LOCAL, ".git"))) {
    return;
  }
  console.error(`Cloning ${REPO_URL} → ${REPO_LOCAL}`);
  fs.mkdirSync(path.dirname(REPO_LOCAL), { recursive: true });
  execSync(`git clone "${authedRepoUrl()}" "${REPO_LOCAL}"`, { stdio: "pipe", timeout: 60000 });
  git(`config user.name "${GIT_USER}"`);
  git(`config user.email "${GIT_EMAIL}"`);
}

function gitPull(): void {
  try {
    git("pull --ff-only origin main");
  } catch {
    // If main doesn't exist yet or no remote, that's fine
    try {
      git("pull --ff-only origin master");
    } catch {
      // Fresh repo with no remote commits — nothing to pull
    }
  }
}

function gitCommitAndPush(message: string): void {
  git("add -A");
  // Check if there's anything to commit
  try {
    git("diff --cached --quiet");
    return; // Nothing staged
  } catch {
    // There are staged changes — commit them
  }
  git(`commit -m "${message.replace(/"/g, '\\"')}"`);
  try {
    // Use authed URL for push to handle token auth
    git(`push "${authedRepoUrl()}" HEAD`);
  } catch (err: any) {
    console.error(`Warning: git push failed: ${err.message}`);
  }
}

// --- Helpers ---

interface SkillInfo {
  name: string;
  scope: "global" | "project";
  project?: string;
  description: string;
  path: string;
}

interface InboxSkillInfo {
  name: string;
  source: string;
  importedAt: string;
  path: string;
}

function readRegistry(): Record<string, any> {
  try {
    return JSON.parse(fs.readFileSync(REGISTRY_PATH, "utf-8"));
  } catch {
    return { version: "2.0", global: {}, projects: {}, inbox: {}, rejected: {} };
  }
}

function writeRegistry(registry: Record<string, any>): void {
  fs.writeFileSync(REGISTRY_PATH, JSON.stringify(registry, null, 2) + "\n");
}

function parseSkillFrontmatter(content: string): { name?: string; description?: string } {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) return {};
  const fm: Record<string, string> = {};
  for (const line of match[1].split("\n")) {
    const [key, ...rest] = line.split(":");
    if (key && rest.length) {
      fm[key.trim()] = rest.join(":").trim();
    }
  }
  return { name: fm.name, description: fm.description };
}

function discoverSkills(dir: string, scope: "global" | "project", project?: string): SkillInfo[] {
  const skills: SkillInfo[] = [];
  if (!fs.existsSync(dir)) return skills;

  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
    const skillDir = path.join(dir, entry.name);
    const skillFile = findSkillFile(skillDir);
    if (!skillFile) continue;

    const content = fs.readFileSync(skillFile, "utf-8");
    const fm = parseSkillFrontmatter(content);

    skills.push({
      name: fm.name || entry.name,
      scope,
      project,
      description: fm.description || "(no description)",
      path: skillDir,
    });
  }
  return skills;
}

function findSkillFile(dir: string): string | null {
  for (const name of ["SKILL.md", "skill.md", "Skill.md"]) {
    const p = path.join(dir, name);
    if (fs.existsSync(p)) return p;
  }
  return null;
}

function discoverInbox(): InboxSkillInfo[] {
  const items: InboxSkillInfo[] = [];
  if (!fs.existsSync(INBOX_DIR)) return items;
  const registry = readRegistry();

  for (const entry of fs.readdirSync(INBOX_DIR, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
    const inboxEntry = registry.inbox?.[entry.name] || {};
    items.push({
      name: entry.name,
      source: inboxEntry.source || "unknown",
      importedAt: inboxEntry.importedAt || "unknown",
      path: path.join(INBOX_DIR, entry.name),
    });
  }
  return items;
}

function analyzeSkillSafety(skillDir: string): Record<string, { level: string; details: string }> {
  const checks: Record<string, { level: string; details: string }> = {};
  const files = getAllFiles(skillDir);
  let allContent = "";

  for (const f of files) {
    allContent += fs.readFileSync(f, "utf-8") + "\n";
  }

  // Bash commands
  const bashMatches = allContent.match(/```bash[\s\S]*?```/g) || [];
  const hasCurl = /\bcurl\b|\bwget\b/.test(allContent);
  const hasEval = /\beval\b|\bexec\b|\bsource\b/.test(allContent);
  checks["bash_commands"] = bashMatches.length === 0
    ? { level: "🟢 LOW", details: "No shell commands found" }
    : hasEval
      ? { level: "🔴 HIGH", details: `${bashMatches.length} bash block(s) with eval/exec/source detected` }
      : { level: "🟡 MEDIUM", details: `${bashMatches.length} bash block(s) found` };

  // File writes
  const hasFileWrites = /\b(write|create|mkdir|rm |rm -rf|rmdir|unlink|> |>>)\b/i.test(allContent);
  const writesToSystem = /~\/\.claude\/|~\/\.config\/|\/etc\/|\/usr\//i.test(allContent);
  checks["file_writes"] = !hasFileWrites
    ? { level: "🟢 LOW", details: "No file write operations detected" }
    : writesToSystem
      ? { level: "🔴 HIGH", details: "Writes to system/config directories detected" }
      : { level: "🟡 MEDIUM", details: "File write operations present" };

  // Network calls
  const networkPatterns = allContent.match(/https?:\/\/[^\s"'`)]+/g) || [];
  checks["network_calls"] = !hasCurl && networkPatterns.length === 0
    ? { level: "🟢 LOW", details: "No network calls detected" }
    : { level: "🟡 MEDIUM", details: `${networkPatterns.length} URL(s) found. Curl/wget: ${hasCurl}` };

  // Env vars / secrets
  const envVars = allContent.match(/\$\{?\w*(KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL)\w*\}?/gi) || [];
  checks["env_vars_secrets"] = envVars.length === 0
    ? { level: "🟢 LOW", details: "No API keys or secrets referenced" }
    : { level: "🟡 MEDIUM", details: `References: ${[...new Set(envVars)].join(", ")}` };

  // MCP servers
  const hasMcp = /mcp|McpServer|mcp-config|npx .* mcp/i.test(allContent);
  checks["mcp_servers"] = !hasMcp
    ? { level: "🟢 LOW", details: "No MCP server references" }
    : { level: "🟡 MEDIUM", details: "References MCP servers or configuration" };

  // Scope creep
  const hasScopeCreep = /~\/\.claude\/(settings|\.mcp)|disable.*safety|skip.*confirm|--no-verify/i.test(allContent);
  const hasBase64 = /base64|atob|btoa/i.test(allContent);
  const hasPackageInstall = /npm install|pip install|cargo install|go install/i.test(allContent);
  checks["scope_creep"] = !hasScopeCreep && !hasBase64 && !hasPackageInstall
    ? { level: "🟢 LOW", details: "No scope creep patterns detected" }
    : { level: "🔴 HIGH", details: "Modifies Claude settings, uses obfuscation, or installs packages" };

  return checks;
}

function getAllFiles(dir: string): string[] {
  const results: string[] = [];
  if (!fs.existsSync(dir)) return results;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith(".")) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...getAllFiles(full));
    } else {
      results.push(full);
    }
  }
  return results;
}

function today(): string {
  return new Date().toISOString().split("T")[0];
}

// --- MCP Server ---

const server = new McpServer({
  name: "skills-depot",
  version: "1.0.0",
});

// Tool: list_skills
server.tool(
  "list_skills",
  "List available skills. Returns global skills (always) and project-specific skills (if a project is active). Also shows inbox items pending review.",
  {
    project: z.string().optional().describe("Project name (usually your working directory name, e.g. 'my-app')"),
    include_inbox: z.boolean().optional().describe("Include inbox items pending review (default: false)"),
  },
  async ({ project, include_inbox }) => {
    gitPull();

    const projectName = resolveProject(project);
    const globalSkills = discoverSkills(GLOBAL_DIR, "global");
    const projectSkills: SkillInfo[] = [];

    if (projectName) {
      const projectDir = path.join(PROJECTS_DIR, projectName);
      projectSkills.push(...discoverSkills(projectDir, "project", projectName));
    }

    let text = `# Skills Depot\n\n`;
    text += `**Repo:** ${REPO_URL}\n`;
    text += `**Active project:** ${projectName || "(none — global only)"}\n\n`;

    text += `## Global Skills (${globalSkills.length})\n\n`;
    if (globalSkills.length === 0) {
      text += "_No global skills installed._\n\n";
    } else {
      for (const s of globalSkills) {
        text += `- **${s.name}** — ${s.description}\n`;
      }
      text += "\n";
    }

    if (projectName) {
      text += `## Project Skills: ${projectName} (${projectSkills.length})\n\n`;
      if (projectSkills.length === 0) {
        text += "_No project-specific skills for this project._\n\n";
      } else {
        for (const s of projectSkills) {
          text += `- **${s.name}** — ${s.description}\n`;
        }
        text += "\n";
      }
    }

    if (include_inbox) {
      const inbox = discoverInbox();
      text += `## Inbox (${inbox.length} pending review)\n\n`;
      if (inbox.length === 0) {
        text += "_Inbox is empty._\n\n";
      } else {
        for (const item of inbox) {
          text += `- **${item.name}** — source: ${item.source} (imported: ${item.importedAt})\n`;
        }
        text += "\n";
      }
    }

    return { content: [{ type: "text", text }] };
  }
);

// Tool: get_skill
server.tool(
  "get_skill",
  "Read a skill's full SKILL.md content and list supporting files.",
  {
    name: z.string().describe("Skill name (directory name)"),
    scope: z.enum(["global", "project", "inbox"]).describe("Where to look for the skill"),
    project: z.string().optional().describe("Project name (usually your working directory name, e.g. 'my-app')"),
  },
  async ({ name, scope, project }) => {
    gitPull();

    let dir: string;
    if (scope === "global") {
      dir = path.join(GLOBAL_DIR, name);
    } else if (scope === "project") {
      const proj = resolveProject(project);
      if (!proj) {
        return { content: [{ type: "text", text: "Error: No project specified. Set SKILLS_PROJECT env var or pass project parameter." }] };
      }
      dir = path.join(PROJECTS_DIR, proj, name);
    } else {
      dir = path.join(INBOX_DIR, name);
    }

    if (!fs.existsSync(dir)) {
      return { content: [{ type: "text", text: `Skill "${name}" not found in ${scope}${project ? ` (${project})` : ""}.` }] };
    }

    const skillFile = findSkillFile(dir);
    let text = `# Skill: ${name} (${scope})\n\n`;

    if (skillFile) {
      text += fs.readFileSync(skillFile, "utf-8");
    } else {
      text += "_No SKILL.md found._\n";
    }

    const allFiles = getAllFiles(dir).map(f => path.relative(dir, f));
    if (allFiles.length > 1) {
      text += `\n\n## Supporting Files\n\n`;
      for (const f of allFiles) {
        if (!f.toLowerCase().includes("skill.md")) {
          text += `- ${f}\n`;
        }
      }
    }

    return { content: [{ type: "text", text }] };
  }
);

// Tool: import_skill
server.tool(
  "import_skill",
  "Import an external skill into the inbox for review. Fetches from a GitHub repo URL or local path. Does NOT install — skill must be reviewed and approved first.",
  {
    source: z.string().describe("GitHub repo URL (e.g., https://github.com/user/repo) or local file path"),
    name: z.string().optional().describe("Override the skill name (defaults to repo/directory name)"),
  },
  async ({ source, name }) => {
    gitPull();

    const skillName = name || source.split("/").filter(Boolean).pop()?.replace(/\.git$/, "") || "unknown-skill";
    const destDir = path.join(INBOX_DIR, skillName);

    if (fs.existsSync(destDir)) {
      return { content: [{ type: "text", text: `Skill "${skillName}" is already in the inbox. Review it with get_skill or approve/reject it.` }] };
    }

    // Check if already rejected
    if (fs.existsSync(path.join(REJECTED_DIR, skillName))) {
      return { content: [{ type: "text", text: `⚠️ Skill "${skillName}" was previously rejected. Check rejected/${skillName}/REJECTED.md for the reason. Remove it from rejected/ first if you want to re-import.` }] };
    }

    let text = "";

    if (source.startsWith("http://") || source.startsWith("https://")) {
      // GitHub clone into a temp dir, then copy (don't nest .git inside our repo)
      const tmpDir = path.join(REPO_LOCAL, ".tmp-import-" + Date.now());
      try {
        execSync(`git clone --depth 1 "${source}" "${tmpDir}"`, {
          stdio: "pipe",
          timeout: 30000,
        });
        // Remove .git from cloned repo
        const gitDir = path.join(tmpDir, ".git");
        if (fs.existsSync(gitDir)) {
          fs.rmSync(gitDir, { recursive: true, force: true });
        }
        // Move to inbox
        fs.mkdirSync(path.dirname(destDir), { recursive: true });
        fs.renameSync(tmpDir, destDir);
        text += `Cloned from ${source}\n\n`;
      } catch (err: any) {
        // Clean up
        if (fs.existsSync(tmpDir)) fs.rmSync(tmpDir, { recursive: true, force: true });
        if (fs.existsSync(destDir)) fs.rmSync(destDir, { recursive: true, force: true });
        return { content: [{ type: "text", text: `Failed to clone: ${err.message}` }] };
      }
    } else {
      // Local path copy
      if (!fs.existsSync(source)) {
        return { content: [{ type: "text", text: `Source path not found: ${source}` }] };
      }
      fs.mkdirSync(destDir, { recursive: true });
      execSync(`cp -r "${source}"/* "${destDir}/"`, { stdio: "pipe" });
      text += `Copied from ${source}\n\n`;
    }

    // Update registry
    const registry = readRegistry();
    registry.inbox = registry.inbox || {};
    registry.inbox[skillName] = {
      source,
      importedAt: today(),
      status: "pending-review",
    };
    writeRegistry(registry);

    // Commit import to git
    gitCommitAndPush(`import: add ${skillName} to inbox from ${source}`);

    // Run safety analysis
    const safety = analyzeSkillSafety(destDir);
    const hasHigh = Object.values(safety).some(c => c.level.includes("HIGH"));
    const hasMedium = Object.values(safety).some(c => c.level.includes("MEDIUM"));
    const overallRisk = hasHigh ? "🔴 HIGH" : hasMedium ? "🟡 MEDIUM" : "🟢 LOW";

    text += `## Imported: ${skillName}\n\n`;
    text += `**Overall Risk: ${overallRisk}**\n\n`;
    text += `| Check | Risk | Details |\n`;
    text += `|-------|------|---------|\n`;
    for (const [check, result] of Object.entries(safety)) {
      text += `| ${check.replace(/_/g, " ")} | ${result.level} | ${result.details} |\n`;
    }

    // Show SKILL.md preview
    const skillFile = findSkillFile(destDir);
    if (skillFile) {
      const content = fs.readFileSync(skillFile, "utf-8");
      text += `\n## SKILL.md Preview\n\n${content}\n`;
    }

    text += `\n---\n**⚠️ This skill is in the INBOX — not active.**\n`;
    text += `Use \`approve_skill\` to activate or \`reject_skill\` to decline.\n`;

    return { content: [{ type: "text", text }] };
  }
);

// Tool: approve_skill
server.tool(
  "approve_skill",
  "Approve an inbox skill and move it to global or a specific project scope. Requires explicit user confirmation.",
  {
    name: z.string().describe("Skill name to approve"),
    scope: z.enum(["global", "project"]).describe("Where to install: 'global' for all projects, 'project' for current project only"),
    project: z.string().optional().describe("Project name (usually your working directory name, e.g. 'my-app')"),
  },
  async ({ name, scope, project }) => {
    gitPull();

    const srcDir = path.join(INBOX_DIR, name);
    if (!fs.existsSync(srcDir)) {
      return { content: [{ type: "text", text: `Skill "${name}" not found in inbox.` }] };
    }

    let destDir: string;
    if (scope === "global") {
      destDir = path.join(GLOBAL_DIR, name);
    } else {
      const proj = resolveProject(project);
      if (!proj) {
        return { content: [{ type: "text", text: "Error: No project specified. Set SKILLS_PROJECT env var or pass project parameter." }] };
      }
      destDir = path.join(PROJECTS_DIR, proj, name);
    }

    // Move from inbox to destination
    fs.mkdirSync(path.dirname(destDir), { recursive: true });
    fs.renameSync(srcDir, destDir);

    // Update registry
    const registry = readRegistry();
    const inboxEntry = registry.inbox?.[name] || {};
    delete registry.inbox?.[name];

    if (scope === "global") {
      registry.global = registry.global || {};
      registry.global[name] = {
        ...inboxEntry,
        status: "approved",
        approvedAt: today(),
        scope: "global",
      };
    } else {
      const proj = resolveProject(project);
      registry.projects = registry.projects || {};
      registry.projects[proj] = registry.projects[proj] || {};
      registry.projects[proj][name] = {
        ...inboxEntry,
        status: "approved",
        approvedAt: today(),
        scope: "project",
        project: proj,
      };
    }
    writeRegistry(registry);

    const scopeLabel = scope === "global" ? "global" : `project: ${resolveProject(project)}`;
    gitCommitAndPush(`approve: ${name} → ${scopeLabel}`);

    return {
      content: [{
        type: "text",
        text: `✅ Skill "${name}" approved and moved to ${scopeLabel}.\n\nCommitted and pushed to ${REPO_URL}.`,
      }],
    };
  }
);

// Tool: reject_skill
server.tool(
  "reject_skill",
  "Reject an inbox skill with a reason. Moves to rejected/ for record-keeping.",
  {
    name: z.string().describe("Skill name to reject"),
    reason: z.string().describe("Why this skill was rejected"),
  },
  async ({ name, reason }) => {
    gitPull();

    const srcDir = path.join(INBOX_DIR, name);
    if (!fs.existsSync(srcDir)) {
      return { content: [{ type: "text", text: `Skill "${name}" not found in inbox.` }] };
    }

    const destDir = path.join(REJECTED_DIR, name);
    fs.mkdirSync(path.dirname(destDir), { recursive: true });
    fs.renameSync(srcDir, destDir);

    // Write rejection note
    fs.writeFileSync(
      path.join(destDir, "REJECTED.md"),
      `# Rejected: ${name}\n\n**Date:** ${today()}\n**Reason:** ${reason}\n`
    );

    // Update registry
    const registry = readRegistry();
    const inboxEntry = registry.inbox?.[name] || {};
    delete registry.inbox?.[name];
    registry.rejected = registry.rejected || {};
    registry.rejected[name] = {
      ...inboxEntry,
      status: "rejected",
      rejectedAt: today(),
      reason,
    };
    writeRegistry(registry);

    gitCommitAndPush(`reject: ${name} — ${reason}`);

    return {
      content: [{
        type: "text",
        text: `❌ Skill "${name}" rejected. Reason: ${reason}\n\nCommitted and pushed to ${REPO_URL}.`,
      }],
    };
  }
);

// Tool: search_skills
server.tool(
  "search_skills",
  "Search installed skills by keyword across names and descriptions.",
  {
    query: z.string().describe("Search term to match against skill names and descriptions"),
    project: z.string().optional().describe("Project name (usually your working directory name, e.g. 'my-app')"),
  },
  async ({ query, project }) => {
    gitPull();

    const projectName = resolveProject(project);
    const allSkills: SkillInfo[] = [
      ...discoverSkills(GLOBAL_DIR, "global"),
    ];

    if (projectName) {
      allSkills.push(...discoverSkills(path.join(PROJECTS_DIR, projectName), "project", projectName));
    }

    // Also search all projects if no specific project
    if (!projectName && fs.existsSync(PROJECTS_DIR)) {
      for (const entry of fs.readdirSync(PROJECTS_DIR, { withFileTypes: true })) {
        if (entry.isDirectory() && !entry.name.startsWith(".")) {
          allSkills.push(...discoverSkills(path.join(PROJECTS_DIR, entry.name), "project", entry.name));
        }
      }
    }

    const q = query.toLowerCase();
    const matches = allSkills.filter(
      s => s.name.toLowerCase().includes(q) || s.description.toLowerCase().includes(q)
    );

    let text = `## Search: "${query}" (${matches.length} result(s))\n\n`;
    if (matches.length === 0) {
      text += "_No matching skills found._\n";
    } else {
      for (const s of matches) {
        const scopeLabel = s.scope === "project" ? `project:${s.project}` : "global";
        text += `- **${s.name}** [${scopeLabel}] — ${s.description}\n`;
      }
    }

    return { content: [{ type: "text", text }] };
  }
);

// --- Auth Middleware ---

function verifyAuth(req: express.Request, res: express.Response): boolean {
  if (!AUTH_TOKEN) {
    res.status(500).json({ error: "Server misconfigured: no auth token set" });
    return false;
  }
  // Accept token from Authorization header or ?token= query param
  const authHeader = req.headers.authorization;
  const queryToken = req.query.token as string | undefined;
  const token = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : queryToken;

  if (!token) {
    res.status(401).json({ error: "Missing auth token (use Authorization header or ?token= query param)" });
    return false;
  }
  const valid = crypto.timingSafeEqual(
    Buffer.from(token),
    Buffer.from(AUTH_TOKEN)
  );
  if (!valid) {
    res.status(403).json({ error: "Invalid token" });
    return false;
  }
  return true;
}

// --- Start Server ---

async function main() {
  // Clone the skills repo on startup
  ensureRepo();
  gitPull();
  console.error(`Skills repo ready at ${REPO_LOCAL}`);

  if (TRANSPORT === "http") {
    const app = express();

    // Health check (no auth required)
    app.get("/health", (_req, res) => {
      res.json({ status: "ok", server: "skills-depot", version: "1.0.0" });
    });

    // Track active sessions
    const sessions = new Map<string, StreamableHTTPServerTransport>();

    // MCP endpoint
    app.all("/mcp", async (req, res) => {

      // Check for existing session
      const sessionId = req.headers["mcp-session-id"] as string | undefined;
      if (sessionId && sessions.has(sessionId)) {
        const transport = sessions.get(sessionId)!;
        await transport.handleRequest(req, res);
        return;
      }

      // New session (initialize request)
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => crypto.randomUUID(),
      });

      transport.onclose = () => {
        const sid = (transport as any).sessionId;
        if (sid) sessions.delete(sid);
      };

      await server.connect(transport);
      await transport.handleRequest(req, res);

      // Store session after first request sets the ID
      const sid = (transport as any).sessionId;
      if (sid) sessions.set(sid, transport);
    });

    app.listen(PORT, "0.0.0.0", () => {
      console.log(`skills-depot MCP server listening on http://0.0.0.0:${PORT}/mcp`);
    });
  } else {
    // stdio mode (local use)
    const transport = new StdioServerTransport();
    await server.connect(transport);
  }
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
