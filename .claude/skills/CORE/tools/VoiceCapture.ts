#!/usr/bin/env bun
/**
 * VoiceCapture.ts - Voice thought capture processing pipeline
 *
 * Finds new audio files in the capture folder, transcribes them locally
 * using faster-whisper, classifies with AI, and stores in an inbox for
 * review during PAI sessions.
 *
 * Usage:
 *   bun VoiceCapture.ts process              # Process new captures
 *   bun VoiceCapture.ts inbox                # Show current inbox
 *   bun VoiceCapture.ts inbox --json         # Show inbox as JSON
 *   bun VoiceCapture.ts clear [id]           # Mark item(s) as processed
 *   bun VoiceCapture.ts clear --all          # Clear entire inbox
 *
 * Configuration:
 *   Capture folder: G:/My Drive/VoiceCaptures/
 *   Processed folder: G:/My Drive/VoiceCaptures/processed/
 *   Inbox: ~/.claude/MEMORY/CAPTURES/inbox.jsonl
 */

import { spawn } from "child_process";
import { existsSync, readdirSync, readFileSync, writeFileSync, mkdirSync, renameSync, appendFileSync } from "fs";
import { join, basename, extname } from "path";
import { homedir } from "os";
import { parseArgs } from "util";
import { inference } from "./Inference";

// Configuration
const HOME = homedir();
const PAI_DIR = join(HOME, ".claude");
const CAPTURES_DIR = "G:/My Drive/VoiceCaptures";
const PROCESSED_DIR = join(CAPTURES_DIR, "processed");
const INBOX_DIR = join(PAI_DIR, "MEMORY", "CAPTURES");
const INBOX_FILE = join(INBOX_DIR, "inbox.jsonl");
const TRANSCRIPT_TOOL = join(PAI_DIR, "skills", "CORE", "Tools", "extract-transcript.py");

const AUDIO_EXTENSIONS = new Set([".m4a", ".mp3", ".wav", ".flac", ".ogg", ".aac", ".wma"]);

// Types
interface CaptureEntry {
  id: string;
  timestamp: string;
  transcription: string;
  classification: Classification;
  source_file: string;
  status: "new" | "processed" | "archived";
}

interface Classification {
  type: "todo" | "idea" | "lesson" | "observation" | "reminder" | "question" | "note";
  topic: "work" | "family" | "personal" | "learning" | "ttrpg" | "other";
  urgency: "now" | "soon" | "whenever";
}

const CLASSIFICATION_PROMPT = `Classify this voice note transcription. Return ONLY valid JSON:
{
  "type": "todo" | "idea" | "lesson" | "observation" | "reminder" | "question" | "note",
  "topic": "work" | "family" | "personal" | "learning" | "ttrpg" | "other",
  "urgency": "now" | "soon" | "whenever"
}

DEFINITIONS:
- type:
  - todo: Something to do/action item ("I need to...", "Don't forget to...")
  - idea: A creative thought or concept to explore later
  - lesson: Something learned or realized ("I noticed that...", "Turns out...")
  - observation: A factual observation about the world or a situation
  - reminder: Something time-sensitive to remember ("Remember for Friday...")
  - question: Something to research or ask about
  - note: General note that doesn't fit other categories

- topic:
  - work: Related to job, SaaS division, career, colleagues
  - family: Related to partner, children, home, family logistics
  - personal: Health, fitness, personal projects, self-care
  - learning: Related to studying, courses, intellectual interests
  - ttrpg: Tabletop RPG, game mastering, story ideas, session prep
  - other: Doesn't clearly fit any category

- urgency:
  - now: Needs attention today or is time-critical
  - soon: Within the next few days
  - whenever: No time pressure, can be addressed anytime

OUTPUT ONLY THE JSON. No explanation.`;

/**
 * Transcribe an audio file using extract-transcript.py
 */
async function transcribeFile(filepath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const env = { ...process.env };
    delete env.CLAUDE_CODE_GIT_BASH_PATH;

    const proc = spawn("uv", ["run", "--python", "3.13", TRANSCRIPT_TOOL, filepath], {
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";

    proc.stdout.on("data", (data: Buffer) => {
      stdout += data.toString();
    });

    proc.stderr.on("data", (data: Buffer) => {
      stderr += data.toString();
    });

    const timeoutId = setTimeout(() => {
      proc.kill("SIGTERM");
      reject(new Error("Transcription timed out after 5 minutes"));
    }, 300000); // 5 min timeout

    proc.on("close", (code: number | null) => {
      clearTimeout(timeoutId);
      if (code !== 0) {
        reject(new Error(`Transcription failed (exit ${code}): ${stderr}`));
      } else {
        resolve(stdout.trim());
      }
    });

    proc.on("error", (err: Error) => {
      clearTimeout(timeoutId);
      reject(new Error(`Failed to start transcription: ${err.message}`));
    });
  });
}

/**
 * Classify a transcription using AI (Haiku)
 */
async function classifyTranscription(text: string): Promise<Classification> {
  const result = await inference({
    systemPrompt: CLASSIFICATION_PROMPT,
    userPrompt: text,
    level: "fast",
    expectJson: true,
    timeout: 15000,
  });

  if (result.success && result.parsed) {
    const parsed = result.parsed as Classification;
    // Validate fields
    const validTypes = ["todo", "idea", "lesson", "observation", "reminder", "question", "note"];
    const validTopics = ["work", "family", "personal", "learning", "ttrpg", "other"];
    const validUrgency = ["now", "soon", "whenever"];

    return {
      type: validTypes.includes(parsed.type) ? parsed.type : "note",
      topic: validTopics.includes(parsed.topic) ? parsed.topic : "other",
      urgency: validUrgency.includes(parsed.urgency) ? parsed.urgency : "whenever",
    };
  }

  // Fallback classification
  return { type: "note", topic: "other", urgency: "whenever" };
}

/**
 * Generate a capture ID from filename
 */
function generateId(filename: string): string {
  const name = basename(filename, extname(filename));
  // Try to extract timestamp from filename like capture_20260124_143022
  const match = name.match(/(\d{8}_\d{6})/);
  if (match) {
    return `cap_${match[1]}`;
  }
  // Fallback: use current timestamp
  const now = new Date();
  const ts = now.toISOString().replace(/[-:T]/g, "").slice(0, 15);
  return `cap_${ts}`;
}

/**
 * Read current inbox entries
 */
function readInbox(): CaptureEntry[] {
  if (!existsSync(INBOX_FILE)) return [];

  const content = readFileSync(INBOX_FILE, "utf-8").trim();
  if (!content) return [];

  return content
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => {
      try {
        return JSON.parse(line) as CaptureEntry;
      } catch {
        return null;
      }
    })
    .filter((entry): entry is CaptureEntry => entry !== null);
}

/**
 * Write inbox (overwrite entire file)
 */
function writeInbox(entries: CaptureEntry[]): void {
  if (!existsSync(INBOX_DIR)) {
    mkdirSync(INBOX_DIR, { recursive: true });
  }
  const content = entries.map((e) => JSON.stringify(e)).join("\n") + (entries.length > 0 ? "\n" : "");
  writeFileSync(INBOX_FILE, content, "utf-8");
}

/**
 * Append a single entry to inbox
 */
function appendToInbox(entry: CaptureEntry): void {
  if (!existsSync(INBOX_DIR)) {
    mkdirSync(INBOX_DIR, { recursive: true });
  }
  appendFileSync(INBOX_FILE, JSON.stringify(entry) + "\n", "utf-8");
}

/**
 * Find new audio files (not yet processed)
 */
function findNewCaptures(): string[] {
  if (!existsSync(CAPTURES_DIR)) {
    console.error(`Capture folder not found: ${CAPTURES_DIR}`);
    return [];
  }

  const files = readdirSync(CAPTURES_DIR);
  return files
    .filter((f) => {
      const ext = extname(f).toLowerCase();
      return AUDIO_EXTENSIONS.has(ext);
    })
    .map((f) => join(CAPTURES_DIR, f));
}

/**
 * Process command — find, transcribe, classify, store
 */
async function processCaptures(): Promise<void> {
  const newFiles = findNewCaptures();

  if (newFiles.length === 0) {
    console.log("No new voice captures to process.");
    return;
  }

  console.log(`Found ${newFiles.length} new capture(s) to process.\n`);

  // Ensure processed directory exists
  if (!existsSync(PROCESSED_DIR)) {
    mkdirSync(PROCESSED_DIR, { recursive: true });
  }

  let successCount = 0;

  for (const filepath of newFiles) {
    const filename = basename(filepath);
    console.log(`Processing: ${filename}`);

    try {
      // Transcribe
      console.log("  Transcribing...");
      const transcription = await transcribeFile(filepath);

      if (!transcription || transcription.length < 3) {
        console.log("  Skipped: transcription too short or empty");
        continue;
      }

      console.log(`  Transcribed: "${transcription.slice(0, 80)}${transcription.length > 80 ? "..." : ""}"`);

      // Classify
      console.log("  Classifying...");
      const classification = await classifyTranscription(transcription);
      console.log(`  Classified: ${classification.type} / ${classification.topic} / ${classification.urgency}`);

      // Create entry
      const entry: CaptureEntry = {
        id: generateId(filename),
        timestamp: new Date().toISOString(),
        transcription,
        classification,
        source_file: filename,
        status: "new",
      };

      // Store
      appendToInbox(entry);

      // Move to processed
      const destPath = join(PROCESSED_DIR, filename);
      renameSync(filepath, destPath);
      console.log("  Stored and moved to processed.\n");

      successCount++;
    } catch (err) {
      console.error(`  Error processing ${filename}: ${err}`);
      continue;
    }
  }

  console.log(`\nDone! Processed ${successCount}/${newFiles.length} capture(s).`);

  // Show summary
  if (successCount > 0) {
    console.log("\n--- New captures summary ---");
    const inbox = readInbox();
    const newEntries = inbox.filter((e) => e.status === "new").slice(-successCount);
    for (const entry of newEntries) {
      const icon = getTypeIcon(entry.classification.type);
      console.log(`${icon} [${entry.classification.type}/${entry.classification.topic}] ${entry.transcription.slice(0, 60)}`);
    }
  }
}

/**
 * Inbox command — display current inbox
 */
function showInbox(asJson: boolean = false): void {
  const entries = readInbox();
  const newEntries = entries.filter((e) => e.status === "new");

  if (newEntries.length === 0) {
    console.log("Inbox is empty. No pending captures.");
    return;
  }

  if (asJson) {
    console.log(JSON.stringify(newEntries, null, 2));
    return;
  }

  console.log(`\n=== Voice Capture Inbox (${newEntries.length} items) ===\n`);

  // Group by type
  const grouped = new Map<string, CaptureEntry[]>();
  for (const entry of newEntries) {
    const key = entry.classification.type;
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key)!.push(entry);
  }

  for (const [type, items] of grouped) {
    const icon = getTypeIcon(type);
    console.log(`${icon} ${type.toUpperCase()} (${items.length})`);
    for (const item of items) {
      const urgencyFlag = item.classification.urgency === "now" ? " [!]" : item.classification.urgency === "soon" ? " [~]" : "";
      console.log(`  [${item.id}] ${item.transcription.slice(0, 70)}${urgencyFlag}`);
    }
    console.log("");
  }
}

/**
 * Clear command — mark items as processed
 */
function clearItems(id?: string, all?: boolean): void {
  const entries = readInbox();

  if (all) {
    const updated = entries.map((e) => ({ ...e, status: "processed" as const }));
    writeInbox(updated);
    console.log(`Cleared all ${entries.length} items.`);
    return;
  }

  if (id) {
    const updated = entries.map((e) => (e.id === id ? { ...e, status: "processed" as const } : e));
    writeInbox(updated);
    console.log(`Cleared item: ${id}`);
    return;
  }

  // Clear all "new" items
  const updated = entries.map((e) => (e.status === "new" ? { ...e, status: "processed" as const } : e));
  writeInbox(updated);
  const cleared = entries.filter((e) => e.status === "new").length;
  console.log(`Cleared ${cleared} new items.`);
}

function getTypeIcon(type: string): string {
  const icons: Record<string, string> = {
    todo: "[T]",
    idea: "[*]",
    lesson: "[L]",
    observation: "[O]",
    reminder: "[!]",
    question: "[?]",
    note: "[N]",
  };
  return icons[type] || "[-]";
}

// CLI
const { values, positionals } = parseArgs({
  args: Bun.argv.slice(2),
  options: {
    help: { type: "boolean", short: "h" },
    json: { type: "boolean" },
    all: { type: "boolean" },
  },
  allowPositionals: true,
});

if (values.help) {
  console.log(`VoiceCapture - Voice thought capture processing pipeline

Usage:
  bun VoiceCapture.ts process          Process new audio captures
  bun VoiceCapture.ts inbox            Show current inbox
  bun VoiceCapture.ts inbox --json     Show inbox as JSON
  bun VoiceCapture.ts clear [id]       Mark item as processed
  bun VoiceCapture.ts clear --all      Clear all items

Capture folder: ${CAPTURES_DIR}
Inbox: ${INBOX_FILE}
`);
  process.exit(0);
}

const [command, ...args] = positionals;

switch (command) {
  case "process":
    await processCaptures();
    break;

  case "inbox":
    showInbox(values.json);
    break;

  case "clear":
    clearItems(args[0], values.all);
    break;

  default:
    if (!command) {
      console.error("No command specified. Use: process, inbox, or clear");
    } else {
      console.error(`Unknown command: ${command}. Use: process, inbox, or clear`);
    }
    process.exit(1);
}
