import { defineWorkersConfig } from '@cloudflare/vitest-pool-workers/config';
import { readFileSync, existsSync } from 'fs';
import { platform } from 'os';

// Windows has issues with workerd's SQLite Durable Objects storage
const isWindows = platform() === 'win32';

if (isWindows) {
  console.warn(
    '\n⚠️  Skipping e2e tests on Windows (SQLite/workerd incompatibility)\n' +
      '   These tests run in CI on Linux.\n'
  );
}

function getAnthropicKey(): string {
  if (process.env.ANTHROPIC_API_KEY) {
    return process.env.ANTHROPIC_API_KEY;
  }
  if (existsSync('.dev.vars')) {
    const content = readFileSync('.dev.vars', 'utf-8');
    const match = content.match(/^ANTHROPIC_API_KEY=(.+)$/m);
    if (match) {
      process.env.ANTHROPIC_API_KEY = match[1];
      return match[1];
    }
  }
  return '';
}

const anthropicKey = getAnthropicKey();

export default defineWorkersConfig({
  test: {
    globals: true,
    poolOptions: {
      workers: {
        wrangler: { configPath: './wrangler.toml' },
        miniflare: {
          bindings: {
            ENVIRONMENT: 'test',
            MAX_ORCHESTRATION_ITERATIONS: '10',
            DEFAULT_ORG: 'unfoldingWord',
            API_KEY: 'test-api-key',
            ENGINE_API_KEY: 'test-engine-api-key',
            ENGINE_BASE_URL: 'https://staging-api.btservant.ai',
            ANTHROPIC_API_KEY: anthropicKey,
          },
          kvNamespaces: ['PROMPT_OVERRIDES'],
        },
        isolatedStorage: false,
      },
    },
    include: ['tests/**/*.test.ts'],
    exclude: isWindows ? ['tests/e2e/**'] : [],
    testTimeout: 30000,
  },
});
