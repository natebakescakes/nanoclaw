import fs from 'fs';
import path from 'path';

export const MCP_REMOTE_VERSION = '0.1.38';

type McpRemoteEntrypoint = 'mcp-remote' | 'mcp-remote-client';

function findInstalledMcpRemoteBinary(
  entrypoint: McpRemoteEntrypoint,
): string | null {
  const candidates = [
    path.join('/usr/local/bin', entrypoint),
    path.join('/usr/bin', entrypoint),
  ];

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }

  return null;
}

export function resolveMcpRemoteCommand(
  entrypoint: McpRemoteEntrypoint,
  url: string,
  installedBinaryPath?: string | null,
): {
  command: string;
  args: string[];
} {
  const binaryPath =
    installedBinaryPath ?? findInstalledMcpRemoteBinary(entrypoint);
  if (binaryPath) {
    return {
      command: binaryPath,
      args: [url],
    };
  }

  return {
    command: 'npx',
    args: ['-y', `mcp-remote@${MCP_REMOTE_VERSION}`, entrypoint, url],
  };
}
