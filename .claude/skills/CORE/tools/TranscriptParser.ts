/**
 * TranscriptParser.ts - Parse Claude Code JSONL transcripts
 *
 * Reads a Claude Code session transcript (JSONL format) and extracts:
 * - The last assistant message text
 * - Voice completion line (🗣️ prefix)
 * - Structured response fields (summary, analysis, actions, etc.)
 * - Response state (completed, error, awaitingInput)
 * - Plain completion summary for tabs/notifications
 */

import { readFileSync } from 'fs';

export type ResponseState = 'completed' | 'error' | 'awaitingInput';

export interface StructuredResponse {
  summary?: string;
  analysis?: string;
  actions?: string;
  results?: string;
  status?: string;
  next?: string;
  completed?: string;
  date?: string;
}

export interface ParsedTranscript {
  plainCompletion: string;
  voiceCompletion: string;
  responseState: ResponseState;
  lastMessage: string;
  structured: StructuredResponse;
}

/**
 * Extract the text content from the last assistant message in the transcript.
 */
function extractLastAssistantMessage(lines: string[]): string {
  let lastAssistantText = '';

  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (!line) continue;

    try {
      const entry = JSON.parse(line);

      // Claude Code transcript format: look for assistant role messages
      if (entry.type === 'assistant' || entry.role === 'assistant') {
        if (typeof entry.content === 'string') {
          lastAssistantText = entry.content;
          break;
        }
        if (Array.isArray(entry.content)) {
          // Extract text blocks from content array
          const textParts: string[] = [];
          for (const block of entry.content) {
            if (block.type === 'text' && typeof block.text === 'string') {
              textParts.push(block.text);
            }
          }
          if (textParts.length > 0) {
            lastAssistantText = textParts.join('\n');
            break;
          }
        }
      }

      // Alternative format: message wrapper
      if (entry.message?.role === 'assistant') {
        const content = entry.message.content;
        if (typeof content === 'string') {
          lastAssistantText = content;
          break;
        }
        if (Array.isArray(content)) {
          const textParts: string[] = [];
          for (const block of content) {
            if (block.type === 'text' && typeof block.text === 'string') {
              textParts.push(block.text);
            }
          }
          if (textParts.length > 0) {
            lastAssistantText = textParts.join('\n');
            break;
          }
        }
      }
    } catch {
      // Skip malformed lines
    }
  }

  return lastAssistantText;
}

/**
 * Extract the voice line from the message (line prefixed with 🗣️).
 */
function extractVoiceCompletion(text: string): string {
  const lines = text.split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith('🗣️')) {
      return trimmed.replace(/^🗣️\s*/, '').trim();
    }
  }
  // Fallback: first meaningful line, truncated
  const firstLine = lines.find(l => l.trim().length > 5)?.trim() || '';
  return firstLine.slice(0, 200);
}

/**
 * Extract structured response fields from formatted sections.
 */
function extractStructured(text: string): StructuredResponse {
  const structured: StructuredResponse = {};

  // Match patterns like "📝 SUMMARY: ...", "✅ COMPLETED: ...", etc.
  const patterns: Array<{ key: keyof StructuredResponse; regex: RegExp }> = [
    { key: 'summary', regex: /(?:📝\s*SUMMARY|## Summary)[:\s]*([^\n]+(?:\n(?!(?:🔍|⚡|📈|📊|🔄|✅|##)\s)[^\n]+)*)/i },
    { key: 'analysis', regex: /(?:🔍\s*ANALYSIS|## Analysis)[:\s]*([^\n]+(?:\n(?!(?:📝|⚡|📈|📊|🔄|✅|##)\s)[^\n]+)*)/i },
    { key: 'actions', regex: /(?:⚡\s*ACTIONS|## Actions)[:\s]*([^\n]+(?:\n(?!(?:📝|🔍|📈|📊|🔄|✅|##)\s)[^\n]+)*)/i },
    { key: 'results', regex: /(?:📈\s*RESULTS|## Results)[:\s]*([^\n]+(?:\n(?!(?:📝|🔍|⚡|📊|🔄|✅|##)\s)[^\n]+)*)/i },
    { key: 'status', regex: /(?:📊\s*STATUS|## Status)[:\s]*([^\n]+(?:\n(?!(?:📝|🔍|⚡|📈|🔄|✅|##)\s)[^\n]+)*)/i },
    { key: 'next', regex: /(?:🔄\s*NEXT|## Next)[:\s]*([^\n]+(?:\n(?!(?:📝|🔍|⚡|📈|📊|✅|##)\s)[^\n]+)*)/i },
    { key: 'completed', regex: /(?:✅\s*COMPLETED|## Completed)[:\s]*([^\n]+)/i },
    { key: 'date', regex: /(?:📅\s*DATE|## Date)[:\s]*([^\n]+)/i },
  ];

  for (const { key, regex } of patterns) {
    const match = text.match(regex);
    if (match?.[1]) {
      structured[key] = match[1].trim();
    }
  }

  // If no explicit completed field, try to infer from the first line
  if (!structured.completed && !structured.summary) {
    const firstLine = text.split('\n').find(l => l.trim().length > 5)?.trim();
    if (firstLine && firstLine.length < 200) {
      structured.summary = firstLine;
    }
  }

  return structured;
}

/**
 * Determine the response state from the message content.
 */
function determineResponseState(text: string): ResponseState {
  // Check for error indicators
  const errorPatterns = /(?:❌|error|failed|exception|crash|fatal)\s/i;
  const statusError = /📊\s*STATUS[:\s]*.*(?:error|failed|broken|crashed)/i;
  if (statusError.test(text) || (errorPatterns.test(text) && /(?:could not|unable to|cannot)/i.test(text))) {
    return 'error';
  }

  // Check for awaiting input indicators
  const inputPatterns = /(?:\?\s*$|what would you like|please (?:provide|specify|choose|select)|which (?:option|approach)|do you want)/im;
  if (inputPatterns.test(text)) {
    return 'awaitingInput';
  }

  return 'completed';
}

/**
 * Generate a plain completion string for tabs/notifications.
 */
function generatePlainCompletion(text: string, structured: StructuredResponse): string {
  // Prefer structured completed/summary
  if (structured.completed) {
    return structured.completed.slice(0, 100);
  }
  if (structured.summary) {
    return structured.summary.slice(0, 100);
  }

  // Fallback: first meaningful line
  const lines = text.split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    // Skip emoji-prefixed section headers and empty lines
    if (trimmed.length > 5 && !trimmed.match(/^[📝🔍⚡📈📊🔄✅📅🗣️#]/)) {
      return trimmed.slice(0, 100);
    }
  }

  return text.slice(0, 100).replace(/\n/g, ' ').trim();
}

/**
 * Parse a Claude Code JSONL transcript file and extract key information.
 */
export function parseTranscript(transcriptPath: string): ParsedTranscript {
  let lines: string[] = [];

  try {
    const content = readFileSync(transcriptPath, 'utf-8');
    lines = content.split('\n').filter(l => l.trim());
  } catch (error) {
    console.error(`[TranscriptParser] Failed to read transcript: ${error}`);
    return {
      plainCompletion: 'Task completed',
      voiceCompletion: 'Done.',
      responseState: 'completed',
      lastMessage: '',
      structured: {},
    };
  }

  const lastMessage = extractLastAssistantMessage(lines);

  if (!lastMessage) {
    return {
      plainCompletion: 'Task completed',
      voiceCompletion: 'Done.',
      responseState: 'completed',
      lastMessage: '',
      structured: {},
    };
  }

  const voiceCompletion = extractVoiceCompletion(lastMessage);
  const structured = extractStructured(lastMessage);
  const responseState = determineResponseState(lastMessage);
  const plainCompletion = generatePlainCompletion(lastMessage, structured);

  return {
    plainCompletion,
    voiceCompletion,
    responseState,
    lastMessage,
    structured,
  };
}
