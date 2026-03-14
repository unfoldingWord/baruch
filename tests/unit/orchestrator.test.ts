import { describe, it, expect, vi, beforeEach } from 'vitest';
import { orchestrate, OrchestratorOptions } from '../../src/services/claude/orchestrator.js';
import { DEFAULT_PROMPT_VALUES } from '../../src/types/prompt-overrides.js';

const mockLogger = { log: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };

// Mock Anthropic SDK
const mockCreate = vi.fn();
const mockStream = vi.fn();
vi.mock('@anthropic-ai/sdk', () => {
  return {
    default: class {
      messages = { create: mockCreate, stream: mockStream };
      static APIError = class extends Error {
        status: number;
        constructor(s: number, m: string) {
          super(m);
          this.status = s;
        }
      };
    },
  };
});

// Mock fetch for admin API calls
vi.stubGlobal('fetch', vi.fn());

function buildEnv() {
  return {
    ENVIRONMENT: 'test',
    MAX_ORCHESTRATION_ITERATIONS: '10',
    DEFAULT_ORG: 'testOrg',
    ANTHROPIC_API_KEY: 'test-key',
    BARUCH_API_KEY: 'test-baruch-key',
    ENGINE_API_KEY: 'test-engine-key',
    ENGINE_BASE_URL: 'https://api.example.com',
    PROMPT_OVERRIDES: {} as KVNamespace,
    USER_SESSION: {} as DurableObjectNamespace,
    USER_QUEUE: {} as DurableObjectNamespace,
  };
}

function buildOptions(overrides?: Partial<OrchestratorOptions>): OrchestratorOptions {
  return {
    env: buildEnv(),
    org: 'testOrg',
    history: [],
    preferences: { response_language: 'en', first_interaction: false },
    resolvedPromptValues: DEFAULT_PROMPT_VALUES,
    logger: mockLogger,
    ...overrides,
  };
}

function textResponse(text: string) {
  return {
    content: [{ type: 'text', text }],
    stop_reason: 'end_turn',
    model: 'claude-sonnet-4-6',
    id: 'msg_1',
    type: 'message',
    role: 'assistant',
    usage: { input_tokens: 10, output_tokens: 5 },
  };
}

function toolUseResponse(toolName: string, input: Record<string, unknown>) {
  return {
    content: [{ type: 'tool_use', id: 'tu_1', name: toolName, input }],
    stop_reason: 'tool_use',
    model: 'claude-sonnet-4-6',
    id: 'msg_1',
    type: 'message',
    role: 'assistant',
    usage: { input_tokens: 10, output_tokens: 5 },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('orchestrate basic flow', () => {
  it('returns text response from Claude', async () => {
    mockCreate.mockResolvedValue(textResponse('Hello!'));
    const result = await orchestrate('Hi', buildOptions());
    expect(result).toEqual(['Hello!']);
  });

  it('skips empty text blocks', async () => {
    mockCreate.mockResolvedValue({
      ...textResponse('Result'),
      content: [
        { type: 'text', text: '  ' },
        { type: 'text', text: 'Result' },
      ],
    });
    const result = await orchestrate('test', buildOptions());
    expect(result).toEqual(['Result']);
  });

  it('calls onStatus callback', async () => {
    mockStream.mockReturnValue({
      on: vi.fn().mockReturnThis(),
      finalMessage: vi.fn().mockResolvedValue(textResponse('Done')),
    });
    const onStatus = vi.fn();
    const callbacks = { onStatus, onProgress: vi.fn() };
    await orchestrate('Hi', buildOptions({ callbacks }));
    expect(onStatus).toHaveBeenCalledWith('Processing your request...');
  });
});

describe('orchestrate tool dispatch', () => {
  it('dispatches get_prompt_overrides to admin API', async () => {
    const apiResponse = { overrides: {}, resolved: {} };
    vi.mocked(fetch).mockResolvedValue(new Response(JSON.stringify(apiResponse)));
    mockCreate
      .mockResolvedValueOnce(toolUseResponse('get_prompt_overrides', {}))
      .mockResolvedValueOnce(textResponse('Here are the overrides'));

    const result = await orchestrate('Show overrides', buildOptions());
    expect(result).toEqual(['Here are the overrides']);
    expect(fetch).toHaveBeenCalledWith(
      'https://api.example.com/api/v1/admin/orgs/testOrg/prompt-overrides',
      expect.any(Object)
    );
  });

  it('uses session org, not tool input org', async () => {
    vi.mocked(fetch).mockResolvedValue(new Response(JSON.stringify({})));
    mockCreate
      .mockResolvedValueOnce(toolUseResponse('get_prompt_overrides', { org: 'evil-org' }))
      .mockResolvedValueOnce(textResponse('Done'));

    await orchestrate('test', buildOptions());
    const fetchUrl = vi.mocked(fetch).mock.calls[0][0] as string;
    expect(fetchUrl).toContain('/orgs/testOrg/');
    expect(fetchUrl).not.toContain('evil-org');
  });
});

describe('orchestrate error handling', () => {
  it('returns error result for unknown tools', async () => {
    mockCreate
      .mockResolvedValueOnce(toolUseResponse('nonexistent_tool', {}))
      .mockResolvedValueOnce(textResponse('Noted'));

    const result = await orchestrate('test', buildOptions());
    expect(result).toEqual(['Noted']);
    const secondCallMessages = mockCreate.mock.calls[1][0].messages;
    const toolResult = secondCallMessages[secondCallMessages.length - 1];
    expect(toolResult.content[0].is_error).toBe(true);
  });

  it('returns error for invalid tool input', async () => {
    mockCreate
      .mockResolvedValueOnce({
        ...toolUseResponse('get_prompt_overrides', {}),
        content: [{ type: 'tool_use', id: 'tu_1', name: 'get_prompt_overrides', input: null }],
      })
      .mockResolvedValueOnce(textResponse('Ok'));

    const result = await orchestrate('test', buildOptions());
    expect(result).toEqual(['Ok']);
  });
});

describe('orchestrate iteration limit', () => {
  it('appends warning when iteration limit reached', async () => {
    // Always return tool_use to never complete
    mockCreate.mockResolvedValue(toolUseResponse('list_modes', {}));
    vi.mocked(fetch).mockResolvedValue(new Response(JSON.stringify([])));

    const options = buildOptions();
    options.env.MAX_ORCHESTRATION_ITERATIONS = '2';
    const result = await orchestrate('test', options);

    const lastResponse = result[result.length - 1];
    expect(lastResponse).toContain('processing limit');
    expect(mockLogger.warn).toHaveBeenCalledWith(
      'orchestration_iteration_limit_reached',
      expect.any(Object)
    );
  });
});

describe('orchestrate memory tools', () => {
  it('returns error when memory store not available', async () => {
    mockCreate
      .mockResolvedValueOnce(toolUseResponse('read_memory', {}))
      .mockResolvedValueOnce(textResponse('No memory'));

    const result = await orchestrate('read memory', buildOptions({ memoryStore: undefined }));
    expect(result).toEqual(['No memory']);
  });

  it('dispatches read_memory to memory store', async () => {
    const mockRead = vi.fn().mockResolvedValue('memory content');
    const mockGetSize = vi.fn().mockResolvedValue(100);
    const memoryStore = { read: mockRead, getSizeBytes: mockGetSize } as never;

    mockCreate
      .mockResolvedValueOnce(toolUseResponse('read_memory', {}))
      .mockResolvedValueOnce(textResponse('Got it'));

    await orchestrate('read', buildOptions({ memoryStore }));
    expect(mockRead).toHaveBeenCalled();
  });

  it('dispatches update_memory to memory store', async () => {
    const mockWrite = vi.fn().mockResolvedValue({ updated: ['topic'] });
    const memoryStore = { writeSections: mockWrite } as never;

    mockCreate
      .mockResolvedValueOnce(toolUseResponse('update_memory', { sections: { topic: 'content' } }))
      .mockResolvedValueOnce(textResponse('Saved'));

    await orchestrate('save', buildOptions({ memoryStore }));
    expect(mockWrite).toHaveBeenCalledWith({ topic: 'content' }, undefined, undefined);
  });
});

describe('orchestrate role-based tool filtering', () => {
  it('excludes admin-only tools when isAdmin is false', async () => {
    mockCreate.mockResolvedValue(textResponse('Hi'));
    await orchestrate('test', buildOptions({ isAdmin: false }));
    const tools = mockCreate.mock.calls[0][0].tools;
    const toolNames = tools.map((t: { name: string }) => t.name);
    expect(toolNames).not.toContain('set_prompt_overrides');
    expect(toolNames).not.toContain('set_mcp_servers');
    expect(toolNames).toHaveLength(9);
  });

  it('includes all tools when isAdmin is true', async () => {
    mockCreate.mockResolvedValue(textResponse('Hi'));
    await orchestrate('test', buildOptions({ isAdmin: true }));
    const tools = mockCreate.mock.calls[0][0].tools;
    expect(tools).toHaveLength(12);
  });

  it('rejects admin-only tool at dispatch layer for non-admins', async () => {
    // Even if Claude somehow emits set_prompt_overrides, dispatch should reject it
    mockCreate
      .mockResolvedValueOnce(toolUseResponse('set_prompt_overrides', { identity: 'test' }))
      .mockResolvedValueOnce(textResponse('Noted'));

    const result = await orchestrate('test', buildOptions({ isAdmin: false }));
    expect(result).toEqual(['Noted']);
    // The tool result should be an error
    const secondCallMessages = mockCreate.mock.calls[1][0].messages;
    const toolResult = secondCallMessages[secondCallMessages.length - 1];
    expect(toolResult.content[0].is_error).toBe(true);
    expect(toolResult.content[0].content).toContain('requires admin privileges');
  });

  it('includes non-admin prompt section when isAdmin is false', async () => {
    mockCreate.mockResolvedValue(textResponse('Hi'));
    await orchestrate('test', buildOptions({ isAdmin: false }));
    const systemPrompt = mockCreate.mock.calls[0][0].system;
    expect(systemPrompt).toContain('not an org admin');
  });
});

describe('orchestrate set_prompt_overrides dispatch', () => {
  it('dispatches valid flat input to admin API for admins', async () => {
    vi.mocked(fetch).mockResolvedValue(new Response(JSON.stringify({ ok: true })));
    mockCreate
      .mockResolvedValueOnce(
        toolUseResponse('set_prompt_overrides', { identity: 'New identity prompt' })
      )
      .mockResolvedValueOnce(textResponse('Updated'));

    const result = await orchestrate('set identity', buildOptions({ isAdmin: true }));
    expect(result).toEqual(['Updated']);

    const fetchCall = vi.mocked(fetch).mock.calls[0];
    const url = fetchCall[0] as string;
    expect(url).toContain('/orgs/testOrg/prompt-overrides');
    const reqInit = fetchCall[1] as RequestInit;
    expect(reqInit.method).toBe('PUT');
    expect(JSON.parse(reqInit.body as string)).toEqual({ identity: 'New identity prompt' });
  });

  it('returns validation error for invalid input from admin', async () => {
    mockCreate
      .mockResolvedValueOnce(toolUseResponse('set_prompt_overrides', { identity: 123 }))
      .mockResolvedValueOnce(textResponse('I see the error'));

    const result = await orchestrate('set identity', buildOptions({ isAdmin: true }));
    expect(result).toEqual(['I see the error']);

    const secondCallMessages = mockCreate.mock.calls[1][0].messages;
    const toolResult = secondCallMessages[secondCallMessages.length - 1];
    expect(toolResult.content[0].is_error).toBe(true);
    expect(toolResult.content[0].content).toContain('Invalid input for set_prompt_overrides');
  });
});

describe('orchestrate serialized tool execution', () => {
  it('executes multiple tools sequentially', async () => {
    const callOrder: number[] = [];
    vi.mocked(fetch)
      .mockImplementationOnce(async () => {
        callOrder.push(1);
        return new Response(JSON.stringify({}));
      })
      .mockImplementationOnce(async () => {
        callOrder.push(2);
        return new Response(JSON.stringify({}));
      });

    mockCreate
      .mockResolvedValueOnce({
        content: [
          { type: 'tool_use', id: 'tu_1', name: 'list_modes', input: {} },
          { type: 'tool_use', id: 'tu_2', name: 'list_mcp_servers', input: {} },
        ],
        stop_reason: 'tool_use',
        model: 'claude-sonnet-4-6',
        id: 'msg_1',
        type: 'message',
        role: 'assistant',
        usage: { input_tokens: 10, output_tokens: 5 },
      })
      .mockResolvedValueOnce(textResponse('Done'));

    await orchestrate('test', buildOptions());
    expect(callOrder).toEqual([1, 2]);
  });
});

describe('orchestrate MCP tool dispatch', () => {
  it('dispatches MCP tool calls to the MCP server', async () => {
    vi.mocked(fetch).mockResolvedValue(
      new Response(
        JSON.stringify({
          jsonrpc: '2.0',
          result: { content: [{ type: 'text', text: 'MCP result' }] },
          id: 1,
        })
      )
    );

    const mcpCatalog = {
      tools: [
        {
          name: 'mcp_search',
          description: 'Search',
          inputSchema: { type: 'object', properties: {} },
          serverId: 's1',
          serverUrl: 'https://mcp.test',
        },
      ],
      serverMap: new Map([
        ['s1', { id: 's1', name: 'Test', url: 'https://mcp.test', enabled: true, priority: 1 }],
      ]),
    };

    mockCreate
      .mockResolvedValueOnce(toolUseResponse('mcp_search', { q: 'hello' }))
      .mockResolvedValueOnce(textResponse('Found it'));

    const result = await orchestrate('search', buildOptions({ mcpCatalog }));
    expect(result).toEqual(['Found it']);
  });

  it('rejects set_baruch_mcp_servers for non-admins', async () => {
    mockCreate
      .mockResolvedValueOnce(toolUseResponse('set_baruch_mcp_servers', { servers: [] }))
      .mockResolvedValueOnce(textResponse('Denied'));

    const result = await orchestrate('test', buildOptions({ isAdmin: false }));
    expect(result).toEqual(['Denied']);
    const msgs = mockCreate.mock.calls[1][0].messages;
    const toolResult = msgs[msgs.length - 1];
    expect(toolResult.content[0].is_error).toBe(true);
    expect(toolResult.content[0].content).toContain('requires admin privileges');
  });
});
