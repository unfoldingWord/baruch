export interface Env {
  // Environment variables
  ENVIRONMENT: string;
  MAX_ORCHESTRATION_ITERATIONS: string;
  DEFAULT_ORG: string;

  // Claude configuration (optional - has defaults)
  CLAUDE_MODEL?: string;
  CLAUDE_MAX_TOKENS?: string;

  // Secrets (set via wrangler secret put)
  ANTHROPIC_API_KEY: string;
  BARUCH_API_KEY: string;
  ENGINE_API_KEY: string;
  ENGINE_BASE_URL: string;

  // KV Namespaces
  PROMPT_OVERRIDES: KVNamespace;

  // Durable Object bindings
  USER_DO: DurableObjectNamespace;
}

export interface RequestContext {
  requestId: string;
  userId: string;
  clientId: string;
  env: Env;
}
