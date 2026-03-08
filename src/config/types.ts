export interface Env {
  // Environment variables
  ENVIRONMENT: string;
  MAX_ORCHESTRATION_ITERATIONS: string;
  DEFAULT_ORG: string;

  // Claude configuration (optional - has defaults)
  CLAUDE_MODEL?: string;
  CLAUDE_MAX_TOKENS?: string;

  // Queue configuration (optional - has defaults)
  MAX_QUEUE_DEPTH?: string;
  QUEUE_STORED_RESPONSE_TTL_MS?: string;
  QUEUE_MAX_RETRIES?: string;

  // Secrets (set via wrangler secret put)
  ANTHROPIC_API_KEY: string;
  API_KEY: string;
  ENGINE_API_KEY: string;
  ENGINE_BASE_URL: string;

  // KV Namespaces
  PROMPT_OVERRIDES: KVNamespace;

  // Durable Object bindings
  USER_SESSION: DurableObjectNamespace;
  USER_QUEUE: DurableObjectNamespace;
}

export interface RequestContext {
  requestId: string;
  userId: string;
  clientId: string;
  env: Env;
}
