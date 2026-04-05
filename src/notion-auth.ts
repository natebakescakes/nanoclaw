import fs from 'fs';
import path from 'path';

import { logger } from './logger.js';
import type { ResolvedToolProfile } from './tool-profiles.js';

interface NotionTokenPayload {
  access_token: string;
  token_type: string;
  expires_in: number;
  refresh_token?: string;
  scope?: string;
}

interface RefreshableNotionBundle {
  authRoot: string;
  versionDirName: string;
  clientInfoPath: string;
  tokenPath: string;
}

function parseVersionKey(versionDirName: string): number[] {
  const version = versionDirName.replace(/^mcp-remote-/, '');
  return version.split('.').map((part) => Number.parseInt(part, 10) || 0);
}

function compareVersionKeys(a: string, b: string): number {
  const aKey = parseVersionKey(a);
  const bKey = parseVersionKey(b);
  const maxLen = Math.max(aKey.length, bKey.length);
  for (let i = 0; i < maxLen; i++) {
    const diff = (bKey[i] ?? 0) - (aKey[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

function getNotionAuthRoots(profile: ResolvedToolProfile): string[] {
  const authMount = profile.mounts.find(
    (mount) =>
      mount.containerPath.endsWith('/.mcp-auth') ||
      path.basename(mount.hostPath).includes('notion-mcp-auth'),
  );
  if (!authMount) return [];

  const roots = [
    authMount.hostPath,
    path.join(authMount.hostPath, '.mcp-auth'),
  ];
  return roots.filter((root, index) => roots.indexOf(root) === index);
}

function findRefreshableNotionBundles(
  profile: ResolvedToolProfile,
): RefreshableNotionBundle[] {
  const bundles: RefreshableNotionBundle[] = [];

  for (const authRoot of getNotionAuthRoots(profile)) {
    if (!fs.existsSync(authRoot)) continue;

    let entries: string[] = [];
    try {
      entries = fs.readdirSync(authRoot);
    } catch {
      continue;
    }

    for (const entry of entries) {
      if (!entry.startsWith('mcp-remote-')) continue;
      const versionDir = path.join(authRoot, entry);

      let files: string[] = [];
      try {
        if (!fs.statSync(versionDir).isDirectory()) continue;
        files = fs.readdirSync(versionDir);
      } catch {
        continue;
      }

      for (const file of files) {
        if (!file.endsWith('_tokens.json')) continue;

        const tokenPath = path.join(versionDir, file);
        const clientInfoPath = path.join(
          versionDir,
          file.replace(/_tokens\.json$/, '_client_info.json'),
        );
        if (!fs.existsSync(clientInfoPath)) continue;

        try {
          const token = JSON.parse(fs.readFileSync(tokenPath, 'utf8')) as {
            refresh_token?: string;
          };
          if (!token.refresh_token) continue;
        } catch {
          continue;
        }

        bundles.push({
          authRoot,
          versionDirName: entry,
          clientInfoPath,
          tokenPath,
        });
      }
    }
  }

  bundles.sort((a, b) => {
    const versionDiff = compareVersionKeys(a.versionDirName, b.versionDirName);
    if (versionDiff !== 0) return versionDiff;

    const aMtime = fs.statSync(a.tokenPath).mtimeMs;
    const bMtime = fs.statSync(b.tokenPath).mtimeMs;
    return bMtime - aMtime;
  });

  return bundles;
}

async function refreshNotionBundle(
  bundle: RefreshableNotionBundle,
  authRoots: string[],
): Promise<void> {
  const clientInfo = JSON.parse(
    fs.readFileSync(bundle.clientInfoPath, 'utf8'),
  ) as {
    client_id?: string;
  };
  const tokens = JSON.parse(
    fs.readFileSync(bundle.tokenPath, 'utf8'),
  ) as NotionTokenPayload;

  if (!clientInfo.client_id || !tokens.refresh_token) {
    return;
  }

  const response = await fetch('https://mcp.notion.com/token', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: clientInfo.client_id,
      refresh_token: tokens.refresh_token,
    }),
    signal: AbortSignal.timeout(5000),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(
      `Notion token refresh failed (${response.status}): ${body}`,
    );
  }

  const refreshed = (await response.json()) as NotionTokenPayload;
  const nextTokens: NotionTokenPayload = {
    access_token: refreshed.access_token,
    token_type: refreshed.token_type,
    expires_in: refreshed.expires_in,
    refresh_token: refreshed.refresh_token ?? tokens.refresh_token,
    scope: refreshed.scope ?? tokens.scope,
  };

  for (const authRoot of authRoots) {
    const versionDir = path.join(authRoot, bundle.versionDirName);
    fs.mkdirSync(versionDir, { recursive: true });
    const targetPath = path.join(versionDir, path.basename(bundle.tokenPath));
    fs.writeFileSync(targetPath, JSON.stringify(nextTokens, null, 2) + '\n', {
      mode: 0o600,
    });
  }
}

export async function refreshNotionProfileTokens(
  profile: ResolvedToolProfile,
): Promise<void> {
  if (profile.tool !== 'notion') return;

  const authRoots = getNotionAuthRoots(profile).filter((root) =>
    fs.existsSync(root),
  );
  if (authRoots.length === 0) return;

  const bundle = findRefreshableNotionBundles(profile)[0];
  if (!bundle) return;

  try {
    await refreshNotionBundle(bundle, authRoots);
    logger.info(
      {
        profileId: profile.profileId,
        versionDir: bundle.versionDirName,
      },
      'Refreshed Notion MCP tokens from refresh token',
    );
  } catch (error) {
    logger.warn(
      {
        profileId: profile.profileId,
        error: error instanceof Error ? error.message : String(error),
      },
      'Failed to refresh Notion MCP tokens; falling back to existing cache',
    );
  }
}

export async function refreshOauthProfileTokens(
  profiles: ResolvedToolProfile[],
): Promise<void> {
  for (const profile of profiles) {
    await refreshNotionProfileTokens(profile);
  }
}
