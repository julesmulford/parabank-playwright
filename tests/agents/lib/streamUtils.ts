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

// Re-use the return type that the SDK exposes from client.messages.stream()
type MessageStream = ReturnType<InstanceType<typeof Anthropic>['messages']['stream']>;

/**
 * Streams a Claude response to stdout and logs token usage to stderr.
 *
 * @param stream  The MessageStream returned by `client.messages.stream()`
 * @param indent  Optional prefix for the token-usage line (default: none)
 * @returns       The full streamed text (concatenation of all text_delta chunks)
 */
export async function streamToStdout(stream: MessageStream, indent = ''): Promise<string> {
  let fullText = '';

  for await (const event of stream) {
    if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
      process.stdout.write(event.delta.text);
      fullText += event.delta.text;
    }
  }

  // Blank line after streamed output so the token log doesn't run on immediately
  process.stdout.write('\n\n');

  const { usage } = await stream.finalMessage();
  const cacheNote = [
    usage.cache_read_input_tokens ? `${usage.cache_read_input_tokens} cache-read` : '',
    usage.cache_creation_input_tokens ? `${usage.cache_creation_input_tokens} cache-write` : '',
  ].filter(Boolean);

  process.stderr.write(
    `${indent}Tokens — in: ${usage.input_tokens}, out: ${usage.output_tokens}` +
      (cacheNote.length ? ` (${cacheNote.join(', ')})` : '') +
      '\n',
  );

  return fullText;
}
