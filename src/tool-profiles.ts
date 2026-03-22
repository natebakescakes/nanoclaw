import fs from 'fs';
import os from 'os';
import path from 'path';

import { TOOL_PROFILES_PATH } from './config.js';
import { logger } from './logger.js';
import { ToolPermissions } from './types.js';

export interface ToolProfileMount {
  hostPath: string;
  containerPath: string;
  readonly: boolean;
  create?: boolean;
}

export interface ToolProfileDefinition {
  tool: string;
  mounts: ToolProfileMount[];
}

export type ToolProfileRegistry = Record<string, ToolProfileDefinition>;

interface ToolProfilesConfigFile {
  profiles?: Record<
    string,
    {
      tool?: string;
      mounts?: Array<{
        hostPath: string;
        containerPath: string;
        readonly?: boolean;
        create?: boolean;
      }>;
    }
  >;
}

function expandHome(p: string, homeDir: string): string {
  if (p === '~') return homeDir;
  if (p.startsWith('~/')) return path.join(homeDir, p.slice(2));
  return p;
}

function inferToolFromProfileId(profileId: string): string {
  const idx = profileId.indexOf(':');
  return idx === -1 ? profileId : profileId.slice(0, idx);
}

export function getToolFamily(permissionId: string): string {
  return inferToolFromProfileId(permissionId);
}

export function getBuiltinToolProfiles(
  homeDir: string = process.env.HOME || os.homedir(),
): ToolProfileRegistry {
  return {
    gmail: {
      tool: 'gmail',
      mounts: [
        {
          hostPath: path.join(homeDir, '.gmail-mcp'),
          containerPath: '/home/node/.gmail-mcp',
          readonly: false,
        },
      ],
    },
    'google-calendar': {
      tool: 'google-calendar',
      mounts: [
        {
          hostPath: path.join(homeDir, '.gcal-mcp'),
          containerPath: '/home/node/.gcal-mcp',
          readonly: false,
          create: true,
        },
        {
          hostPath: path.join(homeDir, '.config', 'google-calendar-mcp'),
          containerPath: '/home/node/.config/google-calendar-mcp',
          readonly: false,
          create: true,
        },
      ],
    },
    littlelives: {
      tool: 'littlelives',
      mounts: [
        {
          hostPath: path.join(homeDir, '.littlelives'),
          containerPath: '/home/node/.littlelives',
          readonly: true,
        },
      ],
    },
    ynab: {
      tool: 'ynab',
      mounts: [
        {
          hostPath: path.join(homeDir, '.ynab'),
          containerPath: '/home/node/.ynab',
          readonly: true,
        },
      ],
    },
    trakt: {
      tool: 'trakt',
      mounts: [
        {
          hostPath: path.join(homeDir, '.trakt'),
          containerPath: '/home/node/.trakt',
          readonly: false,
        },
      ],
    },
    ibkr: {
      tool: 'ibkr',
      mounts: [
        {
          hostPath: path.join(homeDir, '.ibkr'),
          containerPath: '/home/node/.ibkr',
          readonly: true,
        },
      ],
    },
    slack: {
      tool: 'slack',
      mounts: [
        {
          hostPath: path.join(homeDir, '.slack'),
          containerPath: '/home/node/.slack',
          readonly: true,
        },
      ],
    },
    notion: {
      tool: 'notion',
      mounts: [
        {
          hostPath: path.join(homeDir, '.notion-mcp-auth'),
          containerPath: '/home/node/.mcp-auth',
          readonly: false,
          create: true,
        },
      ],
    },
    'google-tasks-vrob': {
      tool: 'google-tasks-vrob',
      mounts: [
        {
          hostPath: path.join(homeDir, '.config', 'mcp-googletasks-vrob'),
          containerPath: '/home/node/.config/mcp-googletasks-vrob',
          readonly: false,
          create: true,
        },
      ],
    },
  };
}

export function loadToolProfileRegistry(
  configPath: string = TOOL_PROFILES_PATH,
  homeDir: string = process.env.HOME || os.homedir(),
): ToolProfileRegistry {
  const registry = getBuiltinToolProfiles(homeDir);

  if (!fs.existsSync(configPath)) return registry;

  try {
    const raw = JSON.parse(
      fs.readFileSync(configPath, 'utf-8'),
    ) as ToolProfilesConfigFile | Record<string, unknown>;
    const profiles =
      'profiles' in raw && raw.profiles && typeof raw.profiles === 'object'
        ? raw.profiles
        : (raw as ToolProfilesConfigFile['profiles']);

    if (!profiles) return registry;

    for (const [profileId, definition] of Object.entries(profiles)) {
      if (!definition?.mounts?.length) continue;
      registry[profileId] = {
        tool: definition.tool || inferToolFromProfileId(profileId),
        mounts: definition.mounts.map(
          (mount: NonNullable<typeof definition.mounts>[number]) => ({
          hostPath: expandHome(mount.hostPath, homeDir),
          containerPath: mount.containerPath,
          readonly: mount.readonly ?? true,
          create: mount.create ?? false,
          }),
        ),
      };
    }
  } catch (err) {
    logger.warn(
      { err, configPath },
      'Failed to read tool profile configuration; using built-in defaults',
    );
  }

  return registry;
}

export function resolveAllowedToolProfileIds(
  isMain: boolean,
  perms: ToolPermissions | undefined,
  registry: ToolProfileRegistry,
): string[] {
  const availableIds = Object.keys(registry);
  if (isMain && !perms?.mcpServers?.length && !perms?.mcpServerProfiles?.length) {
    return availableIds;
  }

  const allowed = new Set<string>();

  for (const profileId of perms?.mcpServerProfiles ?? []) {
    if (registry[profileId]) {
      allowed.add(profileId);
    } else {
      logger.warn({ profileId }, 'Unknown MCP tool profile requested');
    }
  }

  for (const toolName of perms?.mcpServers ?? []) {
    const matches = availableIds.filter(
      (profileId) => getToolFamily(profileId) === toolName,
    );
    if (matches.length > 0) {
      for (const match of matches) allowed.add(match);
    } else if (registry[toolName]) {
      allowed.add(toolName);
    } else {
      logger.warn({ toolName }, 'Unknown MCP server requested');
    }
  }

  return [...allowed];
}
