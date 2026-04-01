/**
 * Minimal SSE line parser for Anthropic streaming responses.
 *
 * Reads a ReadableStream<Uint8Array> and yields { event, data } tuples
 * per the SSE spec (empty line = event delimiter).
 */

export interface SSEField {
  event: string;
  data: string;
}

interface ParserState {
  event: string;
  data: string;
}

function stripDataPrefix(payload: string): string {
  return payload.startsWith(' ') ? payload.slice(1) : payload;
}

function appendData(state: ParserState, payload: string): void {
  const stripped = stripDataPrefix(payload);
  state.data = state.data ? state.data + '\n' + stripped : stripped;
}

function parseLine(line: string, state: ParserState): SSEField | null {
  const stripped = line.endsWith('\r') ? line.slice(0, -1) : line;

  if (stripped === '') {
    if (!state.data) return null;
    const field: SSEField = { event: state.event, data: state.data };
    state.event = 'message';
    state.data = '';
    return field;
  }

  if (stripped.startsWith('event:')) {
    state.event = stripped.slice(6).trim();
  } else if (stripped.startsWith('data:')) {
    appendData(state, stripped.slice(5));
  }
  return null;
}

export async function* parseSSEStream(body: ReadableStream<Uint8Array>): AsyncGenerator<SSEField> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const state: ParserState = { event: 'message', data: '' };

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop()!;
      yield* processLines(lines, state);
    }
    if (state.data) yield { event: state.event, data: state.data };
  } finally {
    reader.releaseLock();
  }
}

function* processLines(lines: string[], state: ParserState): Generator<SSEField> {
  for (const line of lines) {
    const field = parseLine(line, state);
    if (field) yield field;
  }
}
