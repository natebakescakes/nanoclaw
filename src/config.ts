import os from 'os';
import path from 'path';

import { readEnvFile } from './env.js';
import { isValidTimezone } from './timezone.js';

// Read config values from .env (falls back to process.env).
const envConfig = readEnvFile([
  'ASSISTANT_NAME',
  'ASSISTANT_HAS_OWN_NUMBER',
  'CREDENTIAL_PROXY_HOST',
  'CREDENTIAL_PROXY_PORT',
  'ONECLI_URL',
  'OBSERVABILITY_API_TOKEN',
  'OBSERVABILITY_ENABLED',
  'OBSERVABILITY_FLUSH_INTERVAL_MS',
  'OBSERVABILITY_INSTANCE_ID',
  'OBSERVABILITY_MAX_BATCH_EVENTS',
  'OBSERVABILITY_SYNC_URL',
  'TELEGRAM_BOT_POOL',
  'TZ',
  'GOOGLE_TASKS_CLIENT_ID',
  'GOOGLE_TASKS_CLIENT_SECRET',
]);

export const ASSISTANT_NAME =
  process.env.ASSISTANT_NAME || envConfig.ASSISTANT_NAME || 'Andy';
export const ASSISTANT_HAS_OWN_NUMBER =
  (process.env.ASSISTANT_HAS_OWN_NUMBER ||
    envConfig.ASSISTANT_HAS_OWN_NUMBER) === 'true';
export const POLL_INTERVAL = 2000;
export const SCHEDULER_POLL_INTERVAL = 60000;

// Absolute paths needed for container mounts
const PROJECT_ROOT = process.cwd();
const HOME_DIR = process.env.HOME || os.homedir();

// Mount security: allowlist stored OUTSIDE project root, never mounted into containers
export const MOUNT_ALLOWLIST_PATH = path.join(
  HOME_DIR,
  '.config',
  'nanoclaw',
  'mount-allowlist.json',
);
export const SENDER_ALLOWLIST_PATH = path.join(
  HOME_DIR,
  '.config',
  'nanoclaw',
  'sender-allowlist.json',
);
export const TOOL_PROFILES_PATH = path.join(
  HOME_DIR,
  '.config',
  'nanoclaw',
  'tool-profiles.json',
);
export const STORE_DIR = path.resolve(PROJECT_ROOT, 'store');
export const GROUPS_DIR = path.resolve(PROJECT_ROOT, 'groups');
export const DATA_DIR = path.resolve(PROJECT_ROOT, 'data');
export const OBSERVABILITY_DIR = path.join(DATA_DIR, 'observability');

export const CONTAINER_IMAGE =
  process.env.CONTAINER_IMAGE || 'nanoclaw-agent:latest';
export const CONTAINER_TIMEOUT = parseInt(
  process.env.CONTAINER_TIMEOUT || '1800000',
  10,
);
export const CONTAINER_MAX_OUTPUT_SIZE = parseInt(
  process.env.CONTAINER_MAX_OUTPUT_SIZE || '10485760',
  10,
); // 10MB default
export const ONECLI_URL =
  process.env.ONECLI_URL || envConfig.ONECLI_URL || 'http://localhost:10254';
export const CREDENTIAL_PROXY_PORT = parseInt(
  process.env.CREDENTIAL_PROXY_PORT ||
    envConfig.CREDENTIAL_PROXY_PORT ||
    '3001',
  10,
);
export const CREDENTIAL_PROXY_HOST =
  process.env.CREDENTIAL_PROXY_HOST ||
  envConfig.CREDENTIAL_PROXY_HOST ||
  '0.0.0.0';
export const OBSERVABILITY_ENABLED =
  (process.env.OBSERVABILITY_ENABLED ||
    envConfig.OBSERVABILITY_ENABLED ||
    'true') !== 'false';
export const OBSERVABILITY_SYNC_URL =
  process.env.OBSERVABILITY_SYNC_URL || envConfig.OBSERVABILITY_SYNC_URL || '';
export const OBSERVABILITY_API_TOKEN =
  process.env.OBSERVABILITY_API_TOKEN ||
  envConfig.OBSERVABILITY_API_TOKEN ||
  '';
export const OBSERVABILITY_INSTANCE_ID =
  process.env.OBSERVABILITY_INSTANCE_ID ||
  envConfig.OBSERVABILITY_INSTANCE_ID ||
  os.hostname();
export const OBSERVABILITY_FLUSH_INTERVAL_MS = parseInt(
  process.env.OBSERVABILITY_FLUSH_INTERVAL_MS ||
    envConfig.OBSERVABILITY_FLUSH_INTERVAL_MS ||
    '15000',
  10,
);
export const OBSERVABILITY_MAX_BATCH_EVENTS = Math.max(
  1,
  parseInt(
    process.env.OBSERVABILITY_MAX_BATCH_EVENTS ||
      envConfig.OBSERVABILITY_MAX_BATCH_EVENTS ||
      '100',
    10,
  ) || 100,
);
export const IPC_POLL_INTERVAL = 1000;
export const IDLE_TIMEOUT = parseInt(process.env.IDLE_TIMEOUT || '1800000', 10); // 30min default — how long to keep container alive after last result
export const MAX_CONCURRENT_CONTAINERS = Math.max(
  1,
  parseInt(process.env.MAX_CONCURRENT_CONTAINERS || '5', 10) || 5,
);

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function buildTriggerPattern(trigger: string): RegExp {
  return new RegExp(`^${escapeRegex(trigger.trim())}\\b`, 'i');
}

export const DEFAULT_TRIGGER = `@${ASSISTANT_NAME}`;

export function getTriggerPattern(trigger?: string): RegExp {
  const normalizedTrigger = trigger?.trim();
  return buildTriggerPattern(normalizedTrigger || DEFAULT_TRIGGER);
}

export const TRIGGER_PATTERN = buildTriggerPattern(DEFAULT_TRIGGER);

// Timezone for scheduled tasks, message formatting, etc.
// Validates each candidate is a real IANA identifier before accepting.
function resolveConfigTimezone(): string {
  const candidates = [
    process.env.TZ,
    envConfig.TZ,
    Intl.DateTimeFormat().resolvedOptions().timeZone,
  ];
  for (const tz of candidates) {
    if (tz && isValidTimezone(tz)) return tz;
  }
  return 'UTC';
}
export const TIMEZONE = resolveConfigTimezone();

export const GOOGLE_TASKS_CLIENT_ID =
  process.env.GOOGLE_TASKS_CLIENT_ID || envConfig.GOOGLE_TASKS_CLIENT_ID || '';
export const GOOGLE_TASKS_CLIENT_SECRET =
  process.env.GOOGLE_TASKS_CLIENT_SECRET ||
  envConfig.GOOGLE_TASKS_CLIENT_SECRET ||
  '';

export const TELEGRAM_BOT_POOL = (
  process.env.TELEGRAM_BOT_POOL ||
  envConfig.TELEGRAM_BOT_POOL ||
  ''
)
  .split(',')
  .map((t) => t.trim())
  .filter(Boolean);
