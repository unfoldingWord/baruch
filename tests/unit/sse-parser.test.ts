import { describe, it, expect } from 'vitest';
import { parseSSEStream, SSEField } from '../../src/services/claude/sse-parser.js';

function makeStream(text: string): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(text));
      controller.close();
    },
  });
}

function makeChunkedStream(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(encoder.encode(chunk));
      }
      controller.close();
    },
  });
}

async function collect(stream: ReadableStream<Uint8Array>): Promise<SSEField[]> {
  const fields: SSEField[] = [];
  for await (const field of parseSSEStream(stream)) {
    fields.push(field);
  }
  return fields;
}

describe('parseSSEStream basic parsing', () => {
  it('parses a single event', async () => {
    const fields = await collect(makeStream('data: hello\n\n'));
    expect(fields).toEqual([{ event: 'message', data: 'hello' }]);
  });

  it('parses named events', async () => {
    const fields = await collect(makeStream('event: delta\ndata: world\n\n'));
    expect(fields).toEqual([{ event: 'delta', data: 'world' }]);
  });

  it('parses multiple events', async () => {
    const fields = await collect(makeStream('data: first\n\ndata: second\n\n'));
    expect(fields).toHaveLength(2);
    expect(fields[0]!.data).toBe('first');
    expect(fields[1]!.data).toBe('second');
  });

  it('strips leading space from data field', async () => {
    const fields = await collect(makeStream('data: spaced\n\n'));
    expect(fields[0]!.data).toBe('spaced');
  });

  it('handles data without leading space', async () => {
    const fields = await collect(makeStream('data:nospace\n\n'));
    expect(fields[0]!.data).toBe('nospace');
  });

  it('handles multi-line data', async () => {
    const fields = await collect(makeStream('data: line1\ndata: line2\n\n'));
    expect(fields[0]!.data).toBe('line1\nline2');
  });

  it('resets event type after each event', async () => {
    const fields = await collect(makeStream('event: custom\ndata: first\n\ndata: second\n\n'));
    expect(fields[0]!.event).toBe('custom');
    expect(fields[1]!.event).toBe('message');
  });

  it('ignores empty events (no data)', async () => {
    const fields = await collect(makeStream('\n\ndata: real\n\n'));
    expect(fields).toHaveLength(1);
    expect(fields[0]!.data).toBe('real');
  });
});

describe('parseSSEStream edge cases', () => {
  it('handles \\r\\n line endings', async () => {
    const fields = await collect(makeStream('event: test\r\ndata: crlf\r\n\r\n'));
    expect(fields[0]!.event).toBe('test');
    expect(fields[0]!.data).toBe('crlf');
  });

  it('handles chunked delivery across event boundaries', async () => {
    const fields = await collect(makeChunkedStream(['data: he', 'llo\n\ndata: wo', 'rld\n\n']));
    expect(fields).toHaveLength(2);
    expect(fields[0]!.data).toBe('hello');
    expect(fields[1]!.data).toBe('world');
  });

  it('flushes trailing event without final newline', async () => {
    const fields = await collect(makeStream('data: trailing'));
    expect(fields).toHaveLength(1);
    expect(fields[0]!.data).toBe('trailing');
  });

  it('parses JSON data payloads', async () => {
    const json = JSON.stringify({ type: 'text_delta', text: 'Hi' });
    const fields = await collect(makeStream(`data: ${json}\n\n`));
    expect(JSON.parse(fields[0]!.data)).toEqual({ type: 'text_delta', text: 'Hi' });
  });
});
