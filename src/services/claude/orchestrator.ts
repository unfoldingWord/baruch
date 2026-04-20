/**
 * Claude Orchestrator for Baruch
 *
 * Main orchestration loop that:
 * 1. Sends messages to Claude with admin API + MCP tool definitions
 * 2. Executes tool calls (memory → Baruch admin → bt-servant admin → MCP)
 * 3. Loops until Claude returns a final text response
 * 4. Supports streaming via callbacks
 */

import type Anthropic from '@anthropic-ai/sdk';
import { Env } from '../../config/types.js';
import { ChatHistoryEntry, StreamCallbacks } from '../../types/engine.js';
import {
  DEFAULT_PROMPT_VALUES,
  mergePromptOverrides,
  PromptOverrides,
  PromptSlot,
  resolvePromptOverrides,
  validatePromptOverrides,
} from '../../types/prompt-overrides.js';
import { AdminApiClient } from '../admin-api/index.js';
import { ClaudeAPIError, MCPError, ToolInputError, ValidationError } from '../../utils/errors.js';
import { RequestLogger } from '../../utils/logger.js';
import { MAX_MEMORY_SIZE_BYTES, UserMemoryStore } from '../memory/index.js';
import {
  callMCPTool,
  catalogToolsToAnthropicTools,
  findTool,
  getMcpServers,
  MCPServerConfig,
  setMcpServers as setBaruchMcpServersKV,
  ToolCatalog,
} from '../mcp/index.js';
import { createHealthTracker, HealthTracker, isServerHealthy } from '../mcp/health.js';
import { callClaudeRaw, streamClaudeRaw } from './anthropic-client.js';
import { buildSystemPrompt, historyToMessages } from './system-prompt.js';
import {
  ADMIN_ONLY_TOOLS,
  buildTools,
  isAdminToolInput,
  isReadMemoryInput,
  isSetPromptOverridesInput,
  isUpdateMemoryInput,
  validateCreateOrUpdateModeInput,
  validateNameOnlyInput,
  validateSetMcpServersInput,
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
const DEFAULT_MAX_ITERATIONS = 10;
const MAX_ERROR_INPUT_LENGTH = 100;

function truncateInput(input: unknown): string {
  const str = JSON.stringify(input);
  return str.length <= MAX_ERROR_INPUT_LENGTH ? str : str.slice(0, MAX_ERROR_INPUT_LENGTH) + '...';
}

function inputKeys(input: unknown): string[] {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return [];
  return Object.keys(input as Record<string, unknown>);
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
  mcpCatalog?: ToolCatalog | undefined;
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
  apiKey: string;
  model: string;
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
  env: Env;
  mcpCatalog: ToolCatalog | undefined;
  healthTracker: HealthTracker;
  failedToolSignatures: Map<string, string>;
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
  const params = {
    model: ctx.model,
    system: ctx.systemPrompt,
    messages: ctx.messages,
    tools: ctx.tools,
  };

  if (ctx.callbacks) {
    const stream = streamClaudeRaw(params, ctx.apiKey);
    stream.onText((text) => ctx.callbacks?.onProgress(text));
    return stream.finalMessage();
  }

  return callClaudeRaw(params, ctx.apiKey);
}

function logClaudeResponse(
  ctx: OrchestrationContext,
  iteration: number,
  response: Anthropic.Message,
  toolCalls: ToolUseBlock[],
  duration: number
): void {
  const usage = (response.usage ?? {}) as Anthropic.Usage & {
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
  };
  ctx.logger.log('claude_response', {
    iteration,
    stop_reason: response.stop_reason,
    tool_calls_count: toolCalls.length,
    duration_ms: duration,
    model: response.model,
    input_tokens: usage.input_tokens ?? 0,
    output_tokens: usage.output_tokens ?? 0,
    cache_creation_input_tokens: usage.cache_creation_input_tokens ?? 0,
    cache_read_input_tokens: usage.cache_read_input_tokens ?? 0,
  });

  if (response.stop_reason === 'max_tokens') {
    ctx.logger.warn('claude_stream_truncated', {
      iteration,
      tool_calls_count: toolCalls.length,
      tool_calls: toolCalls.map((tc) => ({
        tool_name: tc.name,
        tool_id: tc.id,
        input_keys: inputKeys(tc.input),
      })),
    });
  }
}

async function processIteration(ctx: OrchestrationContext, iteration: number): Promise<boolean> {
  ctx.logger.log('claude_request', { iteration, message_count: ctx.messages.length });
  if (iteration > 0 && ctx.callbacks) ctx.callbacks.onProgress('\n');

  const startTime = Date.now();
  const response = await callClaude(ctx);
  const toolCalls = extractToolCalls(response.content);
  logClaudeResponse(ctx, iteration, response, toolCalls, Date.now() - startTime);

  ctx.responses.push(...extractTextResponses(response.content));
  if (response.stop_reason === 'end_turn' || toolCalls.length === 0) return true;

  ctx.callbacks?.onStatus(`Executing ${toolCalls.length} tool(s)...`);
  const { results: toolResults, allDuplicates } = await executeToolCalls(toolCalls, ctx);

  ctx.messages.push({ role: 'assistant', content: response.content as Anthropic.ContentBlock[] });
  ctx.messages.push({ role: 'user', content: toolResults });
  ctx.callbacks?.onIterationComplete?.(ctx.responses.join('\n'));

  if (allDuplicates) {
    ctx.logger.warn('orchestration_stopped_duplicate_failures', {
      iteration,
      tool_calls_count: toolCalls.length,
    });
    ctx.responses.push(
      '[Note: I stopped because the same tool call kept failing. Please rephrase your request or try a different approach.]'
    );
    return true;
  }

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
  const mcpCatalog = options.mcpCatalog;

  const model = env.CLAUDE_MODEL ?? DEFAULT_MODEL;

  const adminClient = new AdminApiClient({
    baseUrl: env.ENGINE_BASE_URL,
    apiKey: env.ENGINE_API_KEY,
    logger,
  });

  // Merge built-in tools with MCP tools
  const builtinTools = buildTools(options.isAdmin ?? false);
  const mcpTools = mcpCatalog ? catalogToolsToAnthropicTools(mcpCatalog) : [];
  const allTools = [...builtinTools, ...mcpTools];

  return {
    apiKey: env.ANTHROPIC_API_KEY,
    model,
    systemPrompt: buildSystemPrompt(preferences, history, promptValues, {
      memoryTOC: options.memoryTOC,
      isAdmin: options.isAdmin,
      mcpCatalog,
    }),
    tools: allTools,
    messages: [...historyToMessages(history, 5), { role: 'user', content: userMessage }],
    responses: [],
    adminClient,
    org,
    isAdmin: options.isAdmin ?? false,
    logger,
    callbacks,
    memoryStore: options.memoryStore,
    env,
    mcpCatalog,
    healthTracker: createHealthTracker(),
    failedToolSignatures: new Map(),
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
    if (error instanceof ClaudeAPIError) throw error;
    throw error;
  }

  return ctx.responses;
}

interface ExecutionOutcome {
  result: Anthropic.ToolResultBlockParam;
  duplicateSkip: boolean;
}

async function executeToolCalls(
  toolCalls: ToolUseBlock[],
  ctx: OrchestrationContext
): Promise<{ results: Anthropic.ToolResultBlockParam[]; allDuplicates: boolean }> {
  // Serialize tool execution to avoid race conditions on concurrent read+write
  const outcomes: ExecutionOutcome[] = [];
  for (const tc of toolCalls) {
    outcomes.push(await executeSingleTool(tc, ctx));
  }
  const allDuplicates = outcomes.length > 0 && outcomes.every((o) => o.duplicateSkip);
  return { results: outcomes.map((o) => o.result), allDuplicates };
}

function toolSignature(toolCall: ToolUseBlock): string {
  return `${toolCall.name}:${JSON.stringify(toolCall.input)}`;
}

function makeDuplicateSkipOutcome(
  toolCall: ToolUseBlock,
  signature: string,
  priorError: string,
  ctx: OrchestrationContext
): ExecutionOutcome {
  const content = `Duplicate failing call skipped. The prior identical call failed with: ${priorError}. Adjust the arguments before retrying, or move on.`;
  ctx.logger.warn('tool_call_duplicate_skipped', {
    tool_name: toolCall.name,
    tool_id: toolCall.id,
    signature: signature.slice(0, 200),
    prior_error: priorError,
  });
  ctx.callbacks?.onToolResult?.(toolCall.name, { error: content });
  return {
    result: { type: 'tool_result', tool_use_id: toolCall.id, content, is_error: true },
    duplicateSkip: true,
  };
}

function handleToolSuccess(
  toolCall: ToolUseBlock,
  result: unknown,
  durationMs: number,
  ctx: OrchestrationContext
): ExecutionOutcome {
  ctx.logger.log('tool_execution_complete', {
    tool_name: toolCall.name,
    tool_id: toolCall.id,
    duration_ms: durationMs,
    success: true,
  });
  ctx.callbacks?.onToolResult?.(toolCall.name, result);
  return {
    result: { type: 'tool_result', tool_use_id: toolCall.id, content: JSON.stringify(result) },
    duplicateSkip: false,
  };
}

function handleToolError(
  toolCall: ToolUseBlock,
  signature: string,
  error: unknown,
  durationMs: number,
  ctx: OrchestrationContext
): ExecutionOutcome {
  const errorMessage = error instanceof Error ? error.message : 'Unknown error';
  ctx.failedToolSignatures.set(signature, errorMessage);
  ctx.logger.error('tool_execution_error', error, {
    tool_name: toolCall.name,
    tool_id: toolCall.id,
    duration_ms: durationMs,
  });
  ctx.callbacks?.onToolResult?.(toolCall.name, { error: errorMessage });
  return {
    result: {
      type: 'tool_result',
      tool_use_id: toolCall.id,
      content: JSON.stringify({ error: errorMessage }),
      is_error: true,
    },
    duplicateSkip: false,
  };
}

async function executeSingleTool(
  toolCall: ToolUseBlock,
  ctx: OrchestrationContext
): Promise<ExecutionOutcome> {
  const signature = toolSignature(toolCall);
  const priorError = ctx.failedToolSignatures.get(signature);
  if (priorError !== undefined)
    return makeDuplicateSkipOutcome(toolCall, signature, priorError, ctx);

  ctx.logger.log('tool_execution_start', {
    tool_name: toolCall.name,
    tool_id: toolCall.id,
    input_keys: inputKeys(toolCall.input),
    tool_input: truncateInput(toolCall.input),
  });
  ctx.callbacks?.onToolUse?.(toolCall.name, toolCall.input);

  const startTime = Date.now();
  try {
    const result = await dispatchToolCall(toolCall, ctx);
    return handleToolSuccess(toolCall, result, Date.now() - startTime, ctx);
  } catch (error) {
    return handleToolError(toolCall, signature, error, Date.now() - startTime, ctx);
  }
}

type BaruchToolHandler = (input: unknown, ctx: OrchestrationContext) => Promise<unknown>;

const BARUCH_TOOL_HANDLERS: Record<string, BaruchToolHandler> = {
  get_baruch_prompt_overrides: (_input, ctx) => handleGetBaruchPromptOverrides(ctx),
  set_baruch_prompt_overrides: (input, ctx) => handleSetBaruchPromptOverrides(input, ctx),
  get_baruch_mcp_servers: (_input, ctx) => handleGetBaruchMcpServers(ctx),
  set_baruch_mcp_servers: (input, ctx) => handleSetBaruchMcpServers(input, ctx),
};

async function dispatchToolCall(
  toolCall: ToolUseBlock,
  ctx: OrchestrationContext
): Promise<unknown> {
  const { name, input } = toolCall;

  // Memory tools (no admin check needed)
  if (name === 'read_memory') return handleReadMemory(input, ctx);
  if (name === 'update_memory') return handleUpdateMemory(input, ctx);

  // Baruch self-config tools (admin check applied for writes)
  // eslint-disable-next-line security/detect-object-injection -- name checked against BARUCH_TOOL_HANDLERS keys
  const baruchHandler = BARUCH_TOOL_HANDLERS[name];
  if (baruchHandler) {
    if (ADMIN_ONLY_TOOLS.has(name) && !ctx.isAdmin) {
      throw new ValidationError(`Tool ${name} requires admin privileges`);
    }
    return baruchHandler(input, ctx);
  }

  // Admin API tools (checked before MCP to prevent shadowing)
  // eslint-disable-next-line security/detect-object-injection -- name checked against known keys inside
  if (ADMIN_TOOL_HANDLERS[name]) return dispatchAdminTool(name, input, ctx);

  // MCP tools (checked last — cannot shadow built-in tools)
  if (ctx.mcpCatalog) {
    const mcpTool = findTool(ctx.mcpCatalog, name);
    if (mcpTool) return handleMcpToolCall(name, input, mcpTool.serverId, ctx);
  }

  throw new ValidationError(`Unknown tool: ${name}`);
}

async function handleMcpToolCall(
  toolName: string,
  input: unknown,
  serverId: string,
  ctx: OrchestrationContext
): Promise<unknown> {
  if (!isServerHealthy(ctx.healthTracker, serverId)) {
    ctx.logger.warn('mcp_tool_call_skipped_unhealthy', {
      tool_name: toolName,
      server_id: serverId,
    });
    return { error: `MCP server "${serverId}" is currently unhealthy. Please try again later.` };
  }

  const server = ctx.mcpCatalog!.serverMap.get(serverId);
  if (!server) {
    throw new MCPError(`MCP server "${serverId}" not found in catalog`, serverId);
  }

  const result = await callMCPTool(server, toolName, input, ctx.logger, {
    healthTracker: ctx.healthTracker,
  });
  return result.result;
}

async function handleGetBaruchPromptOverrides(ctx: OrchestrationContext): Promise<unknown> {
  const org = ctx.org;
  const raw = (await ctx.env.PROMPT_OVERRIDES.get<PromptOverrides>(org, 'json')) ?? {};
  const resolved = resolvePromptOverrides(raw);
  return { overrides: raw, resolved };
}

async function handleSetBaruchPromptOverrides(
  input: unknown,
  ctx: OrchestrationContext
): Promise<unknown> {
  if (!isSetPromptOverridesInput(input)) {
    throw new ValidationError(
      `Invalid input for set_baruch_prompt_overrides: expected valid prompt slots. Got ${truncateInput(input)}`
    );
  }
  const org = ctx.org;
  const existing = (await ctx.env.PROMPT_OVERRIDES.get<PromptOverrides>(org, 'json')) ?? {};
  const merged = mergePromptOverrides(existing, input as PromptOverrides);
  const error = validatePromptOverrides(merged);
  if (error) throw new ValidationError(error);
  await ctx.env.PROMPT_OVERRIDES.put(org, JSON.stringify(merged));
  return { success: true, overrides: merged, resolved: resolvePromptOverrides(merged) };
}

async function handleGetBaruchMcpServers(ctx: OrchestrationContext): Promise<unknown> {
  const servers = await getMcpServers(ctx.env.PROMPT_OVERRIDES, ctx.org);
  return { servers };
}

function validateMcpServerEntry(entry: unknown, index: number): string | null {
  if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
    return `servers[${index}] must be an object`;
  }
  const obj = entry as Record<string, unknown>;
  if (typeof obj.id !== 'string' || !obj.id) return `servers[${index}].id is required`;
  if (typeof obj.name !== 'string' || !obj.name) return `servers[${index}].name is required`;
  if (typeof obj.url !== 'string' || !obj.url) return `servers[${index}].url is required`;
  return null;
}

async function handleSetBaruchMcpServers(
  input: unknown,
  ctx: OrchestrationContext
): Promise<unknown> {
  if (!isAdminToolInput(input) || !Array.isArray((input as Record<string, unknown>).servers)) {
    throw new ValidationError(
      'Invalid input for set_baruch_mcp_servers: expected { servers: MCPServerConfig[] }'
    );
  }
  const servers = (input as { servers: unknown[] }).servers;
  for (let i = 0; i < servers.length; i++) {
    // eslint-disable-next-line security/detect-object-injection -- i is a loop index
    const error = validateMcpServerEntry(servers[i], i);
    if (error) throw new ValidationError(`Invalid MCP server config: ${error}`);
  }
  await setBaruchMcpServersKV(ctx.env.PROMPT_OVERRIDES, ctx.org, servers as MCPServerConfig[]);
  return { success: true, server_count: servers.length };
}

type AdminToolHandler = (
  input: Record<string, unknown>,
  org: string,
  ctx: OrchestrationContext
) => Promise<unknown>;

const ADMIN_TOOL_HANDLERS: Record<string, AdminToolHandler> = {
  get_prompt_overrides: (_input, org, ctx) => getPromptOverrides(ctx.adminClient, org),
  set_prompt_overrides: (input, org, ctx) => handleSetPromptOverrides(input, org, ctx),
  list_modes: (_input, org, ctx) => listModes(ctx.adminClient, org),
  get_mode: (input, org, ctx) => handleGetMode(input, org, ctx),
  create_or_update_mode: (input, org, ctx) => handleCreateOrUpdateMode(input, org, ctx),
  delete_mode: (input, org, ctx) => handleDeleteMode(input, org, ctx),
  list_mcp_servers: (_input, org, ctx) => listMcpServers(ctx.adminClient, org),
  set_mcp_servers: (input, org, ctx) => handleSetMcpServers(input, org, ctx),
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

async function handleSetPromptOverrides(
  input: Record<string, unknown>,
  org: string,
  ctx: OrchestrationContext
): Promise<unknown> {
  ctx.logger.log('tool_input_received', { tool: 'set_prompt_overrides', input });

  if (!isSetPromptOverridesInput(input)) {
    ctx.logger.warn('tool_input_validation_failed', { tool: 'set_prompt_overrides', input });
    throw new ValidationError(
      'Invalid input for set_prompt_overrides: expected an object with at least one valid slot ' +
        '(identity, methodology, tool_guidance, mcp_tool_guidance, instructions) mapped to a string or null. ' +
        `Got ${truncateInput(input)}`
    );
  }

  ctx.logger.log('tool_input_validated', { tool: 'set_prompt_overrides', input });
  return setPromptOverrides(ctx.adminClient, org, input);
}

function runValidator(
  toolName: string,
  input: unknown,
  validator: (i: unknown) => { ok: true } | { ok: false; reason: string },
  ctx: OrchestrationContext
): void {
  const result = validator(input);
  if (result.ok) return;
  ctx.logger.warn('tool_input_validation_failed', {
    tool_name: toolName,
    reason: result.reason,
    input_keys: inputKeys(input),
    input: truncateInput(input),
  });
  throw new ToolInputError(toolName, result.reason);
}

async function handleGetMode(
  input: Record<string, unknown>,
  org: string,
  ctx: OrchestrationContext
): Promise<unknown> {
  runValidator('get_mode', input, validateNameOnlyInput, ctx);
  return getMode(ctx.adminClient, org, input.name as string);
}

async function handleDeleteMode(
  input: Record<string, unknown>,
  org: string,
  ctx: OrchestrationContext
): Promise<unknown> {
  runValidator('delete_mode', input, validateNameOnlyInput, ctx);
  return deleteMode(ctx.adminClient, org, input.name as string);
}

async function handleCreateOrUpdateMode(
  input: Record<string, unknown>,
  org: string,
  ctx: OrchestrationContext
): Promise<unknown> {
  runValidator('create_or_update_mode', input, validateCreateOrUpdateModeInput, ctx);
  const body = {
    label: input.label,
    description: input.description,
    overrides: input.overrides,
  };
  return createOrUpdateMode(ctx.adminClient, org, input.name as string, body);
}

async function handleSetMcpServers(
  input: Record<string, unknown>,
  org: string,
  ctx: OrchestrationContext
): Promise<unknown> {
  runValidator('set_mcp_servers', input, validateSetMcpServersInput, ctx);
  return setMcpServers(ctx.adminClient, org, input.servers as unknown[]);
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
