import fs from 'fs';
import http from 'http';
import os from 'os';
import path from 'path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  detectAuthIssueClaims,
  ObservabilityManager,
  redactText,
} from './observability.js';
import type { ToolRuntimeStatus } from './types.js';

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-observability-'));
  tempDirs.push(dir);
  return dir;
}

describe('ObservabilityManager', () => {
  it('archives events and writes pending batches locally', async () => {
    const dir = makeTempDir();
    const manager = new ObservabilityManager({
      directory: dir,
      instanceId: 'test-instance',
      enabled: true,
      syncUrl: '',
    });

    manager.start();
    manager.emit({
      eventType: 'run.started',
      groupFolder: 'telegram_work',
      payload: {
        prompt: redactText('hello world'),
      },
    });

    await manager.flush('test');
    await manager.stop();

    const archiveDir = path.join(dir, 'archive');
    const pendingDir = path.join(dir, 'pending');
    expect(fs.readdirSync(archiveDir)).toHaveLength(1);
    expect(fs.readdirSync(pendingDir)).toHaveLength(1);

    const archiveFile = path.join(archiveDir, fs.readdirSync(archiveDir)[0]);
    const archiveLines = fs
      .readFileSync(archiveFile, 'utf8')
      .trim()
      .split('\n');
    expect(archiveLines).toHaveLength(1);
    const archiveEvent = JSON.parse(archiveLines[0]);
    expect(archiveEvent.eventType).toBe('run.started');
    expect(archiveEvent.instanceId).toBe('test-instance');
  });

  it('syncs pending batches to an HTTP endpoint', async () => {
    const dir = makeTempDir();
    const receivedBodies: string[] = [];
    const server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (chunk) => {
        body += chunk.toString();
      });
      req.on('end', () => {
        receivedBodies.push(body);
        res.statusCode = 204;
        res.end();
      });
    });

    await new Promise<void>((resolve) => server.listen(0, resolve));
    const address = server.address();
    const port = typeof address === 'object' && address ? address.port : 0;
    const manager = new ObservabilityManager({
      directory: dir,
      instanceId: 'sync-test',
      enabled: true,
      syncUrl: `http://127.0.0.1:${port}/ingest`,
    });

    manager.start();
    manager.emit({
      eventType: 'run.completed',
      groupFolder: 'telegram_work',
      payload: { source: 'chat' },
    });

    await manager.flush('sync-test');
    await manager.syncPendingBatches();
    await manager.stop();
    server.close();

    expect(receivedBodies).toHaveLength(1);
    const body = JSON.parse(receivedBodies[0]);
    expect(body.instanceId).toBe('sync-test');
    expect(body.events).toHaveLength(1);
    expect(fs.readdirSync(path.join(dir, 'pending'))).toHaveLength(0);
  });
});

describe('detectAuthIssueClaims', () => {
  it('matches auth issue text against the referenced tool profile', () => {
    const statuses: ToolRuntimeStatus[] = [
      {
        profileId: 'notion:multiplier',
        tool: 'notion',
        transport: 'mcp',
        auth: 'working',
        source: 'live_probe',
        detail: 'ok',
      },
      {
        profileId: 'gws:multiplier',
        tool: 'gws',
        transport: 'shell',
        auth: 'working',
        source: 'live_probe',
        detail: 'ok',
      },
    ];

    const claims = detectAuthIssueClaims(
      'Notion token is still expired from earlier. I need you to re-auth notion.',
      statuses,
    );

    expect(claims).toHaveLength(1);
    expect(claims[0].tool).toBe('notion');
    expect(claims[0].profileId).toBe('notion:multiplier');
  });
});
