/**
 * Robust stdin reader for Claude Code hooks (Windows-compatible)
 *
 * Claude Code pipes JSON to hook stdin. On Windows with Bun, the Node.js
 * event-based approach (process.stdin.on('data'/'end')) can fail to fire,
 * causing timeouts. This module uses multiple strategies for reliability.
 *
 * Usage:
 *   import { readStdin } from './lib/stdin';
 *   const input = await readStdin();
 *   const data = JSON.parse(input);
 */

export interface HookInput {
  session_id: string;
  prompt?: string;
  user_prompt?: string;  // Legacy field name
  transcript_path?: string;
  hook_event_name?: string;
}

/**
 * Read all stdin with timeout, using platform-appropriate strategy.
 * Returns the raw string content from stdin.
 * Throws on timeout or read error.
 */
export async function readStdin(timeout: number = 5000): Promise<string> {
  const result = await Promise.race([
    attemptRead(),
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error('Stdin timeout')), timeout)
    )
  ]);
  return result;
}

/**
 * Read and parse stdin as HookInput JSON.
 * Returns parsed object with normalized field names.
 */
export async function readHookInput(timeout: number = 5000): Promise<HookInput> {
  const raw = await readStdin(timeout);
  const data = JSON.parse(raw) as HookInput;
  // Normalize legacy field name
  if (!data.prompt && data.user_prompt) {
    data.prompt = data.user_prompt;
  }
  return data;
}

/**
 * Attempt to read stdin using the best available method.
 * Tries Bun.stdin first (native, most reliable on Windows),
 * falls back to process.stdin events.
 */
async function attemptRead(): Promise<string> {
  // Strategy 1: Bun-native stdin (preferred - handles Windows pipes correctly)
  if (typeof Bun !== 'undefined' && Bun.stdin) {
    try {
      const text = await Bun.stdin.text();
      if (text && text.trim()) return text;
    } catch {
      // Fall through to Node.js approach
    }
  }

  // Strategy 2: Node.js event-based with explicit resume
  return new Promise<string>((resolve, reject) => {
    let data = '';
    process.stdin.setEncoding('utf-8');
    process.stdin.resume(); // Critical: ensure stdin is in flowing mode

    process.stdin.on('data', (chunk: string) => {
      data += chunk;
      // Eagerly resolve if we received valid JSON (don't wait for EOF)
      try {
        JSON.parse(data);
        resolve(data);
      } catch {
        // Incomplete data, keep reading
      }
    });

    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', (err: Error) => reject(err));
  });
}
