import fs from 'fs';

import { describe, expect, it, vi } from 'vitest';

vi.mock('./logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

import {
  getBuiltinToolProfiles,
  loadToolProfileRegistry,
  resolveAllowedToolProfileIds,
} from './tool-profiles.js';

describe('tool profile resolution', () => {
  it('non-main group with no permissions gets no external profiles', () => {
    const registry = getBuiltinToolProfiles('/tmp/home');
    expect(resolveAllowedToolProfileIds(false, undefined, registry)).toEqual([]);
  });

  it('main group with no permissions gets all configured profiles', () => {
    const registry = {
      gmail: { tool: 'gmail', mounts: [] },
      'gmail:personal': { tool: 'gmail', mounts: [] },
      slack: { tool: 'slack', mounts: [] },
    };
    expect(resolveAllowedToolProfileIds(true, undefined, registry)).toEqual([
      'gmail',
      'gmail:personal',
      'slack',
    ]);
  });

  it('legacy tool allowlist expands to all matching profile ids', () => {
    const registry = {
      gmail: { tool: 'gmail', mounts: [] },
      'gmail:personal': { tool: 'gmail', mounts: [] },
      'gmail:work': { tool: 'gmail', mounts: [] },
      slack: { tool: 'slack', mounts: [] },
    };
    expect(
      resolveAllowedToolProfileIds(
        false,
        { mcpServers: ['gmail'] },
        registry,
      ).sort(),
    ).toEqual(['gmail', 'gmail:personal', 'gmail:work']);
  });

  it('exact profile allowlist keeps same-tool profiles isolated', () => {
    const registry = {
      'gmail:personal': { tool: 'gmail', mounts: [] },
      'gmail:work': { tool: 'gmail', mounts: [] },
    };
    expect(
      resolveAllowedToolProfileIds(
        false,
        { mcpServerProfiles: ['gmail:personal'] },
        registry,
      ),
    ).toEqual(['gmail:personal']);
  });

  it('loads custom scoped profiles from config file', () => {
    const readFileSync = vi.spyOn(fs, 'readFileSync');
    const existsSync = vi.spyOn(fs, 'existsSync');
    existsSync.mockReturnValue(true);
    readFileSync.mockReturnValue(
      JSON.stringify({
        profiles: {
          'gmail:personal': {
            mounts: [
              {
                hostPath: '~/.gmail-mcp-personal',
                containerPath: '/home/node/.gmail-mcp',
                readonly: false,
              },
            ],
          },
        },
      }),
    );

    const registry = loadToolProfileRegistry(
      '/tmp/tool-profiles.json',
      '/tmp/home',
    );
    expect(registry['gmail:personal']).toEqual({
      tool: 'gmail',
      mounts: [
        {
          hostPath: '/tmp/home/.gmail-mcp-personal',
          containerPath: '/home/node/.gmail-mcp',
          readonly: false,
          create: false,
        },
      ],
    });

    existsSync.mockRestore();
    readFileSync.mockRestore();
  });
});
