/**
 * Shared streaming utility for all Claude agent scripts.
 *
 * Combines the streaming loop, stdout output, and token-usage logging into one
 * reusable function so agents don't each repeat the same ~12 lines of boilerplate.
 *
 * Usage:
 *   import { streamToStdout } from './lib/streamUtils.js';
 *   const stream = await client.messages.stream({ ... });
 *   const fullText = await streamToStdout(stream);            // top-level
 *   const fullText = await streamToStdout(stream, '  ');      // indented (inside --all loops)
 */

import Anthropic from '@anthropic-ai/sdk';
import fs from 'fs';
import path from 'path';

// Re-use the return type that the SDK exposes from client.messages.stream()
type MessageStream = ReturnType<InstanceType<typeof Anthropic>['messages']['stream']>;

/**
 * Streams a Claude response to stdout and logs token usage to stderr.
 *
 * @param stream  The MessageStream returned by `client.messages.stream()`
 * @param indent  Optional prefix for the token-usage line (default: none)
 * @param meta    Optional key/value metadata merged into the .token-usage.ndjson entry
 *                (e.g. { mode: 'failure-window', new_po: true }). Use this to record
 *                which local reduction path was taken so telemetry is actionable.
 * @returns       The full streamed text (concatenation of all text_delta chunks)
 */
export async function streamToStdout(
  stream: MessageStream,
  indent = '',
  meta: Record<string, string | number | boolean> = {},
): Promise<string> {
  let fullText = '';

  for await (const event of stream) {
    if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
      process.stdout.write(event.delta.text);
      fullText += event.delta.text;
    }
  }

  // Blank line after streamed output so the token log doesn't run on immediately
  process.stdout.write('\n\n');

  const finalMsg = await stream.finalMessage();
  const { usage } = finalMsg;
  const cacheNote = [
    usage.cache_read_input_tokens ? `${usage.cache_read_input_tokens} cache-read` : '',
    usage.cache_creation_input_tokens ? `${usage.cache_creation_input_tokens} cache-write` : '',
  ].filter(Boolean);

  process.stderr.write(
    `${indent}Tokens — in: ${usage.input_tokens}, out: ${usage.output_tokens}` +
      (cacheNote.length ? ` (${cacheNote.join(', ')})` : '') +
      '\n',
  );

  // Append per-run telemetry to .token-usage.ndjson for tracking worst offenders.
  // Best-effort — never fail an agent run for a logging write.
  try {
    const logEntry =
      JSON.stringify({
        ts: new Date().toISOString(),
        agent: path.basename(process.argv[1] ?? 'unknown', '.ts'),
        model: finalMsg.model,
        in: usage.input_tokens,
        out: usage.output_tokens,
        cache_read: usage.cache_read_input_tokens ?? 0,
        cache_write: usage.cache_creation_input_tokens ?? 0,
        // Caller-supplied metadata: mode (e.g. 'failure-window'), local reduction flags, etc.
        ...meta,
      }) + '\n';
    fs.appendFileSync(path.join(process.cwd(), '.token-usage.ndjson'), logEntry);
  } catch {
    // Ignore — telemetry is advisory only
  }

  return fullText;
}
