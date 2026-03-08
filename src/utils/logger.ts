/**
 * Structured JSON logging for Cloudflare Workers Logs
 *
 * Uses console.error for log/info levels intentionally: Cloudflare Workers Logs
 * only captures console.error and console.warn in the dashboard. console.log
 * output is not visible in production logs.
 */

interface LogEntry {
  event: string;
  request_id: string;
  timestamp: number;
  user_id?: string;
  [key: string]: unknown;
}

function buildEntry(
  requestId: string,
  userId: string | undefined,
  event: string,
  data: Record<string, unknown>
): string {
  const entry: LogEntry = {
    event,
    request_id: requestId,
    timestamp: Date.now(),
    ...data,
  };
  if (userId) entry.user_id = userId;
  return JSON.stringify(entry);
}

function extractErrorFields(error: unknown): Record<string, unknown> {
  if (error instanceof Error) {
    return { message: error.message, stack: error.stack };
  }
  return { message: String(error) };
}

export function createRequestLogger(requestId: string, userId?: string) {
  return {
    log: (event: string, data: Record<string, unknown> = {}) => {
      console.error(buildEntry(requestId, userId, event, data));
    },
    info: (event: string, data: Record<string, unknown> = {}) => {
      console.error(buildEntry(requestId, userId, event, data));
    },
    warn: (event: string, data: Record<string, unknown> = {}) => {
      console.warn(buildEntry(requestId, userId, event, data));
    },
    error: (event: string, error: unknown, extra: Record<string, unknown> = {}) => {
      console.error(
        buildEntry(requestId, userId, event, { ...extractErrorFields(error), ...extra })
      );
    },
  };
}
export type RequestLogger = ReturnType<typeof createRequestLogger>;
