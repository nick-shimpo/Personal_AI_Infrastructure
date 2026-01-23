#!/usr/bin/env bun
/**
 * ActivityParser - Parse session activity for PAI repo update documentation
 *
 * Commands:
 *   --today              Parse all today's activity
 *   --session <id>       Parse specific session only
 *   --generate           Generate MEMORY/PAISYSTEMUPDATES/ file (outputs path)
 *
 * Examples:
 *   bun run ActivityParser.ts --today
 *   bun run ActivityParser.ts --today --generate
 *   bun run ActivityParser.ts --session abc-123
 */

import { parseArgs } from "util";
import * as fs from "fs";
import * as path from "path";
import { homedir } from "os";

// ============================================================================
// Configuration
// ============================================================================

const CLAUDE_DIR = path.join(homedir(), ".claude");
const MEMORY_DIR = path.join(CLAUDE_DIR, "MEMORY");
const PROJECTS_BASE = path.join(CLAUDE_DIR, "projects");
const SYSTEM_UPDATES_DIR = path.join(MEMORY_DIR, "PAISYSTEMUPDATES");

/**
 * Get all project directories (Claude Code creates one per working directory)
 */
function getAllProjectDirs(): string[] {
  if (!fs.existsSync(PROJECTS_BASE)) return [];
  return fs.readdirSync(PROJECTS_BASE)
    .filter(d => fs.statSync(path.join(PROJECTS_BASE, d)).isDirectory())
    .map(d => path.join(PROJECTS_BASE, d));
}

// ============================================================================
// Types
// ============================================================================

interface FileChange {
  file: string;
  action: "created" | "modified";
  relativePath: string;
}

interface ParsedActivity {
  date: string;
  session_id: string | null;
  categories: {
    skills: FileChange[];
    workflows: FileChange[];
    tools: FileChange[];
    hooks: FileChange[];
    architecture: FileChange[];
    documentation: FileChange[];
    other: FileChange[];
  };
  summary: string;
  files_modified: string[];
  files_created: string[];
  skills_affected: string[];
}

// ============================================================================
// Category Detection
// ============================================================================

// Use platform-agnostic path separators in patterns
const sepPattern = process.platform === 'win32' ? '[\\\\/]' : '/';

const PATTERNS = {
  skip: [
    new RegExp(`MEMORY${sepPattern}PAISYSTEMUPDATES${sepPattern}`),
    new RegExp(`MEMORY${sepPattern}`),
    new RegExp(`WORK${sepPattern}.*${sepPattern}scratch${sepPattern}`),
    /\.quote-cache$/,
    /history\.jsonl$/,
    new RegExp(`cache${sepPattern}`),
    new RegExp(`plans${sepPattern}`, 'i'),
  ],

  skills: new RegExp(`skills${sepPattern}[^${sepPattern === '/' ? '/' : '\\\\/'}]+${sepPattern}(SKILL\\.md|Workflows${sepPattern}|Tools${sepPattern}|Data${sepPattern})`),
  workflows: new RegExp(`Workflows${sepPattern}.*\\.md$`),
  tools: new RegExp(`skills${sepPattern}[^${sepPattern === '/' ? '/' : '\\\\/'}]+${sepPattern}Tools${sepPattern}.*\\.ts$`),
  hooks: new RegExp(`hooks${sepPattern}.*\\.ts$`),
  architecture: /(ARCHITECTURE|PAISYSTEMARCHITECTURE|SKILLSYSTEM)\.md$/i,
  documentation: /\.(md|txt)$/,
};

function shouldSkip(filePath: string): boolean {
  const normalized = filePath.replace(/\\/g, '/');
  return PATTERNS.skip.some(pattern => pattern.test(normalized));
}

function categorizeFile(filePath: string): keyof ParsedActivity["categories"] | null {
  const normalized = filePath.replace(/\\/g, '/');
  if (shouldSkip(normalized)) return null;
  if (!normalized.includes("/.claude/") && !normalized.includes("\\.claude\\")) return null;

  if (PATTERNS.skills.test(normalized)) return "skills";
  if (PATTERNS.workflows.test(normalized)) return "workflows";
  if (PATTERNS.tools.test(normalized)) return "tools";
  if (PATTERNS.hooks.test(normalized)) return "hooks";
  if (PATTERNS.architecture.test(normalized)) return "architecture";
  if (PATTERNS.documentation.test(normalized)) return "documentation";

  return "other";
}

function extractSkillName(filePath: string): string | null {
  const normalized = filePath.replace(/\\/g, '/');
  const match = normalized.match(/skills\/([^/]+)\//);
  return match ? match[1] : null;
}

function getRelativePath(filePath: string): string {
  const normalized = filePath.replace(/\\/g, '/');
  const claudeIndex = normalized.indexOf("/.claude/");
  if (claudeIndex === -1) return filePath;
  return normalized.substring(claudeIndex + 9);
}

// ============================================================================
// Event Parsing
// ============================================================================

interface ProjectsEntry {
  sessionId?: string;
  type?: "user" | "assistant" | "summary";
  message?: {
    role?: string;
    content?: Array<{
      type: string;
      name?: string;
      input?: {
        file_path?: string;
        command?: string;
      };
    }>;
  };
  timestamp?: string;
}

function getTodaySessionFiles(): string[] {
  const allDirs = getAllProjectDirs();
  const allFiles: { path: string; mtime: number }[] = [];

  for (const dir of allDirs) {
    allFiles.push(...getSessionFilesFromDir(dir).map(f => ({
      path: f,
      mtime: fs.statSync(f).mtime.getTime()
    })));
  }

  // Return sorted by most recent, already filtered to last 24h by getSessionFilesFromDir
  return allFiles.sort((a, b) => b.mtime - a.mtime).map(f => f.path);
}

function getSessionFilesFromDir(dir: string): string[] {
  const now = Date.now();
  const oneDayAgo = now - 24 * 60 * 60 * 1000;

  const files = fs.readdirSync(dir)
    .filter(f => f.endsWith('.jsonl'))
    .map(f => ({
      name: f,
      path: path.join(dir, f),
      mtime: fs.statSync(path.join(dir, f)).mtime.getTime()
    }))
    .filter(f => f.mtime > oneDayAgo)
    .sort((a, b) => b.mtime - a.mtime);

  return files.map(f => f.path);
}

async function parseEvents(sessionFilter?: string): Promise<ParsedActivity> {
  const today = new Date();
  const dateStr = today.toISOString().split("T")[0];

  const sessionFiles = getTodaySessionFiles();

  if (sessionFiles.length === 0) {
    console.error(`No session files found for today in: ${PROJECTS_BASE}`);
    return emptyActivity(dateStr, sessionFilter || null);
  }

  const entries: ProjectsEntry[] = [];

  for (const sessionFile of sessionFiles) {
    if (sessionFilter && !sessionFile.includes(sessionFilter)) {
      continue;
    }

    const content = fs.readFileSync(sessionFile, "utf-8");
    const lines = content.split("\n").filter(line => line.trim());

    for (const line of lines) {
      try {
        const entry = JSON.parse(line) as ProjectsEntry;
        entries.push(entry);
      } catch {
        // Skip malformed lines
      }
    }
  }

  const filesModified = new Set<string>();
  const filesCreated = new Set<string>();

  for (const entry of entries) {
    if (entry.type !== "assistant" || !entry.message?.content) continue;

    for (const contentItem of entry.message.content) {
      if (contentItem.type !== "tool_use") continue;

      if (contentItem.name === "Write" && contentItem.input?.file_path) {
        const filePath = contentItem.input.file_path;
        if (filePath.includes("/.claude/") || filePath.includes("\\.claude\\")) {
          filesCreated.add(filePath);
        }
      }

      if (contentItem.name === "Edit" && contentItem.input?.file_path) {
        const filePath = contentItem.input.file_path;
        if (filePath.includes("/.claude/") || filePath.includes("\\.claude\\")) {
          filesModified.add(filePath);
        }
      }
    }
  }

  for (const file of filesCreated) {
    filesModified.delete(file);
  }

  const categories: ParsedActivity["categories"] = {
    skills: [],
    workflows: [],
    tools: [],
    hooks: [],
    architecture: [],
    documentation: [],
    other: [],
  };

  const skillsAffected = new Set<string>();

  const processFile = (file: string, action: "created" | "modified") => {
    const category = categorizeFile(file);
    if (!category) return;

    const change: FileChange = {
      file,
      action,
      relativePath: getRelativePath(file),
    };

    categories[category].push(change);

    const skill = extractSkillName(file);
    if (skill) skillsAffected.add(skill);
  };

  for (const file of filesCreated) processFile(file, "created");
  for (const file of filesModified) processFile(file, "modified");

  const summaryParts: string[] = [];
  if (skillsAffected.size > 0) {
    summaryParts.push(`${skillsAffected.size} skill(s) affected`);
  }
  if (categories.tools.length > 0) {
    summaryParts.push(`${categories.tools.length} tool(s)`);
  }
  if (categories.hooks.length > 0) {
    summaryParts.push(`${categories.hooks.length} hook(s)`);
  }
  if (categories.workflows.length > 0) {
    summaryParts.push(`${categories.workflows.length} workflow(s)`);
  }
  if (categories.architecture.length > 0) {
    summaryParts.push("architecture changes");
  }

  return {
    date: dateStr,
    session_id: sessionFilter || null,
    categories,
    summary: summaryParts.join(", ") || "documentation updates",
    files_modified: [...filesModified],
    files_created: [...filesCreated],
    skills_affected: [...skillsAffected],
  };
}

function emptyActivity(date: string, sessionId: string | null): ParsedActivity {
  return {
    date,
    session_id: sessionId,
    categories: {
      skills: [],
      workflows: [],
      tools: [],
      hooks: [],
      architecture: [],
      documentation: [],
      other: [],
    },
    summary: "no changes detected",
    files_modified: [],
    files_created: [],
    skills_affected: [],
  };
}

// ============================================================================
// Update File Generation
// ============================================================================

type SignificanceLabel = 'trivial' | 'minor' | 'moderate' | 'major' | 'critical';
type ChangeType = 'skill_update' | 'structure_change' | 'doc_update' | 'hook_update' | 'workflow_update' | 'config_update' | 'tool_update' | 'multi_area';

function determineChangeType(activity: ParsedActivity): ChangeType {
  const { categories } = activity;
  const totalCategories = Object.entries(categories)
    .filter(([key, items]) => key !== 'other' && items.length > 0)
    .length;

  if (totalCategories >= 3) return 'multi_area';
  if (categories.hooks.length > 0) return 'hook_update';
  if (categories.tools.length > 0) return 'tool_update';
  if (categories.workflows.length > 0) return 'workflow_update';
  if (categories.architecture.length > 0) return 'structure_change';
  if (categories.skills.length > 0) return 'skill_update';
  if (categories.documentation.length > 0) return 'doc_update';

  return 'doc_update';
}

function determineSignificance(activity: ParsedActivity): SignificanceLabel {
  const { categories, files_created, files_modified } = activity;
  const totalFiles = files_created.length + files_modified.length;
  const hasArchitecture = categories.architecture.length > 0;
  const hasNewSkill = categories.skills.some(c => c.action === 'created' && c.file.endsWith('SKILL.md'));
  const hasNewTool = categories.tools.some(c => c.action === 'created');
  const hasNewWorkflow = categories.workflows.some(c => c.action === 'created');

  if (hasArchitecture && totalFiles >= 10) return 'critical';
  if (hasNewSkill) return 'major';
  if (hasArchitecture) return 'major';
  if ((hasNewTool || hasNewWorkflow) && totalFiles >= 5) return 'major';
  if (hasNewTool || hasNewWorkflow) return 'moderate';
  if (totalFiles >= 5) return 'moderate';
  if (categories.hooks.length > 0) return 'moderate';
  if (totalFiles >= 2) return 'minor';

  return 'trivial';
}

function generateTitle(activity: ParsedActivity): string {
  const { categories, skills_affected } = activity;

  const extractName = (filePath: string): string => {
    const base = path.basename(filePath, path.extname(filePath));
    return base.replace(/[-_]/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
  };

  const plural = (count: number, word: string): string =>
    count === 1 ? word : `${word}s`;

  if (categories.tools.some((c) => c.action === "created")) {
    const newTool = categories.tools.find((c) => c.action === "created");
    const name = extractName(newTool!.file);
    if (skills_affected.length === 1) {
      return `Added ${name} Tool to ${skills_affected[0]} Skill`;
    }
    return `Created ${name} Tool for System`;
  }

  if (categories.workflows.some((c) => c.action === "created")) {
    const newWorkflow = categories.workflows.find((c) => c.action === "created");
    const name = extractName(newWorkflow!.file);
    if (skills_affected.length === 1) {
      return `Added ${name} Workflow to ${skills_affected[0]}`;
    }
    return `Created ${name} Workflow`;
  }

  if (categories.hooks.length > 0) {
    const hookNames = categories.hooks
      .map(h => extractName(h.file))
      .slice(0, 2);
    if (hookNames.length === 1) {
      return `Updated ${hookNames[0]} Hook Handler`;
    }
    return `Updated ${hookNames[0]} and ${hookNames.length - 1} Other ${plural(hookNames.length - 1, 'Hook')}`;
  }

  if (skills_affected.length === 1) {
    const skill = skills_affected[0];
    const hasWorkflowMod = categories.workflows.length > 0;
    const hasToolMod = categories.tools.length > 0;

    if (hasWorkflowMod && hasToolMod) return `Enhanced ${skill} Workflows and Tools`;
    if (hasWorkflowMod) return `Updated ${skill} Workflow Configuration`;
    if (hasToolMod) return `Modified ${skill} Tool Implementation`;
    return `Updated ${skill} Skill Files`;
  }

  if (skills_affected.length > 1) {
    const topTwo = skills_affected.slice(0, 2);
    if (skills_affected.length === 2) return `Updated ${topTwo[0]} and ${topTwo[1]} Skills`;
    return `Updated ${topTwo[0]} and ${skills_affected.length - 1} Other Skills`;
  }

  if (categories.architecture.length > 0) {
    const archFile = extractName(categories.architecture[0].file);
    return `Modified ${archFile} Architecture Document`;
  }

  if (categories.documentation.length > 0) {
    const docCount = categories.documentation.length;
    if (docCount === 1) return `Updated ${extractName(categories.documentation[0].file)} Documentation`;
    return `Updated ${docCount} Documentation ${plural(docCount, 'File')}`;
  }

  return `System Updates for ${activity.date}`;
}

function toKebabCase(str: string): string {
  return str.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

function generateUpdateFile(activity: ParsedActivity): string {
  const title = generateTitle(activity);
  const significance = determineSignificance(activity);
  const changeType = determineChangeType(activity);
  const timestamp = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
  const id = `${activity.date}-${toKebabCase(title)}`;

  const allFiles = [
    ...activity.files_created,
    ...activity.files_modified,
  ].filter(f => !shouldSkip(f)).map(f => getRelativePath(f));

  let content = `---
id: "${id}"
timestamp: "${timestamp}"
title: "${title}"
significance: "${significance}"
change_type: "${changeType}"
files_affected:
${allFiles.slice(0, 20).map(f => `  - "${f}"`).join('\n')}
---

# ${title}

**Timestamp:** ${timestamp}
**Significance:** ${significance}
**Change Type:** ${changeType}

## Summary

${activity.summary}.

## Changes Made

`;

  const categoryNames: Record<keyof ParsedActivity["categories"], string> = {
    skills: "Skills",
    workflows: "Workflows",
    tools: "Tools",
    hooks: "Hooks",
    architecture: "Architecture",
    documentation: "Documentation",
    other: "Other",
  };

  for (const [key, displayName] of Object.entries(categoryNames)) {
    const items = activity.categories[key as keyof ParsedActivity["categories"]];
    if (items.length > 0) {
      content += `### ${displayName}\n`;
      for (const item of items) {
        content += `- \`${item.relativePath}\` - ${item.action}\n`;
      }
      content += "\n";
    }
  }

  content += `---\n\n**Status:** Auto-generated\n`;
  return content;
}

async function writeUpdateFile(activity: ParsedActivity): Promise<string> {
  const title = generateTitle(activity);
  const slug = toKebabCase(title);
  const [year, month] = activity.date.split("-");
  const filename = `${activity.date}_${slug}.md`;

  const yearMonthDir = path.join(SYSTEM_UPDATES_DIR, year, month);
  const filepath = path.join(yearMonthDir, filename);

  if (!fs.existsSync(yearMonthDir)) {
    fs.mkdirSync(yearMonthDir, { recursive: true });
  }

  const content = generateUpdateFile(activity);
  fs.writeFileSync(filepath, content);

  return filepath;
}

// ============================================================================
// CLI
// ============================================================================

const { values } = parseArgs({
  args: Bun.argv.slice(2),
  options: {
    session: { type: "string" },
    today: { type: "boolean" },
    generate: { type: "boolean" },
    help: { type: "boolean", short: "h" },
  },
});

if (values.help) {
  console.log(`
ActivityParser - Parse session activity for PAI repo updates

Usage:
  bun run ActivityParser.ts --today              Parse all today's activity
  bun run ActivityParser.ts --today --generate   Parse and generate update file
  bun run ActivityParser.ts --session <id>       Parse specific session

Output: JSON with categorized changes (or filepath if --generate)
`);
  process.exit(0);
}

const activity = await parseEvents(values.session);

if (values.generate) {
  const filepath = await writeUpdateFile(activity);
  console.log(JSON.stringify({ filepath, activity }, null, 2));
} else {
  console.log(JSON.stringify(activity, null, 2));
}
