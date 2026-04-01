/**
 * Types for the queue logic in UserDO.
 *
 * The queue is an internal FIFO within the unified UserDO,
 * serializing requests per-user when the DO is already busy.
 */

import { ProgressMode } from './engine.js';

/**
 * Entry in the queue awaiting processing.
 * Contains everything needed to process the chat request.
 */
export interface QueueEntry {
  message_id: string;
  user_id: string;
  client_id: string;
  message: string;
  message_type: 'text' | 'audio';
  audio_base64?: string | undefined;
  audio_format?: string | undefined;
  progress_callback_url?: string | undefined;
  progress_throttle_seconds?: number | undefined;
  progress_mode?: ProgressMode | undefined;
  message_key?: string | undefined;
  org: string;
  is_admin: boolean;
  enqueued_at: number;
  /** Delivery mode: 'callback' for webhook, 'sse' for streaming */
  delivery: 'callback' | 'sse';
  /** Number of times this entry has been retried after transient failures */
  retry_count: number;
}
