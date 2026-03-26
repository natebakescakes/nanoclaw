import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { spawn } from 'child_process';
import { EventEmitter } from 'events';
import { PassThrough } from 'stream';
import fs from 'fs';

// Sentinel markers must match container-runner.ts
const OUTPUT_START_MARKER = '---NANOCLAW_OUTPUT_START---';
const OUTPUT_END_MARKER = '---NANOCLAW_OUTPUT_END---';

// Mock config
vi.mock('./config.js', () => ({
  CONTAINER_IMAGE: 'nanoclaw-agent:latest',
  CONTAINER_MAX_OUTPUT_SIZE: 10485760,
  CONTAINER_TIMEOUT: 1800000, // 30min
  CREDENTIAL_PROXY_PORT: 3001,
  DATA_DIR: '/tmp/nanoclaw-test-data',
  GOOGLE_TASKS_CLIENT_ID: '',
  GOOGLE_TASKS_CLIENT_SECRET: '',
  GROUPS_DIR: '/tmp/nanoclaw-test-groups',
  IDLE_TIMEOUT: 1800000, // 30min
  TIMEZONE: 'America/Los_Angeles',
  TOOL_PROFILES_PATH: '/tmp/nanoclaw-tool-profiles.json',
}));

// Mock logger
vi.mock('./logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

// Mock fs
vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return {
    ...actual,
    default: {
      ...actual,
      existsSync: vi.fn(() => false),
      mkdirSync: vi.fn(),
      writeFileSync: vi.fn(),
      readFileSync: vi.fn(() => ''),
      readdirSync: vi.fn(() => []),
      statSync: vi.fn(() => ({ isDirectory: () => false })),
      cpSync: vi.fn(),
      copyFileSync: vi.fn(),
    },
  };
});

// Mock mount-security
vi.mock('./mount-security.js', () => ({
  validateAdditionalMounts: vi.fn(() => []),
}));

vi.mock('./env.js', () => ({
  readEnvFile: vi.fn(() => ({})),
}));

vi.mock('./tool-profiles.js', () => ({
  loadToolProfileRegistry: vi.fn(() => ({})),
  resolveToolProfiles: vi.fn((_isMain, perms) => {
    if (!perms) return [];

    const profiles = [];
    if ((perms.mcpServerProfiles ?? []).includes('gmail:personal')) {
      profiles.push({
        profileId: 'gmail:personal',
        tool: 'gmail',
        serverName: 'gmail__personal',
        homeDir: '/home/node/.nanoclaw/tool-profiles/gmail_personal',
        mounts: [
          {
            hostPath: '/tmp/home/.gmail-mcp-personal',
            containerPath:
              '/home/node/.nanoclaw/tool-profiles/gmail_personal/.gmail-mcp',
            readonly: false,
          },
        ],
      });
    }
    if ((perms.mcpServerProfiles ?? []).includes('gmail:work')) {
      profiles.push({
        profileId: 'gmail:work',
        tool: 'gmail',
        serverName: 'gmail__work',
        homeDir: '/home/node/.nanoclaw/tool-profiles/gmail_work',
        mounts: [
          {
            hostPath: '/tmp/home/.gmail-mcp-work',
            containerPath:
              '/home/node/.nanoclaw/tool-profiles/gmail_work/.gmail-mcp',
            readonly: false,
          },
        ],
      });
    }
    if ((perms.mcpServers ?? []).includes('slack')) {
      profiles.push({
        profileId: 'slack',
        tool: 'slack',
        serverName: 'slack__default',
        homeDir: '/home/node/.nanoclaw/tool-profiles/slack',
        mounts: [
          {
            hostPath: '/tmp/home/.slack',
            containerPath: '/home/node/.nanoclaw/tool-profiles/slack/.slack',
            readonly: true,
          },
        ],
      });
    }
    return profiles;
  }),
}));

// Create a controllable fake ChildProcess
function createFakeProcess() {
  const proc = new EventEmitter() as EventEmitter & {
    stdin: PassThrough;
    stdout: PassThrough;
    stderr: PassThrough;
    kill: ReturnType<typeof vi.fn>;
    pid: number;
  };
  proc.stdin = new PassThrough();
  proc.stdout = new PassThrough();
  proc.stderr = new PassThrough();
  proc.kill = vi.fn();
  proc.pid = 12345;
  return proc;
}

let fakeProc: ReturnType<typeof createFakeProcess>;

// Mock child_process.spawn
vi.mock('child_process', async () => {
  const actual =
    await vi.importActual<typeof import('child_process')>('child_process');
  return {
    ...actual,
    spawn: vi.fn(() => fakeProc),
    exec: vi.fn(
      (_cmd: string, _opts: unknown, cb?: (err: Error | null) => void) => {
        if (cb) cb(null);
        return new EventEmitter();
      },
    ),
  };
});

import {
  buildVolumeMounts,
  runContainerAgent,
  ContainerOutput,
} from './container-runner.js';
import { readEnvFile } from './env.js';
import type { RegisteredGroup } from './types.js';

const testGroup: RegisteredGroup = {
  name: 'Test Group',
  folder: 'test-group',
  trigger: '@Andy',
  added_at: new Date().toISOString(),
};

const testInput = {
  prompt: 'Hello',
  groupFolder: 'test-group',
  chatJid: 'test@g.us',
  isMain: false,
};

function emitOutputMarker(
  proc: ReturnType<typeof createFakeProcess>,
  output: ContainerOutput,
) {
  const json = JSON.stringify(output);
  proc.stdout.push(`${OUTPUT_START_MARKER}\n${json}\n${OUTPUT_END_MARKER}\n`);
}

describe('container-runner timeout behavior', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    vi.mocked(fs.existsSync).mockReturnValue(false);
    fakeProc = createFakeProcess();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('timeout after output resolves as success', async () => {
    const onOutput = vi.fn(async () => {});
    const resultPromise = runContainerAgent(
      testGroup,
      testInput,
      () => {},
      onOutput,
    );

    // Emit output with a result
    emitOutputMarker(fakeProc, {
      status: 'success',
      result: 'Here is my response',
      newSessionId: 'session-123',
    });

    // Let output processing settle
    await vi.advanceTimersByTimeAsync(10);

    // Fire the hard timeout (IDLE_TIMEOUT + 30s = 1830000ms)
    await vi.advanceTimersByTimeAsync(1830000);

    // Emit close event (as if container was stopped by the timeout)
    fakeProc.emit('close', 137);

    // Let the promise resolve
    await vi.advanceTimersByTimeAsync(10);

    const result = await resultPromise;
    expect(result.status).toBe('success');
    expect(result.newSessionId).toBe('session-123');
    expect(onOutput).toHaveBeenCalledWith(
      expect.objectContaining({ result: 'Here is my response' }),
    );
  });

  it('timeout with no output resolves as error', async () => {
    const onOutput = vi.fn(async () => {});
    const resultPromise = runContainerAgent(
      testGroup,
      testInput,
      () => {},
      onOutput,
    );

    // No output emitted — fire the hard timeout
    await vi.advanceTimersByTimeAsync(1830000);

    // Emit close event
    fakeProc.emit('close', 137);

    await vi.advanceTimersByTimeAsync(10);

    const result = await resultPromise;
    expect(result.status).toBe('error');
    expect(result.error).toContain('timed out');
    expect(onOutput).not.toHaveBeenCalled();
  });

  it('normal exit after output resolves as success', async () => {
    const onOutput = vi.fn(async () => {});
    const resultPromise = runContainerAgent(
      testGroup,
      testInput,
      () => {},
      onOutput,
    );

    // Emit output
    emitOutputMarker(fakeProc, {
      status: 'success',
      result: 'Done',
      newSessionId: 'session-456',
    });

    await vi.advanceTimersByTimeAsync(10);

    // Normal exit (no timeout)
    fakeProc.emit('close', 0);

    await vi.advanceTimersByTimeAsync(10);

    const result = await resultPromise;
    expect(result.status).toBe('success');
    expect(result.newSessionId).toBe('session-456');
  });
});

describe('container-runner tool profiles', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(fs.existsSync).mockReturnValue(false);
    fakeProc = createFakeProcess();
  });

  it('mounts only the exact allowed scoped tool profile', () => {
    vi.mocked(fs.existsSync).mockImplementation(
      (p) => p === '/tmp/home/.gmail-mcp-personal',
    );
    const group: RegisteredGroup = {
      ...testGroup,
      containerConfig: {
        toolPermissions: {
          mcpServerProfiles: ['gmail:personal'],
        },
      },
    };

    const mounts = buildVolumeMounts(
      group,
      false,
      group.containerConfig?.toolPermissions,
    );

    expect(
      mounts.some(
        (m) =>
          m.hostPath === '/tmp/home/.gmail-mcp-personal' &&
          m.containerPath ===
            '/home/node/.nanoclaw/tool-profiles/gmail_personal/.gmail-mcp',
      ),
    ).toBe(true);
    expect(
      mounts.some(
        (m) =>
          m.hostPath === '/tmp/home/.slack' &&
          m.containerPath === '/home/node/.nanoclaw/tool-profiles/slack/.slack',
      ),
    ).toBe(false);
  });

  it('legacy tool allowlist still mounts matching default tool profile', () => {
    vi.mocked(fs.existsSync).mockImplementation(
      (p) => p === '/tmp/home/.slack',
    );
    const group: RegisteredGroup = {
      ...testGroup,
      containerConfig: {
        toolPermissions: {
          mcpServers: ['slack'],
        },
      },
    };

    const mounts = buildVolumeMounts(
      group,
      false,
      group.containerConfig?.toolPermissions,
    );

    expect(
      mounts.some(
        (m) =>
          m.hostPath === '/tmp/home/.slack' &&
          m.containerPath === '/home/node/.nanoclaw/tool-profiles/slack/.slack',
      ),
    ).toBe(true);
  });

  it('mounts two profiles of the same MCP family to distinct container paths', () => {
    vi.mocked(fs.existsSync).mockImplementation(
      (p) =>
        p === '/tmp/home/.gmail-mcp-personal' ||
        p === '/tmp/home/.gmail-mcp-work',
    );
    const group: RegisteredGroup = {
      ...testGroup,
      containerConfig: {
        toolPermissions: {
          mcpServerProfiles: ['gmail:personal', 'gmail:work'],
        },
      },
    };

    const mounts = buildVolumeMounts(
      group,
      false,
      group.containerConfig?.toolPermissions,
    );

    expect(
      mounts.some(
        (m) =>
          m.hostPath === '/tmp/home/.gmail-mcp-personal' &&
          m.containerPath ===
            '/home/node/.nanoclaw/tool-profiles/gmail_personal/.gmail-mcp',
      ),
    ).toBe(true);
    expect(
      mounts.some(
        (m) =>
          m.hostPath === '/tmp/home/.gmail-mcp-work' &&
          m.containerPath ===
            '/home/node/.nanoclaw/tool-profiles/gmail_work/.gmail-mcp',
      ),
    ).toBe(true);
  });
});

describe('container-runner bundled skills', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fakeProc = createFakeProcess();
    vi.mocked(fs.existsSync).mockImplementation(
      (p) => p === '/home/developer/nanoclaw/container/skills',
    );
    vi.mocked(fs.readdirSync).mockReturnValue([
      'status',
      'capabilities',
    ] as any);
    vi.mocked(fs.statSync).mockReturnValue({ isDirectory: () => true } as any);
  });

  it('syncs bundled skills into both Claude and Codex homes', () => {
    const mounts = buildVolumeMounts(testGroup, false);

    expect(fs.cpSync).toHaveBeenCalledWith(
      '/home/developer/nanoclaw/container/skills/status',
      '/tmp/nanoclaw-test-data/sessions/test-group/.claude/skills/status',
      { recursive: true },
    );
    expect(fs.cpSync).toHaveBeenCalledWith(
      '/home/developer/nanoclaw/container/skills/status',
      '/tmp/nanoclaw-test-data/sessions/test-group/.codex/skills/status',
      { recursive: true },
    );
    expect(
      mounts.some(
        (m) =>
          m.hostPath ===
            '/tmp/nanoclaw-test-data/sessions/test-group/.claude' &&
          m.containerPath === '/home/node/.claude',
      ),
    ).toBe(true);
    expect(
      mounts.some(
        (m) =>
          m.hostPath ===
            '/tmp/nanoclaw-test-data/sessions/test-group/.codex/skills' &&
          m.containerPath === '/home/node/.codex/skills',
      ),
    ).toBe(true);
  });
});

describe('container-runner MCP secrets', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fakeProc = createFakeProcess();
    vi.mocked(fs.existsSync).mockReturnValue(false);
    vi.mocked(readEnvFile).mockReturnValue({
      AHREFS_MCP_KEY: 'test-ahrefs-key',
    });
  });

  it('passes the Ahrefs MCP key into the container environment', async () => {
    const resultPromise = runContainerAgent(testGroup, testInput, () => {});
    emitOutputMarker(fakeProc, {
      status: 'success',
      result: 'ok',
    });
    fakeProc.emit('close', 0);
    await resultPromise;

    const spawnCalls = vi.mocked(spawn).mock.calls;
    const containerArgs = spawnCalls[0]?.[1] as string[];
    expect(containerArgs).toContain('-e');
    expect(containerArgs).toContain('AHREFS_MCP_KEY=test-ahrefs-key');
  });
});
