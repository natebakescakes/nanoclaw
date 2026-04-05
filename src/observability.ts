import { createHash, randomUUID } from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';

import {
  OBSERVABILITY_API_TOKEN,
  OBSERVABILITY_DIR,
  OBSERVABILITY_ENABLED,
  OBSERVABILITY_FLUSH_INTERVAL_MS,
  OBSERVABILITY_INSTANCE_ID,
  OBSERVABILITY_MAX_BATCH_EVENTS,
  OBSERVABILITY_SYNC_URL,
} from './config.js';
import { logger } from './logger.js';
import { ToolRuntimeStatus } from './types.js';

export const OBSERVABILITY_EVENT_VERSION = '1';

export type ObservabilityEventType =
  | 'agent.claim.auth_issue'
  | 'container.completed'
  | 'container.failed'
  | 'container.started'
  | 'container.timeout'
  | 'message.inbound'
  | 'message.outbound'
  | 'run.completed'
  | 'run.failed'
  | 'run.started'
  | 'session.created'
  | 'session.resumed'
  | 'sync.batch.failed'
  | 'sync.batch.succeeded'
  | 'task.completed'
  | 'task.failed'
  | 'task.started'
  | 'tool.auth_contradiction_detected'
  | 'tool.call.failed'
  | 'tool.call.started'
  | 'tool.call.succeeded'
  | 'tool.runtime_status';

export interface RedactedText {
  preview: string;
  hash: string;
  length: number;
}

export interface ObservabilityEvent {
  eventVersion: string;
  instanceId: string;
  eventId: string;
  eventType: ObservabilityEventType;
  occurredAt: string;
  severity: 'debug' | 'info' | 'warn' | 'error';
  runId?: string;
  groupFolder?: string;
  chatJid?: string;
  sessionIdBefore?: string;
  sessionIdAfter?: string;
  containerName?: string;
  payload: Record<string, unknown>;
  redactionMeta?: {
    redactedFields?: string[];
    hashedFields?: string[];
  };
}

export interface ObservabilityBatch {
  batchId: string;
  instanceId: string;
  createdAt: string;
  reason: string;
  events: ObservabilityEvent[];
}

export interface ObservabilityManagerOptions {
  enabled?: boolean;
  directory?: string;
  instanceId?: string;
  flushIntervalMs?: number;
  maxBatchEvents?: number;
  syncUrl?: string;
  apiToken?: string;
}

export interface EmitObservabilityEventInput {
  eventType: ObservabilityEventType;
  severity?: ObservabilityEvent['severity'];
  occurredAt?: string;
  runId?: string;
  groupFolder?: string;
  chatJid?: string;
  sessionIdBefore?: string;
  sessionIdAfter?: string;
  containerName?: string;
  payload?: Record<string, unknown>;
  redactionMeta?: ObservabilityEvent['redactionMeta'];
}

export interface EmitObservabilityOptions {
  flushImmediately?: boolean;
  syncImmediately?: boolean;
}

const AUTH_ISSUE_PATTERNS = [
  /\btoken\b[\s\S]{0,40}\bexpired\b/i,
  /\bexpired\b[\s\S]{0,40}\btoken\b/i,
  /\bre-?auth/i,
  /\bre-?authenticate/i,
  /\bauth(?:entication)?\b[\s\S]{0,40}\b(failed|expired|invalid|required)\b/i,
  /\bcredential(?:s)?\b[\s\S]{0,40}\b(expired|invalid|required|missing)\b/i,
  /\bunauthori[sz]ed\b/i,
  /\bforbidden\b/i,
];

export class ObservabilityManager {
  private readonly enabled: boolean;
  private readonly directory: string;
  private readonly instanceId: string;
  private readonly flushIntervalMs: number;
  private readonly maxBatchEvents: number;
  private readonly syncUrl: string;
  private readonly apiToken: string;
  private readonly archiveDir: string;
  private readonly pendingDir: string;
  private buffer: ObservabilityEvent[] = [];
  private flushTimer: ReturnType<typeof setInterval> | null = null;
  private syncInFlight = false;

  constructor(options: ObservabilityManagerOptions = {}) {
    this.enabled = options.enabled ?? OBSERVABILITY_ENABLED;
    this.directory = options.directory ?? OBSERVABILITY_DIR;
    this.instanceId = options.instanceId ?? OBSERVABILITY_INSTANCE_ID;
    this.flushIntervalMs =
      options.flushIntervalMs ?? OBSERVABILITY_FLUSH_INTERVAL_MS;
    this.maxBatchEvents =
      options.maxBatchEvents ?? OBSERVABILITY_MAX_BATCH_EVENTS;
    this.syncUrl = options.syncUrl ?? OBSERVABILITY_SYNC_URL;
    this.apiToken = options.apiToken ?? OBSERVABILITY_API_TOKEN;
    this.archiveDir = path.join(this.directory, 'archive');
    this.pendingDir = path.join(this.directory, 'pending');
  }

  start(): void {
    if (!this.enabled) return;
    fs.mkdirSync(this.archiveDir, { recursive: true });
    fs.mkdirSync(this.pendingDir, { recursive: true });
    if (this.flushTimer) return;

    this.flushTimer = setInterval(() => {
      void this.flush('interval');
    }, this.flushIntervalMs);

    void this.syncPendingBatches();
  }

  async stop(): Promise<void> {
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }
    await this.flush('shutdown');
  }

  emit(
    input: EmitObservabilityEventInput,
    options: EmitObservabilityOptions = {},
  ): ObservabilityEvent {
    const event: ObservabilityEvent = {
      eventVersion: OBSERVABILITY_EVENT_VERSION,
      instanceId: this.instanceId,
      eventId: randomUUID(),
      eventType: input.eventType,
      occurredAt: input.occurredAt || new Date().toISOString(),
      severity: input.severity || 'info',
      runId: input.runId,
      groupFolder: input.groupFolder,
      chatJid: input.chatJid,
      sessionIdBefore: input.sessionIdBefore,
      sessionIdAfter: input.sessionIdAfter,
      containerName: input.containerName,
      payload: input.payload || {},
      redactionMeta: input.redactionMeta,
    };

    if (!this.enabled) return event;

    this.appendToArchive(event);
    this.buffer.push(event);

    if (this.buffer.length >= this.maxBatchEvents || options.flushImmediately) {
      void this.flush(options.flushImmediately ? 'immediate' : 'size');
    }
    if (options.syncImmediately) {
      void this.flush('immediate-sync').then(() => this.syncPendingBatches());
    }

    return event;
  }

  async flush(reason: string): Promise<void> {
    if (!this.enabled || this.buffer.length === 0) return;

    const batch: ObservabilityBatch = {
      batchId: randomUUID(),
      instanceId: this.instanceId,
      createdAt: new Date().toISOString(),
      reason,
      events: [...this.buffer],
    };
    this.buffer = [];

    const filename = `${batch.createdAt.replace(/[:.]/g, '-')}-${batch.batchId}.json`;
    fs.writeFileSync(
      path.join(this.pendingDir, filename),
      JSON.stringify(batch, null, 2) + '\n',
    );

    if (this.syncUrl) {
      await this.syncPendingBatches();
    }
  }

  async syncPendingBatches(): Promise<void> {
    if (!this.enabled || !this.syncUrl || this.syncInFlight) return;
    this.syncInFlight = true;

    try {
      const files = fs
        .readdirSync(this.pendingDir)
        .filter((file) => file.endsWith('.json'))
        .sort();

      for (const file of files) {
        const fullPath = path.join(this.pendingDir, file);
        const batch = JSON.parse(
          fs.readFileSync(fullPath, 'utf-8'),
        ) as ObservabilityBatch;

        const headers: Record<string, string> = {
          'content-type': 'application/json',
          'x-nanoclaw-instance-id': this.instanceId,
        };
        if (this.apiToken) {
          headers.authorization = `Bearer ${this.apiToken}`;
        }

        const response = await fetch(this.syncUrl, {
          method: 'POST',
          headers,
          body: JSON.stringify(batch),
        });

        if (!response.ok) {
          logger.warn(
            {
              status: response.status,
              statusText: response.statusText,
              syncUrl: this.syncUrl,
              batchId: batch.batchId,
            },
            'Observability sync batch failed',
          );
          break;
        }

        fs.rmSync(fullPath, { force: true });
      }
    } catch (err) {
      logger.warn({ err }, 'Observability sync failed');
    } finally {
      this.syncInFlight = false;
    }
  }

  private appendToArchive(event: ObservabilityEvent): void {
    const stamp = event.occurredAt.split('T')[0] || 'unknown-date';
    const archiveFile = path.join(this.archiveDir, `${stamp}.ndjson`);
    fs.appendFileSync(archiveFile, JSON.stringify(event) + '\n');
  }
}

export function redactText(
  value: string,
  maxPreviewLength = 120,
): RedactedText {
  return {
    preview:
      value.length <= maxPreviewLength
        ? value
        : `${value.slice(0, maxPreviewLength)}...`,
    hash: createHash('sha256').update(value).digest('hex'),
    length: value.length,
  };
}

export function createRunId(kind: 'chat' | 'task'): string {
  return `${kind}-${Date.now()}-${randomUUID().slice(0, 8)}`;
}

export function detectAuthIssueClaims(
  text: string,
  statuses: ToolRuntimeStatus[],
): Array<{ tool: string; profileId: string; text: string }> {
  if (!AUTH_ISSUE_PATTERNS.some((pattern) => pattern.test(text))) {
    return [];
  }

  const haystack = text.toLowerCase();
  return statuses
    .filter((status) => {
      const toolTerms = [status.tool, status.profileId]
        .flatMap((term) => term.toLowerCase().split(/[:_\-\s]+/))
        .filter(Boolean);
      if (status.tool === 'gws') {
        toolTerms.push('google', 'workspace', 'calendar', 'gws');
      }
      return toolTerms.some((term) => haystack.includes(term));
    })
    .map((status) => ({
      tool: status.tool,
      profileId: status.profileId,
      text,
    }));
}

export function getDefaultInstanceId(): string {
  return OBSERVABILITY_INSTANCE_ID || os.hostname();
}

const defaultObservabilityManager = new ObservabilityManager();

export function initObservability(): void {
  defaultObservabilityManager.start();
}

export async function shutdownObservability(): Promise<void> {
  await defaultObservabilityManager.stop();
}

export function emitObservabilityEvent(
  input: EmitObservabilityEventInput,
  options?: EmitObservabilityOptions,
): ObservabilityEvent {
  return defaultObservabilityManager.emit(input, options);
}

export async function flushObservability(reason = 'manual'): Promise<void> {
  await defaultObservabilityManager.flush(reason);
}

export async function syncObservability(): Promise<void> {
  await defaultObservabilityManager.syncPendingBatches();
}
