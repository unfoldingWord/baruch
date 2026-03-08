/**
 * Types for the UserQueue Durable Object
 *
 * The UserQueue sits between the worker router and UserSession,
 * serializing requests per-user via an alarm-based processing loop.
 */

import { ProgressMode } from './engine.js';

/**
 * Entry in the queue awaiting processing.
 * Contains everything needed to forward the request to UserSession.
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
  enqueued_at: number;
  /** Delivery mode: 'callback' for webhook, 'sse' for streaming */
  delivery: 'callback' | 'sse';
  /** Number of times this entry has been retried after transient failures */
  retry_count: number;
}

/**
 * Stored response for late-connecting SSE clients.
 */
export interface StoredResponse {
  message_id: string;
  events: StoredSSEEvent[];
  stored_at: number;
}

export interface StoredSSEEvent {
  event: string;
  data: string;
}

/**
 * Metadata for the chunked incremental event store.
 */
export interface EventStoreMetadata {
  message_id: string;
  event_count: number;
  done: boolean;
  created_at: number;
}

export interface PollResponse {
  message_id: string;
  events: StoredSSEEvent[];
  done: boolean;
  cursor: number;
}

export interface EnqueueResponse {
  message_id: string;
  queue_position: number;
}

export interface QueueStatusResponse {
  queue_length: number;
  processing: boolean;
  stored_response_count: number;
}
