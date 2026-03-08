import type { Env } from '../../src/config/types.js';

declare module 'cloudflare:test' {
  // eslint-disable-next-line @typescript-eslint/no-empty-object-type -- required by @cloudflare/vitest-pool-workers
  interface ProvidedEnv extends Env {}
}
