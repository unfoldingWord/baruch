/**
 * Baruch worker entry point
 *
 * Routes requests to Durable Objects for per-user serialization.
 * No admin endpoints — Baruch itself IS the admin interface (via Claude tools).
 */

import { Hono } from 'hono';
import { Env } from './config/types.js';
import { APP_VERSION } from './generated/version.js';
import { UserQueue, UserSession } from './durable-objects/index.js';
import { ChatRequest } from './types/engine.js';
import { DO_BASE_URL } from './config/constants.js';
import { constantTimeCompare } from './utils/crypto.js';
import { createRequestLogger } from './utils/logger.js';
import { resolveOrgFromBody, resolveOrgFromParams } from './utils/org.js';

export { UserQueue, UserSession };

const app = new Hono<{ Bindings: Env }>();

// Health check - no auth required
app.get('/health', (c) => c.json({ status: 'healthy', version: APP_VERSION }));

// Auth middleware for all /api routes
app.use('/api/*', async (c, next) => {
  const authHeader = c.req.header('Authorization');

  if (!authHeader?.startsWith('Bearer ')) {
    return c.json({ error: 'Authorization header with Bearer token required' }, 401);
  }

  const token = authHeader.slice(7);
  if (!constantTimeCompare(token, c.env.BARUCH_API_KEY)) {
    return c.json({ error: 'Invalid API key' }, 403);
  }

  return next();
});

// Chat endpoints
app.post('/api/v1/chat', async (c) => {
  return handleChatRequest(c.req.raw, c.env, '/chat');
});

app.post('/api/v1/chat/stream', async (c) => {
  return handleChatRequest(c.req.raw, c.env, '/stream');
});

// Queue endpoints (UserQueue DO)
app.post('/api/v1/chat/queue', async (c) => {
  return handleMessageEnqueue(c.req.raw, c.env);
});

app.get('/api/v1/chat/queue/stream', async (c) => {
  return handleQueueStream(c.req.raw, c.env);
});

app.get('/api/v1/chat/queue/poll', async (c) => {
  return handleQueuePoll(c.req.raw, c.env);
});

app.get('/api/v1/chat/queue/:userId', async (c) => {
  return handleQueueStatus(c.req.raw, c.env, c.req.param('userId'));
});

// User endpoints
app.get('/api/v1/orgs/:org/users/:userId/preferences', async (c) => {
  return handleUserRequest(
    c.req.raw,
    c.env,
    c.req.param('org'),
    c.req.param('userId'),
    '/preferences'
  );
});

app.put('/api/v1/orgs/:org/users/:userId/preferences', async (c) => {
  return handleUserRequest(
    c.req.raw,
    c.env,
    c.req.param('org'),
    c.req.param('userId'),
    '/preferences'
  );
});

app.get('/api/v1/orgs/:org/users/:userId/history', async (c) => {
  return handleUserRequest(c.req.raw, c.env, c.req.param('org'), c.req.param('userId'), '/history');
});

app.delete('/api/v1/orgs/:org/users/:userId/history', async (c) => {
  return handleUserRequest(c.req.raw, c.env, c.req.param('org'), c.req.param('userId'), '/history');
});

app.get('/api/v1/orgs/:org/users/:userId/memory', async (c) => {
  return handleUserRequest(c.req.raw, c.env, c.req.param('org'), c.req.param('userId'), '/memory');
});

app.delete('/api/v1/orgs/:org/users/:userId/memory', async (c) => {
  return handleUserRequest(c.req.raw, c.env, c.req.param('org'), c.req.param('userId'), '/memory');
});

export default app;

/**
 * Handle chat requests — route to user-scoped DO
 */
async function handleChatRequest(request: Request, env: Env, doPath: string): Promise<Response> {
  const requestId = crypto.randomUUID();
  const logger = createRequestLogger(requestId);

  try {
    const body = (await request.clone().json()) as ChatRequest;

    if (!body.user_id) {
      return Response.json({ error: 'user_id is required' }, { status: 400 });
    }
    if (!body.client_id) {
      return Response.json({ error: 'client_id is required' }, { status: 400 });
    }

    const org = resolveOrgFromBody(body, env.DEFAULT_ORG);
    logger.log('request_received', {
      user_id: body.user_id,
      client_id: body.client_id,
      org,
      path: doPath,
    });

    const doId = env.USER_SESSION.idFromName(`user:${org}:${body.user_id}`);
    const stub = env.USER_SESSION.get(doId);

    const doUrl = new URL(request.url);
    doUrl.pathname = doPath;

    const doRequest = new Request(doUrl.toString(), {
      method: 'POST',
      headers: request.headers,
      body: JSON.stringify(body),
    });

    return stub.fetch(doRequest);
  } catch (error) {
    logger.error('request_error', error);
    if (error instanceof SyntaxError) {
      return Response.json({ error: 'Invalid JSON body' }, { status: 400 });
    }
    return Response.json({ error: 'Internal server error' }, { status: 500 });
  }
}

/**
 * Handle user requests (preferences, history, memory)
 */
async function handleUserRequest(
  request: Request,
  env: Env,
  org: string,
  userId: string,
  doPath: string
): Promise<Response> {
  const requestId = crypto.randomUUID();
  const logger = createRequestLogger(requestId, userId);

  if (!org) {
    return Response.json({ error: 'org is required in path' }, { status: 400 });
  }
  if (!userId) {
    return Response.json({ error: 'user_id is required in path' }, { status: 400 });
  }

  logger.log('user_request_received', {
    user_id: userId,
    org,
    path: doPath,
    method: request.method,
  });

  const doId = env.USER_SESSION.idFromName(`user:${org}:${userId}`);
  const stub = env.USER_SESSION.get(doId);

  const doUrl = new URL(request.url);
  doUrl.pathname = doPath;
  if (doPath === '/history') {
    doUrl.searchParams.set('user_id', userId);
  }

  const doRequest = new Request(doUrl.toString(), {
    method: request.method,
    headers: request.headers,
    body: request.method !== 'GET' ? request.body : null,
  });

  return stub.fetch(doRequest);
}

/**
 * Handle message enqueue (POST /api/v1/chat/queue)
 */
async function handleMessageEnqueue(request: Request, env: Env): Promise<Response> {
  const requestId = crypto.randomUUID();
  const logger = createRequestLogger(requestId);

  try {
    const body = (await request.clone().json()) as ChatRequest;

    if (!body.user_id) {
      return Response.json({ error: 'user_id is required' }, { status: 400 });
    }

    const org = resolveOrgFromBody(body, env.DEFAULT_ORG);
    logger.log('message_enqueue_received', { user_id: body.user_id, org });

    const delivery = body.progress_callback_url ? 'callback' : 'sse';

    const doId = env.USER_QUEUE.idFromName(`queue:${org}:${body.user_id}`);
    const stub = env.USER_QUEUE.get(doId);

    const doRequest = new Request(`${DO_BASE_URL}/enqueue`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...body, org, delivery }),
    });

    return stub.fetch(doRequest);
  } catch (error) {
    logger.error('message_enqueue_error', error);
    if (error instanceof SyntaxError) {
      return Response.json({ error: 'Invalid JSON body' }, { status: 400 });
    }
    return Response.json({ error: 'Internal server error' }, { status: 500 });
  }
}

/**
 * Handle queue stream (GET /api/v1/chat/queue/stream)
 */
async function handleQueueStream(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const userId = url.searchParams.get('user_id');
  const messageId = url.searchParams.get('message_id');
  const org = resolveOrgFromParams(url.searchParams, env.DEFAULT_ORG);

  if (!userId) {
    return Response.json({ error: 'user_id query parameter is required' }, { status: 400 });
  }
  if (!messageId) {
    return Response.json({ error: 'message_id query parameter is required' }, { status: 400 });
  }

  const doId = env.USER_QUEUE.idFromName(`queue:${org}:${userId}`);
  const stub = env.USER_QUEUE.get(doId);

  const doUrl = new URL(`${DO_BASE_URL}/stream`);
  doUrl.searchParams.set('message_id', messageId);

  return stub.fetch(new Request(doUrl.toString()));
}

/**
 * Handle poll for incremental events (GET /api/v1/chat/queue/poll)
 */
async function handleQueuePoll(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const userId = url.searchParams.get('user_id');
  const messageId = url.searchParams.get('message_id');
  const org = resolveOrgFromParams(url.searchParams, env.DEFAULT_ORG);
  const cursor = url.searchParams.get('cursor') ?? '0';

  if (!userId) {
    return Response.json({ error: 'user_id query parameter is required' }, { status: 400 });
  }
  if (!messageId) {
    return Response.json({ error: 'message_id query parameter is required' }, { status: 400 });
  }

  const doId = env.USER_QUEUE.idFromName(`queue:${org}:${userId}`);
  const stub = env.USER_QUEUE.get(doId);

  const doUrl = new URL(`${DO_BASE_URL}/poll`);
  doUrl.searchParams.set('message_id', messageId);
  doUrl.searchParams.set('cursor', cursor);

  return stub.fetch(new Request(doUrl.toString()));
}

/**
 * Handle queue status (GET /api/v1/chat/queue/:userId)
 */
async function handleQueueStatus(_request: Request, env: Env, userId: string): Promise<Response> {
  if (!userId) {
    return Response.json({ error: 'userId is required in path' }, { status: 400 });
  }

  const doId = env.USER_QUEUE.idFromName(`queue:${env.DEFAULT_ORG}:${userId}`);
  const stub = env.USER_QUEUE.get(doId);

  return stub.fetch(new Request(`${DO_BASE_URL}/status`));
}
