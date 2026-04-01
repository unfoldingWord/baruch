/**
 * UserDO — Unified Durable Object for Baruch
 *
 * Merges the previous UserQueue + UserSession into a single DO.
 * All chat processing happens in the fetch() handler context where
 * outbound fetch to Cloudflare-proxied domains works reliably.
 * The alarm() handler is a safety net only — it must NOT call Anthropic or Engine APIs.
 */

import { Hono } from 'hono';
import { Env } from '../config/types.js';
import { orchestrate } from '../services/claude/index.js';
import { SYNTHETIC_CONVERSATION_TRIGGER } from '../services/claude/system-prompt.js';
import { getBuiltinToolNames } from '../services/claude/tools.js';
import { formatTOCForPrompt, JsonMemoryStore } from '../services/memory/index.js';
import {
  buildToolCatalog,
  discoverAllTools,
  getMcpServers,
  ToolCatalog,
} from '../services/mcp/index.js';
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
  ProgressMode,
  SSEEvent,
  StreamCallbacks,
  UpdatePreferencesRequest,
  UserPreferencesAPI,
  UserPreferencesInternal,
} from '../types/engine.js';
import { QueueEntry } from '../types/queue.js';
import {
  DEFAULT_PROMPT_VALUES,
  PromptOverrides,
  resolvePromptOverrides,
} from '../types/prompt-overrides.js';
import { ValidationError } from '../utils/errors.js';
import { createRequestLogger, RequestLogger } from '../utils/logger.js';
import { applyTemplateVariables } from '../utils/template.js';
import { resolveOrgFromBody } from '../utils/org.js';

// --- Session constants ---
const HISTORY_KEY = 'history';
const PREFERENCES_KEY = 'preferences';
const PROCESSING_LOCK_KEY = '_processing_lock';
const LOCK_STALE_THRESHOLD_MS = 90000;
const RETRY_AFTER_SECONDS = 5;
const MAX_HISTORY_STORAGE = 50;

// --- Queue constants ---
const QUEUE_STORAGE_KEY = 'queue';
const DEFAULT_MAX_QUEUE_DEPTH = 50;
const DEFAULT_MAX_RETRIES = 3;
const ENQUEUE_RATE_WINDOW_MS = 60_000;
const ENQUEUE_RATE_LIMIT = 300;

const SSE_HEADERS = {
  'Content-Type': 'text/event-stream',
  'Cache-Control': 'no-cache',
  Connection: 'keep-alive',
};

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

// --- Queue entry parsing (ported from user-queue.ts) ---

const VALID_PROGRESS_MODES: ProgressMode[] = ['complete', 'iteration', 'periodic', 'sentence'];

function isValidProgressMode(value: unknown): value is ProgressMode {
  return typeof value === 'string' && VALID_PROGRESS_MODES.includes(value as ProgressMode);
}

function validateEnqueueBody(body: Record<string, unknown>): string | null {
  if (!body.user_id || typeof body.user_id !== 'string') return 'user_id is required';
  if (!body.message || typeof body.message !== 'string') return 'message is required';
  if (!body.org || typeof body.org !== 'string') return 'org is required';
  return null;
}

function extractOptionalFields(body: Record<string, unknown>) {
  return {
    audio_base64: typeof body.audio_base64 === 'string' ? body.audio_base64 : undefined,
    audio_format: typeof body.audio_format === 'string' ? body.audio_format : undefined,
    progress_callback_url:
      typeof body.progress_callback_url === 'string' ? body.progress_callback_url : undefined,
    progress_throttle_seconds:
      typeof body.progress_throttle_seconds === 'number'
        ? body.progress_throttle_seconds
        : undefined,
    progress_mode: isValidProgressMode(body.progress_mode) ? body.progress_mode : undefined,
    message_key: typeof body.message_key === 'string' ? body.message_key : undefined,
  };
}

function parseEnqueueBody(body: Record<string, unknown>): QueueEntry | string {
  const error = validateEnqueueBody(body);
  if (error) return error;

  return {
    message_id: crypto.randomUUID(),
    user_id: body.user_id as string,
    client_id: typeof body.client_id === 'string' ? body.client_id : 'unknown',
    message: body.message as string,
    message_type: body.message_type === 'audio' ? ('audio' as const) : ('text' as const),
    org: body.org as string,
    is_admin: body.is_admin === true,
    enqueued_at: Date.now(),
    delivery: body.delivery === 'callback' ? ('callback' as const) : ('sse' as const),
    retry_count: 0,
    ...extractOptionalFields(body),
  };
}

function queueEntryToChatRequest(entry: QueueEntry): ChatRequest {
  const req: ChatRequest = {
    client_id: entry.client_id,
    user_id: entry.user_id,
    org: entry.org,
    message: entry.message,
    message_type: entry.message_type,
    is_admin: entry.is_admin,
  };
  if (entry.audio_base64) req.audio_base64 = entry.audio_base64;
  if (entry.audio_format) req.audio_format = entry.audio_format;
  if (entry.progress_callback_url) req.progress_callback_url = entry.progress_callback_url;
  if (entry.progress_throttle_seconds)
    req.progress_throttle_seconds = entry.progress_throttle_seconds;
  if (entry.progress_mode) req.progress_mode = entry.progress_mode;
  if (entry.message_key) req.message_key = entry.message_key;
  return req;
}

// --- Main DO class ---

export class UserDO {
  private state: DurableObjectState;
  private env: Env;
  private app: Hono;
  private queueStreams: Map<string, WritableStreamDefaultWriter<Uint8Array>> = new Map();
  private enqueueTimestamps: number[] = [];

  constructor(state: DurableObjectState, env: Env) {
    this.state = state;
    this.env = env;

    this.app = new Hono();
    this.app.post('/chat', (c) => this.handleChat(c.req.raw));
    this.app.post('/enqueue', (c) => this.handleEnqueue(c.req.raw));
    this.app.get('/status', () => this.handleQueueStatus());
    this.app.get('/preferences', () => this.handleGetPreferences());
    this.app.put('/preferences', (c) => this.handleUpdatePreferences(c.req.raw));
    this.app.get('/history', (c) => this.handleGetHistory(new URL(c.req.url)));
    this.app.delete('/history', () => this.handleDeleteHistory());
    this.app.get('/memory', () => this.handleGetMemory());
    this.app.delete('/memory', () => this.handleDeleteMemory());
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === '/chat' || url.pathname === '/stream' || url.pathname === '/initiate') {
      const acquired = await this.tryAcquireLock();
      if (!acquired) return this.buildLockRejection();

      if (url.pathname === '/stream') return this.handleStreamingChatWithLock(request);
      if (url.pathname === '/initiate') return this.handleInitiateStreamWithLock(request);

      try {
        return await this.app.fetch(request);
      } finally {
        await this.releaseLock();
      }
    }

    return this.app.fetch(request);
  }

  /**
   * Safety net alarm — does NOT process chat (can't call CF-proxied domains from alarm).
   * Clears stale locks so the next fetch can process queued entries.
   */
  async alarm(): Promise<void> {
    const logger = createRequestLogger(crypto.randomUUID());
    const lock = await this.state.storage.get<number>(PROCESSING_LOCK_KEY);

    if (lock && Date.now() - lock > LOCK_STALE_THRESHOLD_MS) {
      logger.warn('alarm_clearing_stale_lock', { lock_age_ms: Date.now() - lock });
      await this.state.storage.delete(PROCESSING_LOCK_KEY);
    }

    const queue = (await this.state.storage.get<QueueEntry[]>(QUEUE_STORAGE_KEY)) ?? [];
    if (queue.length > 0) {
      logger.warn('alarm_queue_not_empty', { queue_length: queue.length });
    }
  }

  // ═══════════════════════════════════════════════
  // Queue: enqueue / dequeue / drain
  // ═══════════════════════════════════════════════

  private async handleEnqueue(request: Request): Promise<Response> {
    let body: Record<string, unknown>;
    try {
      body = (await request.json()) as Record<string, unknown>;
    } catch {
      return Response.json({ error: 'Invalid JSON body' }, { status: 400 });
    }

    const entry = parseEnqueueBody(body);
    if (typeof entry === 'string') return Response.json({ error: entry }, { status: 400 });

    const rateLimited = this.checkEnqueueRateLimit();
    if (rateLimited) return rateLimited;

    const acquired = await this.tryAcquireLock();

    if (entry.delivery === 'sse') return this.enqueueSSE(entry, acquired);
    return this.enqueueCallback(entry, acquired);
  }

  private enqueueSSE(entry: QueueEntry, lockAcquired: boolean): Response {
    const { readable, writable } = new TransformStream<Uint8Array>();
    const writer = writable.getWriter();
    this.queueStreams.set(entry.message_id, writer);

    if (lockAcquired) {
      this.runQueueEntry(entry).finally(() => this.drainQueueAndRelease());
    } else {
      this.enqueueToStorage(entry);
      this.scheduleAlarmSafetyNet();
    }

    return new Response(readable, { status: 200, headers: SSE_HEADERS });
  }

  private async enqueueCallback(entry: QueueEntry, lockAcquired: boolean): Promise<Response> {
    if (lockAcquired) {
      this.runQueueEntry(entry).finally(() => this.drainQueueAndRelease());
      return Response.json({ message_id: entry.message_id, status: 'processing' }, { status: 202 });
    }

    const position = await this.enqueueToStorage(entry);
    if (position === -1) {
      return Response.json(
        { error: 'Queue full', code: 'QUEUE_DEPTH_EXCEEDED' },
        { status: 429, headers: { 'Retry-After': '5' } }
      );
    }
    this.scheduleAlarmSafetyNet();
    return Response.json(
      { message_id: entry.message_id, queue_position: position },
      { status: 202 }
    );
  }

  private async runQueueEntry(entry: QueueEntry): Promise<void> {
    const logger = createRequestLogger(crypto.randomUUID(), entry.user_id);
    const body = queueEntryToChatRequest(entry);
    const startTime = Date.now();

    logger.log('queue_processing_start', {
      message_id: entry.message_id,
      delivery: entry.delivery,
    });

    try {
      if (entry.delivery === 'sse') {
        await this.runQueueSSE(body, entry.message_id, logger, startTime);
      } else {
        await this.runQueueCallback(body, logger, startTime);
      }
    } catch (error) {
      logger.error('queue_processing_error', error, { message_id: entry.message_id });
      await this.handleQueueEntryError(entry, error);
    } finally {
      this.queueStreams.delete(entry.message_id);
    }
  }

  private async runQueueSSE(
    body: ChatRequest,
    messageId: string,
    logger: RequestLogger,
    startTime: number
  ): Promise<void> {
    const writer = this.queueStreams.get(messageId);
    if (!writer) return;
    const encoder = new TextEncoder();

    const sendEvent = async (event: SSEEvent): Promise<void> => {
      try {
        await writer.write(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
      } catch {
        // Client may have disconnected
      }
    };

    try {
      const response = await this.processChat(body, logger, buildSSECallbacks(sendEvent));
      logger.log('queue_sse_complete', {
        response_count: response.responses.length,
        duration_ms: Date.now() - startTime,
      });
      await sendEvent({ type: 'complete', response });
    } finally {
      try {
        await writer.close();
      } catch {
        // Writer may already be closed
      }
    }
  }

  private async runQueueCallback(
    body: ChatRequest,
    logger: RequestLogger,
    startTime: number
  ): Promise<void> {
    const callbacks = this.buildWebhookCallbacks(body);
    const response = await this.processChat(body, logger, callbacks);
    await callbacks?.onComplete?.(response);
    logger.log('queue_callback_complete', {
      response_count: response.responses.length,
      duration_ms: Date.now() - startTime,
    });
  }

  private async handleQueueEntryError(entry: QueueEntry, error: unknown): Promise<void> {
    const errorMessage = error instanceof Error ? error.message : String(error);
    const isTransient = /returned 5\d{2}|Network|timeout|ECONNREFUSED/.test(errorMessage);

    if (isTransient && entry.retry_count < DEFAULT_MAX_RETRIES) {
      await this.reEnqueueToFront({ ...entry, retry_count: entry.retry_count + 1 });
      return;
    }

    const writer = this.queueStreams.get(entry.message_id);
    if (!writer) return;
    try {
      const encoder = new TextEncoder();
      const event: SSEEvent = { type: 'error', error: errorMessage };
      await writer.write(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
      await writer.close();
    } catch {
      // Writer may already be closed
    }
  }

  private async drainQueueAndRelease(): Promise<void> {
    try {
      for (;;) {
        const next = await this.dequeueNext();
        if (!next) break;
        await this.runQueueEntry(next);
      }
    } finally {
      await this.releaseLock();
    }
  }

  private async enqueueToStorage(entry: QueueEntry): Promise<number> {
    return this.state.blockConcurrencyWhile(async () => {
      const queue = (await this.state.storage.get<QueueEntry[]>(QUEUE_STORAGE_KEY)) ?? [];
      if (queue.length >= DEFAULT_MAX_QUEUE_DEPTH) return -1;
      queue.push(entry);
      await this.state.storage.put(QUEUE_STORAGE_KEY, queue);
      return queue.length;
    });
  }

  private async dequeueNext(): Promise<QueueEntry | null> {
    return this.state.blockConcurrencyWhile(async () => {
      const queue = (await this.state.storage.get<QueueEntry[]>(QUEUE_STORAGE_KEY)) ?? [];
      if (queue.length === 0) return null;
      const next = queue.shift()!;
      await this.state.storage.put(QUEUE_STORAGE_KEY, queue);
      return next;
    });
  }

  private async reEnqueueToFront(entry: QueueEntry): Promise<void> {
    await this.state.blockConcurrencyWhile(async () => {
      const queue = (await this.state.storage.get<QueueEntry[]>(QUEUE_STORAGE_KEY)) ?? [];
      queue.unshift(entry);
      await this.state.storage.put(QUEUE_STORAGE_KEY, queue);
    });
  }

  private checkEnqueueRateLimit(): Response | null {
    const now = Date.now();
    const cutoff = now - ENQUEUE_RATE_WINDOW_MS;
    let expired = 0;
    while (expired < this.enqueueTimestamps.length) {
      if ((this.enqueueTimestamps.at(expired) ?? Infinity) > cutoff) break;
      expired++;
    }
    if (expired > 0) this.enqueueTimestamps.splice(0, expired);
    if (this.enqueueTimestamps.length >= ENQUEUE_RATE_LIMIT) {
      return Response.json(
        { error: 'Rate limit exceeded', code: 'RATE_LIMIT_EXCEEDED' },
        { status: 429, headers: { 'Retry-After': '10' } }
      );
    }
    this.enqueueTimestamps.push(now);
    return null;
  }

  private async handleQueueStatus(): Promise<Response> {
    const queue = (await this.state.storage.get<QueueEntry[]>(QUEUE_STORAGE_KEY)) ?? [];
    const lock = await this.state.storage.get<number>(PROCESSING_LOCK_KEY);
    return Response.json({ queue_length: queue.length, processing: lock != null });
  }

  private scheduleAlarmSafetyNet(): void {
    // Fire alarm after lock stale threshold to clear stuck state
    this.state.storage.setAlarm(Date.now() + LOCK_STALE_THRESHOLD_MS + 5000);
  }

  // ═══════════════════════════════════════════════
  // Direct chat (non-queue) handlers
  // ═══════════════════════════════════════════════

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
      if (lock && now - lock < LOCK_STALE_THRESHOLD_MS) return false;
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

  private async handleInitiateStreamWithLock(request: Request): Promise<Response> {
    const body = (await request.json()) as ChatRequest;
    const logger = createRequestLogger(crypto.randomUUID());
    const { readable, writable } = new TransformStream();
    const writer = writable.getWriter();
    const encoder = new TextEncoder();

    const sendEvent = async (event: SSEEvent): Promise<void> => {
      await writer.write(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
    };

    this.runInitiateStream(body, sendEvent, writer, logger).finally(() => this.releaseLock());
    return new Response(readable, { headers: SSE_HEADERS });
  }

  private async runInitiateStream(
    body: ChatRequest,
    sendEvent: (event: SSEEvent) => Promise<void>,
    writer: WritableStreamDefaultWriter<Uint8Array>,
    logger: RequestLogger
  ): Promise<void> {
    try {
      await this.doInitiateStream(body, sendEvent, logger);
    } catch (error) {
      logger.error('do_initiate_error', error);
      try {
        await sendEvent({
          type: 'error',
          error: error instanceof Error ? error.message : 'Unknown error',
        });
      } catch {
        // Writer may already be closed
      }
    } finally {
      try {
        await writer.close();
      } catch {
        // Writer may already be closed
      }
    }
  }

  private async doInitiateStream(
    body: ChatRequest,
    sendEvent: (event: SSEEvent) => Promise<void>,
    logger: RequestLogger
  ): Promise<void> {
    const [history, preferences] = await Promise.all([this.getHistory(), this.getPreferences()]);
    if (history.length > 0) {
      return this.streamCachedOpening(
        history[0]!.assistant_response,
        preferences.response_language,
        sendEvent
      );
    }
    return this.streamFreshOpening(body, preferences, sendEvent, logger);
  }

  private async streamCachedOpening(
    cached: string,
    responseLanguage: string,
    sendEvent: (event: SSEEvent) => Promise<void>
  ): Promise<void> {
    for (const word of cached.split(' ')) {
      await sendEvent({ type: 'progress', text: word + ' ' });
      await new Promise<void>((r) => setTimeout(r, 25));
    }
    await sendEvent({
      type: 'complete',
      response: {
        responses: [cached],
        response_language: responseLanguage,
        voice_audio_base64: null,
      },
    });
  }

  private async loadOrchestrationContext(org: string, logger: RequestLogger) {
    const [resolvedPromptValues, memoryCtx, mcpCatalog] = await Promise.all([
      this.resolvePrompts(org, logger),
      this.loadMemoryContext(logger),
      this.discoverMcpTools(org, logger),
    ]);
    return { resolvedPromptValues, ...memoryCtx, mcpCatalog };
  }

  private async streamFreshOpening(
    body: ChatRequest,
    preferences: UserPreferencesInternal,
    sendEvent: (event: SSEEvent) => Promise<void>,
    logger: RequestLogger
  ): Promise<void> {
    const org = resolveOrgFromBody(body, this.env.DEFAULT_ORG);
    const ctx = await this.loadOrchestrationContext(org, logger);

    const callbacks: StreamCallbacks = {
      onStatus: async (message) => sendEvent({ type: 'status', message }),
      onProgress: async (text) => sendEvent({ type: 'progress', text }),
      onComplete: async () => {},
      onError: async (error) => sendEvent({ type: 'error', error }),
    };

    const responses = await orchestrate(SYNTHETIC_CONVERSATION_TRIGGER, {
      env: this.env,
      org,
      isAdmin: body.is_admin ?? false,
      history: [],
      preferences: {
        response_language: preferences.response_language,
        first_interaction: preferences.first_interaction,
      },
      resolvedPromptValues: ctx.resolvedPromptValues,
      memoryStore: ctx.memoryStore,
      memoryTOC: ctx.formattedTOC,
      mcpCatalog: ctx.mcpCatalog,
      logger,
      callbacks,
    });

    const assistantResponse = responses.join('\n');
    await this.addHistoryEntry(
      { user_message: '', assistant_response: assistantResponse, timestamp: Date.now() },
      MAX_HISTORY_STORAGE
    );
    if (preferences.first_interaction) {
      await this.updatePreferences({ ...preferences, first_interaction: false });
    }
    await sendEvent({
      type: 'complete',
      response: {
        responses,
        response_language: preferences.response_language,
        voice_audio_base64: null,
      },
    });
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

    return new Response(readable, { headers: SSE_HEADERS });
  }

  // ═══════════════════════════════════════════════
  // User data endpoints (preferences, history, memory)
  // ═══════════════════════════════════════════════

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

  // ═══════════════════════════════════════════════
  // Core chat processing
  // ═══════════════════════════════════════════════

  private async processStreamingChat(
    body: ChatRequest,
    sendEvent: (event: SSEEvent) => Promise<void>,
    writer: WritableStreamDefaultWriter<Uint8Array>,
    logger: RequestLogger,
    startTime: number
  ): Promise<void> {
    try {
      const response = await this.processChat(body, logger, buildSSECallbacks(sendEvent));
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

  private async resolvePrompts(org: string, logger: RequestLogger) {
    const startTime = Date.now();
    let adminOverrides: PromptOverrides = {};
    try {
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

  private async discoverMcpTools(
    org: string,
    logger: RequestLogger
  ): Promise<ToolCatalog | undefined> {
    try {
      const servers = await getMcpServers(this.env.PROMPT_OVERRIDES, org);
      const enabled = servers.filter((s) => s.enabled).sort((a, b) => a.priority - b.priority);

      if (enabled.length === 0) return undefined;

      const manifests = await discoverAllTools(enabled, logger);
      const builtinNames = getBuiltinToolNames();
      return buildToolCatalog(manifests, enabled, logger, builtinNames);
    } catch (error) {
      logger.error('mcp_discovery_pipeline_error', error);
      return undefined;
    }
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
    const ctx = await this.loadOrchestrationContext(org, logger);

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
      resolvedPromptValues: ctx.resolvedPromptValues,
      memoryStore: ctx.memoryStore,
      memoryTOC: ctx.formattedTOC,
      mcpCatalog: ctx.mcpCatalog,
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

  // ═══════════════════════════════════════════════
  // Storage helpers
  // ═══════════════════════════════════════════════

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

// --- Shared helpers ---

function buildSSECallbacks(sendEvent: (event: SSEEvent) => Promise<void>): StreamCallbacks {
  return {
    onStatus: async (message) => sendEvent({ type: 'status', message }),
    onProgress: async (text) => sendEvent({ type: 'progress', text }),
    onComplete: async (response) => sendEvent({ type: 'complete', response }),
    onError: async (error) => sendEvent({ type: 'error', error }),
    onToolUse: async (tool, input) => sendEvent({ type: 'tool_use', tool, input }),
    onToolResult: async (tool, result) => sendEvent({ type: 'tool_result', tool, result }),
  };
}
