/**
 * Claude Orchestrator for Baruch
 *
 * Main orchestration loop that:
 * 1. Sends messages to Claude with admin API tool definitions
 * 2. Executes tool calls (admin API + memory tools)
 * 3. Loops until Claude returns a final text response
 * 4. Supports streaming via callbacks
 */

import Anthropic from '@anthropic-ai/sdk';
import { Env } from '../../config/types.js';
import { ChatHistoryEntry, StreamCallbacks } from '../../types/engine.js';
import { DEFAULT_PROMPT_VALUES, PromptSlot } from '../../types/prompt-overrides.js';
import { AdminApiClient } from '../admin-api/index.js';
import { ClaudeAPIError, ValidationError } from '../../utils/errors.js';
import { RequestLogger } from '../../utils/logger.js';
import { MAX_MEMORY_SIZE_BYTES, UserMemoryStore } from '../memory/index.js';
import { buildSystemPrompt, historyToMessages } from './system-prompt.js';
import {
  ADMIN_ONLY_TOOLS,
  buildTools,
  isAdminToolInput,
  isReadMemoryInput,
  isUpdateMemoryInput,
} from './tools.js';
import {
  getPromptOverrides,
  setPromptOverrides,
  listModes,
  getMode,
  createOrUpdateMode,
  deleteMode,
  listMcpServers,
  setMcpServers,
} from '../admin-api/index.js';

const DEFAULT_MODEL = 'claude-sonnet-4-6';
const DEFAULT_MAX_TOKENS = 4096;
const DEFAULT_MAX_ITERATIONS = 10;
const MAX_ERROR_INPUT_LENGTH = 100;

function truncateInput(input: unknown): string {
  const str = JSON.stringify(input);
  return str.length <= MAX_ERROR_INPUT_LENGTH ? str : str.slice(0, MAX_ERROR_INPUT_LENGTH) + '...';
}

export interface OrchestratorOptions {
  env: Env;
  org: string;
  isAdmin?: boolean;
  history: ChatHistoryEntry[];
  preferences: { response_language: string; first_interaction: boolean };
  resolvedPromptValues?: Required<Record<PromptSlot, string>>;
  memoryStore?: UserMemoryStore | undefined;
  memoryTOC?: string | undefined;
  logger: RequestLogger;
  callbacks?: StreamCallbacks | undefined;
}

interface ToolUseBlock {
  type: 'tool_use';
  id: string;
  name: string;
  input: Record<string, unknown>;
}

interface OrchestrationContext {
  client: Anthropic;
  model: string;
  maxTokens: number;
  systemPrompt: string;
  tools: Anthropic.Tool[];
  messages: Anthropic.MessageParam[];
  responses: string[];
  adminClient: AdminApiClient;
  org: string;
  isAdmin: boolean;
  logger: RequestLogger;
  callbacks?: StreamCallbacks | undefined;
  memoryStore: UserMemoryStore | undefined;
}

function extractToolCalls(content: Anthropic.ContentBlock[]): ToolUseBlock[] {
  return content.filter((block): block is ToolUseBlock => block.type === 'tool_use');
}

function extractTextResponses(content: Anthropic.ContentBlock[]): string[] {
  const texts: string[] = [];
  for (const block of content) {
    if (block.type === 'text' && block.text.trim()) {
      texts.push(block.text);
    }
  }
  return texts;
}

async function callClaude(ctx: OrchestrationContext): Promise<Anthropic.Message> {
  if (ctx.callbacks) {
    return streamClaudeResponse(ctx);
  }
  return ctx.client.messages.create({
    model: ctx.model,
    max_tokens: ctx.maxTokens,
    system: ctx.systemPrompt,
    messages: ctx.messages,
    tools: ctx.tools,
  });
}

async function streamClaudeResponse(ctx: OrchestrationContext): Promise<Anthropic.Message> {
  const stream = ctx.client.messages.stream({
    model: ctx.model,
    max_tokens: ctx.maxTokens,
    system: ctx.systemPrompt,
    messages: ctx.messages,
    tools: ctx.tools,
  });
  stream.on('text', (text) => ctx.callbacks?.onProgress(text));
  return stream.finalMessage();
}

async function processIteration(ctx: OrchestrationContext, iteration: number): Promise<boolean> {
  ctx.logger.log('claude_request', { iteration, message_count: ctx.messages.length });

  if (iteration > 0 && ctx.callbacks) {
    ctx.callbacks.onProgress('\n');
  }

  const startTime = Date.now();
  const response = await callClaude(ctx);
  const duration = Date.now() - startTime;
  const toolCalls = extractToolCalls(response.content);

  ctx.logger.log('claude_response', {
    iteration,
    stop_reason: response.stop_reason,
    tool_calls_count: toolCalls.length,
    duration_ms: duration,
  });

  ctx.responses.push(...extractTextResponses(response.content));

  if (response.stop_reason === 'end_turn' || toolCalls.length === 0) {
    return true;
  }

  ctx.callbacks?.onStatus(`Executing ${toolCalls.length} tool(s)...`);

  const toolResults = await executeToolCalls(toolCalls, ctx);

  ctx.messages.push({
    role: 'assistant',
    content: response.content as Anthropic.ContentBlock[],
  });
  ctx.messages.push({ role: 'user', content: toolResults });

  ctx.callbacks?.onIterationComplete?.(ctx.responses.join('\n'));

  return false;
}

function parseIntEnvVar(
  value: string | undefined,
  key: string,
  defaultValue: number,
  logger: RequestLogger
): number {
  if (!value) {
    logger.log('config_default', { key, value: defaultValue });
    return defaultValue;
  }
  const parsed = parseInt(value, 10);
  if (isNaN(parsed) || parsed <= 0) {
    logger.warn('config_invalid', {
      key,
      provided: value,
      using_default: defaultValue,
    });
    return defaultValue;
  }
  return parsed;
}

function createOrchestrationContext(
  userMessage: string,
  options: OrchestratorOptions
): OrchestrationContext {
  const { env, org, history, preferences, logger, callbacks } = options;
  const promptValues = options.resolvedPromptValues ?? DEFAULT_PROMPT_VALUES;

  const model = env.CLAUDE_MODEL ?? DEFAULT_MODEL;
  const maxTokens = parseIntEnvVar(
    env.CLAUDE_MAX_TOKENS,
    'CLAUDE_MAX_TOKENS',
    DEFAULT_MAX_TOKENS,
    logger
  );

  const adminClient = new AdminApiClient({
    baseUrl: env.ENGINE_BASE_URL,
    apiKey: env.ENGINE_API_KEY,
    logger,
  });

  return {
    client: new Anthropic({ apiKey: env.ANTHROPIC_API_KEY }),
    model,
    maxTokens,
    systemPrompt: buildSystemPrompt(preferences, history, promptValues, {
      memoryTOC: options.memoryTOC,
      isAdmin: options.isAdmin,
    }),
    tools: buildTools(options.isAdmin ?? false),
    messages: [...historyToMessages(history, 5), { role: 'user', content: userMessage }],
    responses: [],
    adminClient,
    org,
    isAdmin: options.isAdmin ?? false,
    logger,
    callbacks,
    memoryStore: options.memoryStore,
  };
}

/**
 * Main orchestration function
 */
export async function orchestrate(
  userMessage: string,
  options: OrchestratorOptions
): Promise<string[]> {
  const maxIterations = parseIntEnvVar(
    options.env.MAX_ORCHESTRATION_ITERATIONS,
    'MAX_ORCHESTRATION_ITERATIONS',
    DEFAULT_MAX_ITERATIONS,
    options.logger
  );

  const ctx = createOrchestrationContext(userMessage, options);
  ctx.callbacks?.onStatus('Processing your request...');

  try {
    let completed = false;
    for (let i = 0; i < maxIterations; i++) {
      completed = await processIteration(ctx, i);
      if (completed) break;
    }
    if (!completed) {
      ctx.logger.warn('orchestration_iteration_limit_reached', { maxIterations });
      ctx.responses.push(
        '[Note: I reached my processing limit for this request. My response may be incomplete. Please follow up if you need more.]'
      );
    }
  } catch (error) {
    ctx.logger.error('claude_error', error);
    if (error instanceof Anthropic.APIError) {
      throw new ClaudeAPIError(error.message, error.status);
    }
    throw error;
  }

  return ctx.responses;
}

async function executeToolCalls(
  toolCalls: ToolUseBlock[],
  ctx: OrchestrationContext
): Promise<Anthropic.ToolResultBlockParam[]> {
  // Serialize tool execution to avoid race conditions on concurrent read+write
  const results: Anthropic.ToolResultBlockParam[] = [];
  for (const tc of toolCalls) {
    results.push(await executeSingleTool(tc, ctx));
  }
  return results;
}

async function executeSingleTool(
  toolCall: ToolUseBlock,
  ctx: OrchestrationContext
): Promise<Anthropic.ToolResultBlockParam> {
  ctx.logger.log('tool_execution_start', { tool_name: toolCall.name, tool_id: toolCall.id });
  ctx.callbacks?.onToolUse?.(toolCall.name, toolCall.input);

  const startTime = Date.now();

  try {
    const result = await dispatchToolCall(toolCall, ctx);
    ctx.logger.log('tool_execution_complete', {
      tool_name: toolCall.name,
      tool_id: toolCall.id,
      duration_ms: Date.now() - startTime,
      success: true,
    });
    ctx.callbacks?.onToolResult?.(toolCall.name, result);
    return { type: 'tool_result', tool_use_id: toolCall.id, content: JSON.stringify(result) };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    ctx.logger.error('tool_execution_error', error, {
      tool_name: toolCall.name,
      tool_id: toolCall.id,
      duration_ms: Date.now() - startTime,
    });
    ctx.callbacks?.onToolResult?.(toolCall.name, { error: errorMessage });
    return {
      type: 'tool_result',
      tool_use_id: toolCall.id,
      content: JSON.stringify({ error: errorMessage }),
      is_error: true,
    };
  }
}

async function dispatchToolCall(
  toolCall: ToolUseBlock,
  ctx: OrchestrationContext
): Promise<unknown> {
  const { name, input } = toolCall;

  if (name === 'read_memory') return handleReadMemory(input, ctx);
  if (name === 'update_memory') return handleUpdateMemory(input, ctx);

  return dispatchAdminTool(name, input, ctx);
}

type AdminToolHandler = (
  input: Record<string, unknown>,
  org: string,
  ctx: OrchestrationContext
) => Promise<unknown>;

const ADMIN_TOOL_HANDLERS: Record<string, AdminToolHandler> = {
  get_prompt_overrides: (_input, org, ctx) => getPromptOverrides(ctx.adminClient, org),
  set_prompt_overrides: (input, org, ctx) =>
    setPromptOverrides(ctx.adminClient, org, input.overrides as Record<string, string | null>),
  list_modes: (_input, org, ctx) => listModes(ctx.adminClient, org),
  get_mode: (input, org, ctx) => getMode(ctx.adminClient, org, input.name as string),
  create_or_update_mode: (input, org, ctx) => handleCreateOrUpdateMode(input, org, ctx),
  delete_mode: (input, org, ctx) => deleteMode(ctx.adminClient, org, input.name as string),
  list_mcp_servers: (_input, org, ctx) => listMcpServers(ctx.adminClient, org),
  set_mcp_servers: (input, org, ctx) =>
    setMcpServers(ctx.adminClient, org, input.servers as unknown[]),
};

async function dispatchAdminTool(
  name: string,
  input: unknown,
  ctx: OrchestrationContext
): Promise<unknown> {
  if (!isAdminToolInput(input)) {
    throw new ValidationError(
      `Invalid input for ${name}: expected object, got ${truncateInput(input)}`
    );
  }

  // Defense-in-depth: reject admin-only tools even if Claude emits them
  if (ADMIN_ONLY_TOOLS.has(name) && !ctx.isAdmin) {
    throw new ValidationError(`Tool ${name} requires admin privileges`);
  }

  const org = ctx.org;
  // eslint-disable-next-line security/detect-object-injection -- name is validated against known keys
  const handler = ADMIN_TOOL_HANDLERS[name];

  if (!handler) {
    throw new ValidationError(`Unknown tool: ${name}`);
  }

  return handler(input, org, ctx);
}

async function handleCreateOrUpdateMode(
  input: Record<string, unknown>,
  org: string,
  ctx: OrchestrationContext
): Promise<unknown> {
  const body = {
    label: input.label,
    description: input.description,
    overrides: input.overrides,
  };
  return createOrUpdateMode(ctx.adminClient, org, input.name as string, body);
}

async function handleReadMemory(input: unknown, ctx: OrchestrationContext): Promise<unknown> {
  if (!ctx.memoryStore) {
    return { error: 'Memory is not available for this session.' };
  }
  if (!isReadMemoryInput(input)) {
    throw new ValidationError(
      `Invalid input for read_memory: expected { sections?: string[] }, got ${truncateInput(input)}`
    );
  }
  const sections = input.sections?.length ? input.sections : undefined;
  const result = await ctx.memoryStore.read(sections);
  const sizeBytes = await ctx.memoryStore.getSizeBytes();
  const capacityPercent = Math.min(100, Math.round((sizeBytes / MAX_MEMORY_SIZE_BYTES) * 100));

  if (typeof result === 'string') {
    const size = new TextEncoder().encode(result).byteLength;
    return { content: result, total_size_bytes: size, capacityPercent };
  }
  const totalSize = new TextEncoder().encode(JSON.stringify(result)).byteLength;
  return { sections: result, total_size_bytes: totalSize, capacityPercent };
}

async function handleUpdateMemory(input: unknown, ctx: OrchestrationContext): Promise<unknown> {
  if (!ctx.memoryStore) {
    return { error: 'Memory is not available for this session.' };
  }
  if (!isUpdateMemoryInput(input)) {
    throw new ValidationError(
      `Invalid input for update_memory: expected { sections: Record<string, string|null> }, got ${truncateInput(input)}`
    );
  }
  return ctx.memoryStore.writeSections(input.sections, input.pin, input.unpin);
}
