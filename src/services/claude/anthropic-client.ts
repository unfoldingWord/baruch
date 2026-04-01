/**
 * Raw fetch wrapper for the Anthropic Messages API.
 *
 * Bypasses the Anthropic SDK's internal fetch wrapper which triggers
 * Cloudflare error 1003 ("Direct IP Access Not Allowed") from DO contexts.
 * Uses globalThis.fetch() directly, which works reliably in all CF contexts.
 *
 * The SDK is kept as a type-only dependency for TypeScript types.
 */

import type Anthropic from '@anthropic-ai/sdk';
import { ClaudeAPIError } from '../../utils/errors.js';
import { parseSSEStream } from './sse-parser.js';

const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_VERSION = '2023-06-01';

export interface ClaudeRequestParams {
  model: string;
  maxTokens: number;
  system: string;
  messages: Anthropic.MessageParam[];
  tools: Anthropic.Tool[];
}

export interface ClaudeStream {
  onText(handler: (text: string) => void): void;
  finalMessage(): Promise<Anthropic.Message>;
}

function buildRequestBody(params: ClaudeRequestParams, stream: boolean): string {
  return JSON.stringify({
    model: params.model,
    max_tokens: params.maxTokens,
    system: params.system,
    messages: params.messages,
    tools: params.tools.length > 0 ? params.tools : undefined,
    stream,
  });
}

function buildHeaders(apiKey: string): Record<string, string> {
  return {
    'content-type': 'application/json',
    'x-api-key': apiKey,
    'anthropic-version': ANTHROPIC_VERSION,
  };
}

async function handleErrorResponse(response: Response): Promise<never> {
  let message: string;
  try {
    const body = await response.json();
    message = (body as { error?: { message?: string } }).error?.message ?? response.statusText;
  } catch {
    message = response.statusText;
  }
  throw new ClaudeAPIError(message, response.status);
}

/**
 * Non-streaming call to the Anthropic Messages API.
 */
export async function callClaudeRaw(
  params: ClaudeRequestParams,
  apiKey: string
): Promise<Anthropic.Message> {
  const response = await globalThis.fetch(ANTHROPIC_API_URL, {
    method: 'POST',
    headers: buildHeaders(apiKey),
    body: buildRequestBody(params, false),
  });

  if (!response.ok) await handleErrorResponse(response);
  return (await response.json()) as Anthropic.Message;
}

/**
 * Streaming call to the Anthropic Messages API.
 * Returns a ClaudeStream that emits text deltas and resolves to the final message.
 * Stream consumption is deferred until finalMessage() is called, so onText() is
 * guaranteed to be registered before any events fire.
 */
export function streamClaudeRaw(params: ClaudeRequestParams, apiKey: string): ClaudeStream {
  let textHandler: ((text: string) => void) | undefined;

  return {
    onText(handler: (text: string) => void) {
      textHandler = handler;
    },
    finalMessage: () => consumeStream(params, apiKey, (text) => textHandler?.(text)),
  };
}

async function consumeStream(
  params: ClaudeRequestParams,
  apiKey: string,
  onText: (text: string) => void
): Promise<Anthropic.Message> {
  const response = await globalThis.fetch(ANTHROPIC_API_URL, {
    method: 'POST',
    headers: buildHeaders(apiKey),
    body: buildRequestBody(params, true),
  });

  if (!response.ok) await handleErrorResponse(response);
  if (!response.body) throw new ClaudeAPIError('No response body for stream', 500);

  return assembleMessageFromStream(response.body, onText);
}

async function assembleMessageFromStream(
  body: ReadableStream<Uint8Array>,
  onText: (text: string) => void
): Promise<Anthropic.Message> {
  const message: Partial<Anthropic.Message> = {};
  const contentBlocks: Anthropic.ContentBlock[] = [];

  for await (const field of parseSSEStream(body)) {
    let data: Record<string, unknown>;
    try {
      data = JSON.parse(field.data);
    } catch {
      continue; // Skip malformed SSE events (e.g. ping, comments)
    }
    processStreamEvent(data, message, contentBlocks, onText);
  }

  return buildFinalMessage(message, contentBlocks);
}

function processStreamEvent(
  data: Record<string, unknown>,
  message: Partial<Anthropic.Message>,
  contentBlocks: Anthropic.ContentBlock[],
  onText: (text: string) => void
): void {
  switch (data.type) {
    case 'message_start':
      Object.assign(message, (data as { message: Partial<Anthropic.Message> }).message);
      break;
    case 'content_block_start':
      contentBlocks[data.index as number] = data.content_block as Anthropic.ContentBlock;
      break;
    case 'content_block_delta':
      applyContentDelta(contentBlocks, data, onText);
      break;
    case 'message_delta':
      Object.assign(message, (data as { delta: Partial<Anthropic.Message> }).delta);
      break;
  }
}

function applyContentDelta(
  contentBlocks: Anthropic.ContentBlock[],
  data: Record<string, unknown>,
  onText: (text: string) => void
): void {
  const index = data.index as number;
  const delta = data.delta as { type: string; text?: string; partial_json?: string };
  // eslint-disable-next-line security/detect-object-injection -- index from Anthropic API response
  const block = contentBlocks[index];
  if (!block) return;

  if (delta.type === 'text_delta' && delta.text && block.type === 'text') {
    (block as { text: string }).text += delta.text;
    onText(delta.text);
  } else if (delta.type === 'input_json_delta' && delta.partial_json && block.type === 'tool_use') {
    const toolBlock = block as unknown as { _rawInput: string };
    toolBlock._rawInput = (toolBlock._rawInput ?? '') + delta.partial_json;
  }
}

function buildFinalMessage(
  message: Partial<Anthropic.Message>,
  contentBlocks: Anthropic.ContentBlock[]
): Anthropic.Message {
  if (!message.id) {
    throw new ClaudeAPIError('Incomplete stream: missing message_start event', 500);
  }

  parseToolUseInputs(contentBlocks);

  return {
    id: message.id,
    type: 'message',
    role: 'assistant',
    content: contentBlocks,
    model: (message.model as string) ?? '',
    stop_reason: (message.stop_reason as Anthropic.Message['stop_reason']) ?? null,
    stop_sequence: (message.stop_sequence as string) ?? null,
    usage: (message.usage as Anthropic.Usage) ?? { input_tokens: 0, output_tokens: 0 },
  };
}

function parseToolUseInputs(contentBlocks: Anthropic.ContentBlock[]): void {
  for (const block of contentBlocks) {
    if (block.type === 'tool_use') {
      const raw = (block as unknown as { _rawInput?: string })._rawInput;
      if (raw) {
        try {
          (block as unknown as { input: unknown }).input = JSON.parse(raw);
        } catch {
          // Truncated stream — keep whatever partial input was accumulated
          (block as unknown as { input: unknown }).input = {};
        }
        delete (block as unknown as { _rawInput?: string })._rawInput;
      }
    }
  }
}
