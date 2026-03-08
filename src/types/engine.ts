/**
 * API contract types for Baruch
 */

/**
 * Progress mode for webhook callbacks.
 * - 'complete': Legacy behavior - only send on completion
 * - 'iteration': Send after each orchestration iteration (default)
 * - 'periodic': Send accumulated text every N seconds
 * - 'sentence': Send after each complete sentence
 */
export type ProgressMode = 'complete' | 'iteration' | 'periodic' | 'sentence';

export interface ChatRequest {
  client_id: string;
  user_id: string;
  message: string;
  message_type: 'text' | 'audio';
  audio_base64?: string;
  audio_format?: string;
  progress_callback_url?: string;
  progress_throttle_seconds?: number;
  progress_mode?: ProgressMode;
  message_key?: string;
  org?: string;
  org_id?: string;
}

export interface ChatResponse {
  responses: string[];
  response_language: string;
  voice_audio_base64: string | null;
}

export interface ChatHistoryEntry {
  user_message: string;
  assistant_response: string;
  timestamp: number;
  created_at?: string | null;
}

export interface ChatHistoryResponse {
  user_id: string;
  entries: ChatHistoryEntry[];
  total_count: number;
  limit: number;
  offset: number;
}

export interface UserPreferencesInternal {
  response_language: string;
  first_interaction: boolean;
}

export interface UserPreferencesAPI {
  response_language?: string | null;
}

export interface UpdatePreferencesRequest {
  response_language?: string;
}

export type SSEEventType =
  | 'status'
  | 'progress'
  | 'complete'
  | 'error'
  | 'tool_use'
  | 'tool_result';

export interface SSEStatusEvent {
  type: 'status';
  message: string;
}

export interface SSEProgressEvent {
  type: 'progress';
  text: string;
}

export interface SSECompleteEvent {
  type: 'complete';
  response: ChatResponse;
}

export interface SSEErrorEvent {
  type: 'error';
  error: string;
}

export interface SSEToolUseEvent {
  type: 'tool_use';
  tool: string;
  input: unknown;
}

export interface SSEToolResultEvent {
  type: 'tool_result';
  tool: string;
  result: unknown;
}

export type SSEEvent =
  | SSEStatusEvent
  | SSEProgressEvent
  | SSECompleteEvent
  | SSEErrorEvent
  | SSEToolUseEvent
  | SSEToolResultEvent;

export interface StreamCallbacks {
  onStatus: (message: string) => void;
  onProgress: (text: string) => void;
  onComplete: (response: ChatResponse) => void;
  onError: (error: string) => void;
  onToolUse?: (toolName: string, input: unknown) => void;
  onToolResult?: (toolName: string, result: unknown) => void;
  onIterationComplete?: (text: string) => void;
}

export interface ProgressCallback {
  user_id: string;
  message_key: string;
  text: string;
  timestamp: number;
}

export interface ApiError {
  error: string;
  code: string;
  message: string;
}

export interface ConcurrentRequestError extends ApiError {
  code: 'CONCURRENT_REQUEST_REJECTED';
  retry_after_ms: number;
}

export interface ValidationErrorResponse extends ApiError {
  code: 'VALIDATION_ERROR';
}

export interface InternalErrorResponse extends ApiError {
  code: 'INTERNAL_ERROR';
}
