import { describe, it, expect } from 'vitest';
import {
  createHealthTracker,
  recordSuccess,
  recordFailure,
  isServerHealthy,
  getHealthSummary,
  getServerMetrics,
  CONSECUTIVE_FAILURE_THRESHOLD,
} from '../../src/services/mcp/health.js';

describe('createHealthTracker', () => {
  it('creates tracker with empty servers map', () => {
    const tracker = createHealthTracker();
    expect(tracker.servers.size).toBe(0);
  });
});

describe('recordSuccess', () => {
  it('creates metrics for new server', () => {
    const tracker = createHealthTracker();
    recordSuccess(tracker, 'server-1', 100);
    const metrics = getServerMetrics(tracker, 'server-1');
    expect(metrics).toBeDefined();
    expect(metrics!.totalCalls).toBe(1);
    expect(metrics!.totalResponseTimeMs).toBe(100);
    expect(metrics!.consecutiveFailures).toBe(0);
  });

  it('resets consecutive failures on success', () => {
    const tracker = createHealthTracker();
    recordFailure(tracker, 'server-1', 'error');
    recordFailure(tracker, 'server-1', 'error');
    recordSuccess(tracker, 'server-1', 50);
    expect(getServerMetrics(tracker, 'server-1')!.consecutiveFailures).toBe(0);
  });
});

describe('recordFailure', () => {
  it('increments failure counters', () => {
    const tracker = createHealthTracker();
    recordFailure(tracker, 'server-1', new Error('timeout'));
    const metrics = getServerMetrics(tracker, 'server-1')!;
    expect(metrics.totalCalls).toBe(1);
    expect(metrics.failedCalls).toBe(1);
    expect(metrics.consecutiveFailures).toBe(1);
    expect(metrics.lastError).toBe('timeout');
  });

  it('accepts string error', () => {
    const tracker = createHealthTracker();
    recordFailure(tracker, 'server-1', 'connection refused');
    expect(getServerMetrics(tracker, 'server-1')!.lastError).toBe('connection refused');
  });
});

describe('isServerHealthy', () => {
  it('returns true for unknown servers', () => {
    const tracker = createHealthTracker();
    expect(isServerHealthy(tracker, 'unknown')).toBe(true);
  });

  it('returns true below failure threshold', () => {
    const tracker = createHealthTracker();
    for (let i = 0; i < CONSECUTIVE_FAILURE_THRESHOLD - 1; i++) {
      recordFailure(tracker, 'server-1', 'error');
    }
    expect(isServerHealthy(tracker, 'server-1')).toBe(true);
  });

  it('returns false at failure threshold', () => {
    const tracker = createHealthTracker();
    for (let i = 0; i < CONSECUTIVE_FAILURE_THRESHOLD; i++) {
      recordFailure(tracker, 'server-1', 'error');
    }
    expect(isServerHealthy(tracker, 'server-1')).toBe(false);
  });

  it('returns true after recovery', () => {
    const tracker = createHealthTracker();
    for (let i = 0; i < CONSECUTIVE_FAILURE_THRESHOLD; i++) {
      recordFailure(tracker, 'server-1', 'error');
    }
    expect(isServerHealthy(tracker, 'server-1')).toBe(false);
    recordSuccess(tracker, 'server-1', 50);
    expect(isServerHealthy(tracker, 'server-1')).toBe(true);
  });
});

describe('getHealthSummary', () => {
  it('returns empty array for no servers', () => {
    expect(getHealthSummary(createHealthTracker())).toEqual([]);
  });

  it('calculates failure rate and average response time', () => {
    const tracker = createHealthTracker();
    recordSuccess(tracker, 'server-1', 100);
    recordSuccess(tracker, 'server-1', 200);
    recordFailure(tracker, 'server-1', 'error');

    const [summary] = getHealthSummary(tracker);
    expect(summary!.totalCalls).toBe(3);
    expect(summary!.failureRate).toBeCloseTo(1 / 3);
    expect(summary!.averageResponseTimeMs).toBe(150);
    expect(summary!.healthy).toBe(true);
  });
});
