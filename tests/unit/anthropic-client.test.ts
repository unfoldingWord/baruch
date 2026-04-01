import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  callClaudeRaw,
  streamClaudeRaw,
  ClaudeRequestParams,
} from '../../src/services/claude/anthropic-client.js';

vi.stubGlobal('fetch', vi.fn());

const baseParams: ClaudeRequestParams = {
  model: 'claude-sonnet-4-6',
  maxTokens: 1024,
  system: 'You are helpful.',
  messages: [{ role: 'user', content: 'Hi' }],
  tools: [],
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe('callClaudeRaw', () => {
  it('sends correct headers and body', async () => {
    const msg = {
      id: 'msg_1',
      type: 'message',
      role: 'assistant',
      content: [],
      model: 'claude-sonnet-4-6',
      stop_reason: 'end_turn',
      stop_sequence: null,
      usage: { input_tokens: 5, output_tokens: 3 },
    };
    vi.mocked(fetch).mockResolvedValue(new Response(JSON.stringify(msg)));

    await callClaudeRaw(baseParams, 'test-key');

    const [url, init] = vi.mocked(fetch).mock.calls[0]!;
    expect(url).toBe('https://api.anthropic.com/v1/messages');
    const headers = init!.headers as Record<string, string>;
    expect(headers['x-api-key']).toBe('test-key');
    expect(headers['anthropic-version']).toBe('2023-06-01');
    const body = JSON.parse(init!.body as string);
    expect(body.stream).toBe(false);
    expect(body.max_tokens).toBe(1024);
  });

  it('returns parsed message', async () => {
    const msg = {
      id: 'msg_1',
      type: 'message',
      role: 'assistant',
      content: [{ type: 'text', text: 'Hello' }],
      model: 'claude-sonnet-4-6',
      stop_reason: 'end_turn',
      stop_sequence: null,
      usage: { input_tokens: 5, output_tokens: 3 },
    };
    vi.mocked(fetch).mockResolvedValue(new Response(JSON.stringify(msg)));

    const result = await callClaudeRaw(baseParams, 'key');
    expect(result.content[0]).toEqual({ type: 'text', text: 'Hello' });
  });

  it('throws ClaudeAPIError on non-ok response', async () => {
    const errorBody = { error: { message: 'Rate limited' } };
    vi.mocked(fetch).mockResolvedValue(
      new Response(JSON.stringify(errorBody), { status: 429, statusText: 'Too Many Requests' })
    );

    await expect(callClaudeRaw(baseParams, 'key')).rejects.toThrow('Rate limited');
  });

  it('throws with statusText when error body is not JSON', async () => {
    vi.mocked(fetch).mockResolvedValue(
      new Response('not json', { status: 500, statusText: 'Internal Server Error' })
    );

    await expect(callClaudeRaw(baseParams, 'key')).rejects.toThrow('Internal Server Error');
  });

  it('omits tools when empty array', async () => {
    vi.mocked(fetch).mockResolvedValue(
      new Response(
        JSON.stringify({
          id: 'msg_1',
          type: 'message',
          role: 'assistant',
          content: [],
          model: 'm',
          stop_reason: 'end_turn',
          stop_sequence: null,
          usage: { input_tokens: 0, output_tokens: 0 },
        })
      )
    );

    await callClaudeRaw(baseParams, 'key');
    const body = JSON.parse(vi.mocked(fetch).mock.calls[0]![1]!.body as string);
    expect(body.tools).toBeUndefined();
  });
});

function makeSSEResponse(events: string[]): Response {
  const text = events.join('');
  return new Response(text, { headers: { 'content-type': 'text/event-stream' } });
}

describe('streamClaudeRaw text streaming', () => {
  it('streams text deltas via onText handler', async () => {
    const sseEvents = [
      `event: message_start\ndata: ${JSON.stringify({ type: 'message_start', message: { id: 'msg_1', model: 'claude-sonnet-4-6', role: 'assistant', usage: { input_tokens: 5, output_tokens: 0 } } })}\n\n`,
      `event: content_block_start\ndata: ${JSON.stringify({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } })}\n\n`,
      `event: content_block_delta\ndata: ${JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Hello' } })}\n\n`,
      `event: content_block_delta\ndata: ${JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: ' world' } })}\n\n`,
      `event: message_delta\ndata: ${JSON.stringify({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 5 } })}\n\n`,
    ];

    vi.mocked(fetch).mockResolvedValue(makeSSEResponse(sseEvents));

    const texts: string[] = [];
    const stream = streamClaudeRaw(baseParams, 'key');
    stream.onText((t) => texts.push(t));
    const msg = await stream.finalMessage();

    expect(texts).toEqual(['Hello', ' world']);
    expect(msg.id).toBe('msg_1');
    expect(msg.content[0]!.type).toBe('text');
    expect((msg.content[0] as { text: string }).text).toBe('Hello world');
    expect(msg.stop_reason).toBe('end_turn');
  });

  it('assembles tool_use blocks from JSON deltas', async () => {
    const input = { query: 'test' };
    const sseEvents = [
      `event: message_start\ndata: ${JSON.stringify({ type: 'message_start', message: { id: 'msg_2', model: 'claude-sonnet-4-6', role: 'assistant', usage: { input_tokens: 5, output_tokens: 0 } } })}\n\n`,
      `event: content_block_start\ndata: ${JSON.stringify({ type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'tu_1', name: 'search', input: {} } })}\n\n`,
      `event: content_block_delta\ndata: ${JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify(input) } })}\n\n`,
      `event: message_delta\ndata: ${JSON.stringify({ type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 10 } })}\n\n`,
    ];

    vi.mocked(fetch).mockResolvedValue(makeSSEResponse(sseEvents));

    const stream = streamClaudeRaw(baseParams, 'key');
    const msg = await stream.finalMessage();

    expect(msg.content[0]!.type).toBe('tool_use');
    const toolBlock = msg.content[0] as { input: unknown };
    expect(toolBlock.input).toEqual(input);
  });
});

describe('streamClaudeRaw error handling', () => {
  it('throws on incomplete stream (no message_start)', async () => {
    const sseEvents = [
      `event: content_block_start\ndata: ${JSON.stringify({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } })}\n\n`,
    ];

    vi.mocked(fetch).mockResolvedValue(makeSSEResponse(sseEvents));

    const stream = streamClaudeRaw(baseParams, 'key');
    await expect(stream.finalMessage()).rejects.toThrow('Incomplete stream');
  });

  it('skips malformed SSE data lines', async () => {
    const sseEvents = [
      `event: message_start\ndata: ${JSON.stringify({ type: 'message_start', message: { id: 'msg_3', model: 'm', role: 'assistant', usage: { input_tokens: 0, output_tokens: 0 } } })}\n\n`,
      `data: not valid json\n\n`,
      `event: message_delta\ndata: ${JSON.stringify({ type: 'message_delta', delta: { stop_reason: 'end_turn' } })}\n\n`,
    ];

    vi.mocked(fetch).mockResolvedValue(makeSSEResponse(sseEvents));

    const stream = streamClaudeRaw(baseParams, 'key');
    const msg = await stream.finalMessage();
    expect(msg.id).toBe('msg_3');
  });

  it('handles truncated tool_use JSON gracefully', async () => {
    const sseEvents = [
      `event: message_start\ndata: ${JSON.stringify({ type: 'message_start', message: { id: 'msg_4', model: 'm', role: 'assistant', usage: { input_tokens: 0, output_tokens: 0 } } })}\n\n`,
      `event: content_block_start\ndata: ${JSON.stringify({ type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'tu_1', name: 'search', input: {} } })}\n\n`,
      `event: content_block_delta\ndata: ${JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"trunca' } })}\n\n`,
      `event: message_delta\ndata: ${JSON.stringify({ type: 'message_delta', delta: { stop_reason: 'end_turn' } })}\n\n`,
    ];

    vi.mocked(fetch).mockResolvedValue(makeSSEResponse(sseEvents));

    const stream = streamClaudeRaw(baseParams, 'key');
    const msg = await stream.finalMessage();
    const toolBlock = msg.content[0] as { input: unknown };
    expect(toolBlock.input).toEqual({});
  });

  it('throws on non-ok streaming response', async () => {
    vi.mocked(fetch).mockResolvedValue(
      new Response(JSON.stringify({ error: { message: 'Overloaded' } }), { status: 529 })
    );

    const stream = streamClaudeRaw(baseParams, 'key');
    await expect(stream.finalMessage()).rejects.toThrow('Overloaded');
  });
});
