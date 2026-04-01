/**
 * Baruch worker entry point
 *
 * Routes requests to the UserDO Durable Object for per-user serialization.
 * No admin endpoints — Baruch itself IS the admin interface (via Claude tools).
 */

import { Hono } from 'hono';
import { Env } from './config/types.js';
import { APP_VERSION } from './generated/version.js';
import { UserDO } from './durable-objects/index.js';
import { ChatRequest } from './types/engine.js';
import { DO_BASE_URL } from './config/constants.js';
import { constantTimeCompare } from './utils/crypto.js';
import { createRequestLogger } from './utils/logger.js';
import { resolveOrgFromBody } from './utils/org.js';

export { UserDO };

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

// Chat endpoints — route to UserDO
app.post('/api/v1/chat', async (c) => {
  return handleChatRequest(c.req.raw, c.env, '/chat');
});

app.post('/api/v1/chat/stream', async (c) => {
  return handleChatRequest(c.req.raw, c.env, '/stream');
});

app.post('/api/v1/chat/initiate', async (c) => {
  return handleChatRequest(c.req.raw, c.env, '/initiate');
});

// Queue endpoints — route to the same UserDO (unified)
app.post('/api/v1/chat/queue', async (c) => {
  return handleMessageEnqueue(c.req.raw, c.env);
});

app.get('/api/v1/chat/queue/:userId', async (c) => {
  return handleQueueStatus(c.req.raw, c.env, c.req.param('userId'), c.req.query('org'));
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

    const doId = env.USER_DO.idFromName(`user:${org}:${body.user_id}`);
    const stub = env.USER_DO.get(doId);

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

  const doId = env.USER_DO.idFromName(`user:${org}:${userId}`);
  const stub = env.USER_DO.get(doId);

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
 * Handle message enqueue — route to the same UserDO (no separate queue DO)
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

    // Route to the SAME UserDO that handles chat — no separate queue DO
    const doId = env.USER_DO.idFromName(`user:${org}:${body.user_id}`);
    const stub = env.USER_DO.get(doId);

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
 * Handle queue status
 */
async function handleQueueStatus(
  _request: Request,
  env: Env,
  userId: string,
  orgParam: string | undefined
): Promise<Response> {
  if (!userId) {
    return Response.json({ error: 'userId is required in path' }, { status: 400 });
  }

  const org = orgParam || env.DEFAULT_ORG;
  const doId = env.USER_DO.idFromName(`user:${org}:${userId}`);
  const stub = env.USER_DO.get(doId);

  return stub.fetch(new Request(`${DO_BASE_URL}/status`));
}
