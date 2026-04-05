import { describe, expect, it } from 'vitest';

import {
  MCP_REMOTE_VERSION,
  resolveMcpRemoteCommand,
} from '../container/agent-runner/src/mcp-remote.js';
import { classifyNotionProbeResult } from '../container/agent-runner/src/notion-probe.js';

describe('resolveMcpRemoteCommand', () => {
  it('prefers the installed proxy binary when available', () => {
    expect(
      resolveMcpRemoteCommand(
        'mcp-remote',
        'https://mcp.notion.com/mcp',
        '/usr/local/bin/mcp-remote',
      ),
    ).toEqual({
      command: '/usr/local/bin/mcp-remote',
      args: ['https://mcp.notion.com/mcp'],
    });
  });

  it('falls back to a pinned npx install for the client binary', () => {
    expect(
      resolveMcpRemoteCommand(
        'mcp-remote-client',
        'https://mcp.notion.com/mcp',
        null,
      ),
    ).toEqual({
      command: 'npx',
      args: [
        '-y',
        `mcp-remote@${MCP_REMOTE_VERSION}`,
        'mcp-remote-client',
        'https://mcp.notion.com/mcp',
      ],
    });
  });
});

describe('classifyNotionProbeResult', () => {
  it('treats an explicit successful handshake as working', () => {
    expect(
      classifyNotionProbeResult({
        ok: false,
        output:
          '[41] Connected successfully!\n[41] Requesting tools list...\n[41] Received message: {"result":{"tools":[]}}',
        error: 'Command failed: /usr/local/bin/mcp-remote-client https://mcp.notion.com/mcp',
      }),
    ).toEqual({
      auth: 'working',
      detail: 'Connected to Notion MCP and listed tools in this container run',
    });
  });

  it('keeps true OAuth failures classified as auth failures', () => {
    expect(
      classifyNotionProbeResult({
        ok: false,
        output:
          'Authentication required. Waiting for authorization...\nPlease authorize this client by visiting:',
        error: 'Command failed: /usr/local/bin/mcp-remote-client https://mcp.notion.com/mcp',
      }),
    ).toEqual({
      auth: 'auth_failed',
      detail: 'Command failed: /usr/local/bin/mcp-remote-client https://mcp.notion.com/mcp',
    });
  });
});
