export interface Env {
  // Environment variables
  ENVIRONMENT: string;
  MAX_ORCHESTRATION_ITERATIONS: string;
  DEFAULT_ORG: string;

  // Claude configuration (optional - has defaults)
  CLAUDE_MODEL?: string;

  // Secrets (set via wrangler secret put)
  ANTHROPIC_API_KEY: string;
  BARUCH_API_KEY: string;
  // Optional: admin calls fail cleanly (AdminApiConfigError) when neither
  // this nor ADMIN_API_KEY is set.
  ENGINE_API_KEY?: string;
  // Optional dedicated key for bt-servant-worker's admin API. Falls back to
  // ENGINE_API_KEY when unset or blank; read it via resolveAdminApiKey()
  // in ./admin-api-key.ts.
  ADMIN_API_KEY?: string;
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
