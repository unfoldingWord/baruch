/**
 * UserSession Durable Object for Baruch
 *
 * Simplified from bt-servant-worker:
 * - No MCP config handling, mode selection, or user prompt overrides
 * - Single-tier prompt resolution (admin KV → defaults)
 * - Passes org + engine credentials to orchestrator for admin API tools
 */

import { Hono } from 'hono';
import { Env } from '../config/types.js';
import { orchestrate } from '../services/claude/index.js';
import { formatTOCForPrompt, JsonMemoryStore } from '../services/memory/index.js';
import {
  createWebhookCallbacks,
  DEFAULT_PROGRESS_MODE,
  DEFAULT_THROTTLE_SECONDS,
  ProgressCallbackSender,
} from '../services/progress/index.js';
import {
  ChatHistoryEntry,
  ChatHistoryResponse,
  ChatRequest,
  ChatResponse,
  SSEEvent,
  StreamCallbacks,
  UpdatePreferencesRequest,
  UserPreferencesAPI,
  UserPreferencesInternal,
} from '../types/engine.js';
import {
  DEFAULT_PROMPT_VALUES,
  PromptOverrides,
  resolvePromptOverrides,
} from '../types/prompt-overrides.js';
import { ValidationError } from '../utils/errors.js';
import { createRequestLogger, RequestLogger } from '../utils/logger.js';
import { applyTemplateVariables } from '../utils/template.js';
import { resolveOrgFromBody } from '../utils/org.js';

const HISTORY_KEY = 'history';
const PREFERENCES_KEY = 'preferences';
const PROCESSING_LOCK_KEY = '_processing_lock';
const LOCK_STALE_THRESHOLD_MS = 90000;
const RETRY_AFTER_SECONDS = 5;
const MAX_HISTORY_STORAGE = 50;

const ISO_639_1_PATTERN = /^[a-z]{2}$/;

function isValidLanguageCode(code: string): boolean {
  return ISO_639_1_PATTERN.test(code);
}

const DEFAULT_PREFERENCES: UserPreferencesInternal = {
  response_language: 'en',
  first_interaction: true,
};

function createErrorResponse(
  error: string,
  code: string,
  message: string,
  status: number
): Response {
  return Response.json({ error, code, message }, { status });
}

export class UserSession {
  private state: DurableObjectState;
  private env: Env;
  private app: Hono;

  constructor(state: DurableObjectState, env: Env) {
    this.state = state;
    this.env = env;

    this.app = new Hono();
    this.app.post('/chat', (c) => this.handleChat(c.req.raw));
    this.app.get('/preferences', () => this.handleGetPreferences());
    this.app.put('/preferences', (c) => this.handleUpdatePreferences(c.req.raw));
    this.app.get('/history', (c) => this.handleGetHistory(new URL(c.req.url)));
    this.app.delete('/history', () => this.handleDeleteHistory());
    this.app.get('/memory', () => this.handleGetMemory());
    this.app.delete('/memory', () => this.handleDeleteMemory());
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === '/chat' || url.pathname === '/stream') {
      const acquired = await this.tryAcquireLock();
      if (!acquired) {
        return this.buildLockRejection();
      }

      if (url.pathname === '/stream') {
        return this.handleStreamingChatWithLock(request);
      }

      try {
        return await this.app.fetch(request);
      } finally {
        await this.releaseLock();
      }
    }

    return this.app.fetch(request);
  }

  private buildLockRejection(): Response {
    return new Response(
      JSON.stringify({
        error: 'Request in progress',
        code: 'CONCURRENT_REQUEST_REJECTED',
        message: 'Another request for this user is currently being processed. Please retry.',
        retry_after_ms: RETRY_AFTER_SECONDS * 1000,
      }),
      {
        status: 429,
        headers: {
          'Content-Type': 'application/json',
          'Retry-After': String(RETRY_AFTER_SECONDS),
        },
      }
    );
  }

  private async tryAcquireLock(): Promise<boolean> {
    return this.state.blockConcurrencyWhile(async () => {
      const lock = await this.state.storage.get<number>(PROCESSING_LOCK_KEY);
      const now = Date.now();
      if (lock && now - lock < LOCK_STALE_THRESHOLD_MS) {
        return false;
      }
      if (lock) {
        console.warn(
          JSON.stringify({
            event: 'stale_lock_overwritten',
            lock_age_ms: now - lock,
            timestamp: now,
          })
        );
      }
      await this.state.storage.put(PROCESSING_LOCK_KEY, now);
      return true;
    });
  }

  private async releaseLock(): Promise<void> {
    await this.state.storage.delete(PROCESSING_LOCK_KEY);
  }

  private buildWebhookCallbacks(body: ChatRequest): StreamCallbacks | undefined {
    if (!body.progress_callback_url || !body.message_key) return undefined;

    const sender = new ProgressCallbackSender({
      url: body.progress_callback_url,
      user_id: body.user_id,
      message_key: body.message_key,
    });
    const throttleSeconds =
      typeof body.progress_throttle_seconds === 'number' && body.progress_throttle_seconds > 0
        ? body.progress_throttle_seconds
        : DEFAULT_THROTTLE_SECONDS;
    return createWebhookCallbacks(sender, {
      mode: body.progress_mode ?? DEFAULT_PROGRESS_MODE,
      throttleSeconds,
    });
  }

  private async handleChat(request: Request): Promise<Response> {
    const requestId = crypto.randomUUID();
    const startTime = Date.now();
    const body = (await request.json()) as ChatRequest;
    const logger = createRequestLogger(requestId, body.user_id);

    logger.log('do_chat_start', { client_id: body.client_id });

    const callbacks = this.buildWebhookCallbacks(body);
    try {
      const response = await this.processChat(body, logger, callbacks);
      await callbacks?.onComplete?.(response);

      logger.log('do_chat_complete', {
        response_count: response.responses.length,
        total_duration_ms: Date.now() - startTime,
      });
      return Response.json(response);
    } catch (error) {
      await callbacks?.onError?.(error instanceof Error ? error.message : 'Unknown error');
      logger.error('do_chat_error', error, { total_duration_ms: Date.now() - startTime });
      if (error instanceof ValidationError) {
        return createErrorResponse('Validation error', 'VALIDATION_ERROR', error.message, 400);
      }
      return createErrorResponse(
        'Internal server error',
        'INTERNAL_ERROR',
        'An unexpected error occurred while processing your request.',
        500
      );
    }
  }

  private async handleStreamingChatWithLock(request: Request): Promise<Response> {
    const requestId = crypto.randomUUID();
    const startTime = Date.now();
    const body = (await request.json()) as ChatRequest;
    const logger = createRequestLogger(requestId, body.user_id);

    logger.log('do_stream_start', { client_id: body.client_id });

    const { readable, writable } = new TransformStream();
    const writer = writable.getWriter();
    const encoder = new TextEncoder();

    let firstTokenTime: number | null = null;

    const sendEvent = async (event: SSEEvent): Promise<void> => {
      if (event.type === 'progress' && firstTokenTime === null) {
        firstTokenTime = Date.now() - startTime;
        logger.log('stream_first_token', { time_to_first_token_ms: firstTokenTime });
      }
      await writer.write(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
    };

    this.processStreamingChat(body, sendEvent, writer, logger, startTime)
      .catch(async (error) => {
        logger.error('do_stream_error', error, { total_duration_ms: Date.now() - startTime });
        try {
          await sendEvent({
            type: 'error',
            error: error instanceof Error ? error.message : 'Unknown error',
          });
        } catch {
          // Writer may already be closed
        }
      })
      .finally(() => this.releaseLock());

    return new Response(readable, {
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      },
    });
  }

  private async handleGetPreferences(): Promise<Response> {
    const prefs = await this.getPreferences();
    const apiPrefs: UserPreferencesAPI = { response_language: prefs.response_language };
    return Response.json(apiPrefs);
  }

  private async handleUpdatePreferences(request: Request): Promise<Response> {
    const updates = (await request.json()) as UpdatePreferencesRequest;

    if (updates.response_language !== undefined) {
      if (
        typeof updates.response_language !== 'string' ||
        !isValidLanguageCode(updates.response_language)
      ) {
        return Response.json(
          {
            error: 'Invalid response_language',
            message: 'Must be a valid ISO 639-1 language code (2 lowercase letters)',
          },
          { status: 400 }
        );
      }
    }

    const current = await this.getPreferences();
    const updated: UserPreferencesInternal = {
      ...current,
      ...(updates.response_language !== undefined && {
        response_language: updates.response_language,
      }),
    };

    await this.updatePreferences(updated);
    const apiPrefs: UserPreferencesAPI = { response_language: updated.response_language };
    return Response.json(apiPrefs);
  }

  private async handleGetHistory(url: URL): Promise<Response> {
    const requestedLimit = parseInt(
      url.searchParams.get('limit') ?? String(MAX_HISTORY_STORAGE),
      10
    );
    const limit = Math.min(requestedLimit, MAX_HISTORY_STORAGE);
    const offset = parseInt(url.searchParams.get('offset') ?? '0', 10);
    const userId = url.searchParams.get('user_id') ?? '';

    const allHistory = await this.getHistory();
    const total = allHistory.length;
    const entries = allHistory.slice(offset, offset + limit).map((e) => ({
      ...e,
      created_at: e.timestamp ? new Date(e.timestamp).toISOString() : null,
    }));

    const response: ChatHistoryResponse = {
      user_id: userId,
      entries,
      total_count: total,
      limit,
      offset,
    };
    return Response.json(response);
  }

  private async processStreamingChat(
    body: ChatRequest,
    sendEvent: (event: SSEEvent) => Promise<void>,
    writer: WritableStreamDefaultWriter<Uint8Array>,
    logger: RequestLogger,
    startTime: number
  ): Promise<void> {
    const callbacks: StreamCallbacks = {
      onStatus: async (message) => sendEvent({ type: 'status', message }),
      onProgress: async (text) => sendEvent({ type: 'progress', text }),
      onComplete: async (response) => sendEvent({ type: 'complete', response }),
      onError: async (error) => sendEvent({ type: 'error', error }),
      onToolUse: async (tool, input) => sendEvent({ type: 'tool_use', tool, input }),
      onToolResult: async (tool, result) => sendEvent({ type: 'tool_result', tool, result }),
    };

    try {
      const response = await this.processChat(body, logger, callbacks);
      logger.log('do_stream_complete', {
        response_count: response.responses.length,
        total_duration_ms: Date.now() - startTime,
      });
      await sendEvent({ type: 'complete', response });
    } finally {
      try {
        await writer.close();
      } catch {
        // Writer may already be closed by error handler
      }
    }
  }

  private async resolvePrompts(logger: RequestLogger) {
    const startTime = Date.now();
    // Read admin overrides from KV
    let adminOverrides: PromptOverrides = {};
    try {
      const org = this.env.DEFAULT_ORG;
      adminOverrides = (await this.env.PROMPT_OVERRIDES.get<PromptOverrides>(org, 'json')) ?? {};
    } catch (error) {
      logger.error('prompt_overrides_kv_read_error', error);
    }

    const resolved = applyTemplateVariables(resolvePromptOverrides(adminOverrides));

    const overriddenSlots = (Object.keys(resolved) as (keyof typeof resolved)[]).filter(
      // eslint-disable-next-line security/detect-object-injection -- s is from Object.keys
      (s) => resolved[s] !== DEFAULT_PROMPT_VALUES[s]
    );
    if (overriddenSlots.length > 0) {
      logger.log('prompt_overrides_applied', {
        admin_overrides: Object.keys(adminOverrides).length,
        overridden_slots: overriddenSlots,
        duration_ms: Date.now() - startTime,
      });
    }
    return resolved;
  }

  private async loadMemoryContext(logger: RequestLogger) {
    const memoryStore = new JsonMemoryStore(this.state.storage, logger);
    const memoryTOC = await memoryStore.getTableOfContents();
    const formattedTOC = formatTOCForPrompt(memoryTOC);
    return { memoryStore, formattedTOC: formattedTOC || undefined };
  }

  private async loadUserContext(logger: RequestLogger) {
    const startTime = Date.now();
    const [preferences, history] = await Promise.all([this.getPreferences(), this.getHistory()]);
    logger.log('phase_load_complete', {
      history_count: history.length,
      duration_ms: Date.now() - startTime,
    });
    return { preferences, history };
  }

  private async saveConversation(
    message: string,
    responses: string[],
    preferences: UserPreferencesInternal,
    logger: RequestLogger
  ): Promise<void> {
    const startTime = Date.now();
    await this.addHistoryEntry(
      {
        user_message: message,
        assistant_response: responses.join('\n'),
        timestamp: Date.now(),
      },
      MAX_HISTORY_STORAGE
    );
    if (preferences.first_interaction) {
      await this.updatePreferences({ ...preferences, first_interaction: false });
    }
    logger.log('phase_save_complete', { duration_ms: Date.now() - startTime });
  }

  private async processChat(
    body: ChatRequest,
    logger: RequestLogger,
    callbacks?: StreamCallbacks
  ): Promise<ChatResponse> {
    if (!body.message?.trim()) {
      throw new ValidationError('Message is required');
    }

    const org = resolveOrgFromBody(body, this.env.DEFAULT_ORG);
    const { preferences, history } = await this.loadUserContext(logger);
    const resolvedPromptValues = await this.resolvePrompts(logger);
    const { memoryStore, formattedTOC } = await this.loadMemoryContext(logger);

    const startTime = Date.now();
    const responses = await orchestrate(body.message, {
      env: this.env,
      org,
      isAdmin: body.is_admin ?? false,
      history,
      preferences: {
        response_language: preferences.response_language,
        first_interaction: preferences.first_interaction,
      },
      resolvedPromptValues,
      memoryStore,
      memoryTOC: formattedTOC,
      logger,
      callbacks,
    });
    logger.log('phase_orchestration_complete', {
      response_count: responses.length,
      duration_ms: Date.now() - startTime,
    });

    await this.saveConversation(body.message, responses, preferences, logger);

    return {
      responses,
      response_language: preferences.response_language,
      voice_audio_base64: null,
    };
  }

  private async handleDeleteHistory(): Promise<Response> {
    try {
      await this.state.storage.delete(HISTORY_KEY);
      return Response.json({ message: 'User history cleared' });
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      return createErrorResponse('Storage error', 'INTERNAL_ERROR', msg, 500);
    }
  }

  private async handleGetMemory(): Promise<Response> {
    try {
      const logger = createRequestLogger(crypto.randomUUID());
      const store = new JsonMemoryStore(this.state.storage, logger);
      const content = await store.read();
      const toc = await store.getTableOfContents();
      return Response.json({ content, toc });
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      return createErrorResponse('Storage error', 'INTERNAL_ERROR', msg, 500);
    }
  }

  private async handleDeleteMemory(): Promise<Response> {
    try {
      const logger = createRequestLogger(crypto.randomUUID());
      const store = new JsonMemoryStore(this.state.storage, logger);
      await store.clear();
      return Response.json({ message: 'User memory cleared' });
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      return createErrorResponse('Storage error', 'INTERNAL_ERROR', msg, 500);
    }
  }

  private async getHistory(): Promise<ChatHistoryEntry[]> {
    const history = await this.state.storage.get<ChatHistoryEntry[]>(HISTORY_KEY);
    return history ?? [];
  }

  private async addHistoryEntry(entry: ChatHistoryEntry, maxStorage: number): Promise<void> {
    const history = await this.getHistory();
    history.push(entry);
    const trimmed = history.slice(-maxStorage);
    await this.state.storage.put(HISTORY_KEY, trimmed);
  }

  private async getPreferences(): Promise<UserPreferencesInternal> {
    const prefs = await this.state.storage.get<UserPreferencesInternal>(PREFERENCES_KEY);
    return prefs ?? DEFAULT_PREFERENCES;
  }

  private async updatePreferences(preferences: UserPreferencesInternal): Promise<void> {
    await this.state.storage.put(PREFERENCES_KEY, preferences);
  }
}
