/**
 * NanoClaw Agent Runner
 * Runs inside a container, receives config via stdin, outputs result to stdout
 *
 * Input protocol:
 *   Stdin: Full ContainerInput JSON (read until EOF, like before)
 *   IPC:   Follow-up messages written as JSON files to /workspace/ipc/input/
 *          Files: {type:"message", text:"..."}.json — polled and consumed
 *          Sentinel: /workspace/ipc/input/_close — signals session end
 *
 * Stdout protocol:
 *   Each result is wrapped in OUTPUT_START_MARKER / OUTPUT_END_MARKER pairs.
 *   Multiple results may be emitted (one per agent teams result).
 *   Final marker after loop ends signals completion.
 */

import fs from 'fs';
import path from 'path';
import { execFile } from 'child_process';
import { query, HookCallback, PreCompactHookInput } from '@anthropic-ai/claude-agent-sdk';
import { fileURLToPath } from 'url';
import { resolveMcpRemoteCommand } from './mcp-remote.js';
import { classifyNotionProbeResult } from './notion-probe.js';

interface ToolPermissions {
  mcpServers?: string[];
  mcpServerProfiles?: string[];
}

interface ToolProfileMount {
  hostPath: string;
  containerPath: string;
  readonly: boolean;
  create?: boolean;
}

interface ResolvedToolProfile {
  profileId: string;
  tool: string;
  serverName: string;
  homeDir: string;
  mounts: ToolProfileMount[];
}

interface ImageAttachment {
  base64: string;
  mimeType: string;
}

interface TextBlock {
  type: 'text';
  text: string;
}

interface ImageBlock {
  type: 'image';
  source: {
    type: 'base64';
    media_type: string;
    data: string;
  };
}

type ContentBlock = TextBlock | ImageBlock;

interface ContainerInput {
  prompt: string;
  sessionId?: string;
  groupFolder: string;
  chatJid: string;
  isMain: boolean;
  isScheduledTask?: boolean;
  assistantName?: string;
  toolPermissions?: ToolPermissions;
  resolvedToolProfiles?: ResolvedToolProfile[];
  images?: ImageAttachment[];
  script?: string;
}

interface ContainerOutput {
  status: 'success' | 'error';
  result: string | null;
  newSessionId?: string;
  error?: string;
  toolRuntimeStatuses?: ToolRuntimeStatus[];
}

interface ToolRuntimeStatus {
  profileId: string;
  tool: string;
  transport: 'mcp' | 'shell' | 'unknown';
  auth: 'working' | 'missing' | 'auth_failed' | 'unknown';
  source: 'live_probe' | 'filesystem';
  detail: string;
}

interface SessionEntry {
  sessionId: string;
  fullPath: string;
  summary: string;
  firstPrompt: string;
}

interface SessionsIndex {
  entries: SessionEntry[];
}

interface SDKUserMessage {
  type: 'user';
  message: { role: 'user'; content: string | ContentBlock[] };
  parent_tool_use_id: null;
  session_id: string;
}

const IPC_INPUT_DIR = '/workspace/ipc/input';
const IPC_INPUT_CLOSE_SENTINEL = path.join(IPC_INPUT_DIR, '_close');
const IPC_POLL_MS = 500;

/**
 * Push-based async iterable for streaming user messages to the SDK.
 * Keeps the iterable alive until end() is called, preventing isSingleUserTurn.
 */
class MessageStream {
  private queue: SDKUserMessage[] = [];
  private waiting: (() => void) | null = null;
  private done = false;

  push(content: string | ContentBlock[]): void {
    this.queue.push({
      type: 'user',
      message: { role: 'user', content },
      parent_tool_use_id: null,
      session_id: '',
    });
    this.waiting?.();
  }

  end(): void {
    this.done = true;
    this.waiting?.();
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<SDKUserMessage> {
    while (true) {
      while (this.queue.length > 0) {
        yield this.queue.shift()!;
      }
      if (this.done) return;
      await new Promise<void>((r) => {
        this.waiting = r;
      });
      this.waiting = null;
    }
  }
}

async function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => {
      data += chunk;
    });
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', reject);
  });
}

const OUTPUT_START_MARKER = '---NANOCLAW_OUTPUT_START---';
const OUTPUT_END_MARKER = '---NANOCLAW_OUTPUT_END---';

function writeOutput(output: ContainerOutput): void {
  console.log(OUTPUT_START_MARKER);
  console.log(JSON.stringify(output));
  console.log(OUTPUT_END_MARKER);
}

function log(message: string): void {
  console.error(`[agent-runner] ${message}`);
}

function getSessionSummary(
  sessionId: string,
  transcriptPath: string,
): string | null {
  const projectDir = path.dirname(transcriptPath);
  const indexPath = path.join(projectDir, 'sessions-index.json');

  if (!fs.existsSync(indexPath)) {
    log(`Sessions index not found at ${indexPath}`);
    return null;
  }

  try {
    const index: SessionsIndex = JSON.parse(
      fs.readFileSync(indexPath, 'utf-8'),
    );
    const entry = index.entries.find((e) => e.sessionId === sessionId);
    if (entry?.summary) {
      return entry.summary;
    }
  } catch (err) {
    log(
      `Failed to read sessions index: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  return null;
}

/**
 * Archive the full transcript to conversations/ before compaction.
 */
function createPreCompactHook(assistantName?: string): HookCallback {
  return async (input, _toolUseId, _context) => {
    const preCompact = input as PreCompactHookInput;
    const transcriptPath = preCompact.transcript_path;
    const sessionId = preCompact.session_id;

    if (!transcriptPath || !fs.existsSync(transcriptPath)) {
      log('No transcript found for archiving');
      return {};
    }

    try {
      const content = fs.readFileSync(transcriptPath, 'utf-8');
      const messages = parseTranscript(content);

      if (messages.length === 0) {
        log('No messages to archive');
        return {};
      }

      const summary = getSessionSummary(sessionId, transcriptPath);
      const name = summary ? sanitizeFilename(summary) : generateFallbackName();

      const conversationsDir = '/workspace/group/conversations';
      fs.mkdirSync(conversationsDir, { recursive: true });

      const date = new Date().toISOString().split('T')[0];
      const filename = `${date}-${name}.md`;
      const filePath = path.join(conversationsDir, filename);

      const markdown = formatTranscriptMarkdown(
        messages,
        summary,
        assistantName,
      );
      fs.writeFileSync(filePath, markdown);

      log(`Archived conversation to ${filePath}`);
    } catch (err) {
      log(
        `Failed to archive transcript: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    return {};
  };
}

function sanitizeFilename(summary: string): string {
  return summary
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 50);
}

function generateFallbackName(): string {
  const time = new Date();
  return `conversation-${time.getHours().toString().padStart(2, '0')}${time.getMinutes().toString().padStart(2, '0')}`;
}

interface ParsedMessage {
  role: 'user' | 'assistant';
  content: string;
}

function parseTranscript(content: string): ParsedMessage[] {
  const messages: ParsedMessage[] = [];

  for (const line of content.split('\n')) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line);
      if (entry.type === 'user' && entry.message?.content) {
        const text =
          typeof entry.message.content === 'string'
            ? entry.message.content
            : entry.message.content
                .map((c: { text?: string }) => c.text || '')
                .join('');
        if (text) messages.push({ role: 'user', content: text });
      } else if (entry.type === 'assistant' && entry.message?.content) {
        const textParts = entry.message.content
          .filter((c: { type: string }) => c.type === 'text')
          .map((c: { text: string }) => c.text);
        const text = textParts.join('');
        if (text) messages.push({ role: 'assistant', content: text });
      }
    } catch {}
  }

  return messages;
}

function formatTranscriptMarkdown(
  messages: ParsedMessage[],
  title?: string | null,
  assistantName?: string,
): string {
  const now = new Date();
  const formatDateTime = (d: Date) =>
    d.toLocaleString('en-US', {
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
      hour12: true,
    });

  const lines: string[] = [];
  lines.push(`# ${title || 'Conversation'}`);
  lines.push('');
  lines.push(`Archived: ${formatDateTime(now)}`);
  lines.push('');
  lines.push('---');
  lines.push('');

  for (const msg of messages) {
    const sender = msg.role === 'user' ? 'User' : assistantName || 'Assistant';
    const content =
      msg.content.length > 2000
        ? msg.content.slice(0, 2000) + '...'
        : msg.content;
    lines.push(`**${sender}**: ${content}`);
    lines.push('');
  }

  return lines.join('\n');
}

/**
 * Check for _close sentinel.
 */
function shouldClose(): boolean {
  if (fs.existsSync(IPC_INPUT_CLOSE_SENTINEL)) {
    try {
      fs.unlinkSync(IPC_INPUT_CLOSE_SENTINEL);
    } catch {
      /* ignore */
    }
    return true;
  }
  return false;
}

/**
 * Build a content block array from text + optional images.
 * Images come first so the model sees them before the text context.
 */
function buildContent(
  text: string,
  images?: ImageAttachment[],
): string | ContentBlock[] {
  if (!images?.length) return text;
  const blocks: ContentBlock[] = [
    ...images.map(
      (img): ImageBlock => ({
        type: 'image',
        source: { type: 'base64', media_type: img.mimeType, data: img.base64 },
      }),
    ),
    { type: 'text', text },
  ];
  return blocks;
}

/**
 * Drain all pending IPC input messages.
 * Returns content (string or content blocks) for each message found.
 */
function drainIpcInput(): Array<string | ContentBlock[]> {
  try {
    fs.mkdirSync(IPC_INPUT_DIR, { recursive: true });
    const files = fs
      .readdirSync(IPC_INPUT_DIR)
      .filter((f) => f.endsWith('.json'))
      .sort();

    const messages: Array<string | ContentBlock[]> = [];
    for (const file of files) {
      const filePath = path.join(IPC_INPUT_DIR, file);
      try {
        const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
        fs.unlinkSync(filePath);
        if (data.type === 'message' && data.text) {
          messages.push(buildContent(data.text, data.images));
        }
      } catch (err) {
        log(
          `Failed to process input file ${file}: ${err instanceof Error ? err.message : String(err)}`,
        );
        try {
          fs.unlinkSync(filePath);
        } catch {
          /* ignore */
        }
      }
    }
    return messages;
  } catch (err) {
    log(`IPC drain error: ${err instanceof Error ? err.message : String(err)}`);
    return [];
  }
}

/**
 * Wait for a new IPC message or _close sentinel.
 * Returns content for the next message, or null if _close.
 */
function waitForIpcMessage(): Promise<string | ContentBlock[] | null> {
  return new Promise((resolve) => {
    const poll = () => {
      if (shouldClose()) {
        resolve(null);
        return;
      }
      const messages = drainIpcInput();
      if (messages.length > 0) {
        // Join multiple text-only messages; for messages with images return first
        const first = messages[0];
        if (messages.length === 1 || typeof first !== 'string') {
          resolve(first);
        } else {
          resolve(messages.filter((m) => typeof m === 'string').join('\n'));
        }
        return;
      }
      setTimeout(poll, IPC_POLL_MS);
    };
    poll();
  });
}

/**
 * Check if an MCP server is allowed for the given container input.
 * Main group always gets all servers; non-main must explicitly opt in via toolPermissions.
 */
function mcpAllowed(name: string, containerInput: ContainerInput): boolean {
  if (containerInput.isMain) return true;
  if ((containerInput.toolPermissions?.mcpServers ?? []).includes(name)) {
    return true;
  }
  return (containerInput.toolPermissions?.mcpServerProfiles ?? []).some(
    (profileId) => profileId === name || profileId.startsWith(`${name}:`),
  );
}

function getAllowedToolProfiles(
  containerInput: ContainerInput,
): ResolvedToolProfile[] {
  return (containerInput.resolvedToolProfiles ?? []).filter(
    (profile) =>
      containerInput.isMain || mcpAllowed(profile.tool, containerInput),
  );
}

function getProfileMountPath(
  profile: ResolvedToolProfile,
  basename: string,
): string | null {
  const mount = profile.mounts.find(
    (candidate) => path.basename(candidate.hostPath) === basename,
  );
  return mount?.containerPath ?? null;
}

function buildNpxCacheEnv(
  profile: ResolvedToolProfile,
): Record<string, string> {
  const cacheDir = path.join('/tmp', 'nanoclaw-npm-cache', profile.serverName);
  return {
    NPM_CONFIG_CACHE: cacheDir,
    npm_config_cache: cacheDir,
  };
}

function buildProfileMcpServerConfig(profile: ResolvedToolProfile): {
  command: string;
  args: string[];
  env?: Record<string, string>;
} | null {
  switch (profile.tool) {
    case 'gmail':
      return {
        command: 'npx',
        args: ['-y', '@gongrzhe/server-gmail-autoauth-mcp'],
        env: {
          HOME: profile.homeDir,
          ...buildNpxCacheEnv(profile),
          // esbuild's postinstall downloads a native binary that fails in containers,
          // causing npm to reject the whole install. The server is pre-compiled so
          // esbuild is not needed at runtime — skip all postinstall scripts.
          npm_config_ignore_scripts: 'true',
        },
      };
    case 'google-calendar':
      return {
        command: 'npx',
        args: ['-y', '@cocal/google-calendar-mcp'],
        env: {
          HOME: profile.homeDir,
          ...buildNpxCacheEnv(profile),
          GOOGLE_OAUTH_CREDENTIALS: path.join(
            profile.homeDir,
            '.gcal-mcp',
            'gcp-oauth.keys.json',
          ),
          GOOGLE_CALENDAR_MCP_TOKEN_PATH: path.join(
            profile.homeDir,
            '.config',
            'google-calendar-mcp',
            'tokens.json',
          ),
        },
      };
    case 'google-tasks-vrob':
      return {
        command: 'npx',
        args: ['-y', 'mcp-googletasks-vrob'],
        env: {
          HOME: profile.homeDir,
          ...buildNpxCacheEnv(profile),
          GOOGLE_CLIENT_ID: process.env.GOOGLE_TASKS_CLIENT_ID ?? '',
          GOOGLE_CLIENT_SECRET: process.env.GOOGLE_TASKS_CLIENT_SECRET ?? '',
        },
      };
    case 'littlelives':
      return {
        command: 'node',
        args: [path.join(profile.homeDir, '.littlelives', 'mcp.js')],
        env: {
          HOME: profile.homeDir,
        },
      };
    case 'ynab':
      return {
        command: 'node',
        args: [path.join(profile.homeDir, '.ynab', 'mcp.js')],
        env: {
          HOME: profile.homeDir,
        },
      };
    case 'trakt':
      return {
        command: 'node',
        args: [path.join(profile.homeDir, '.trakt', 'mcp.js')],
        env: {
          HOME: profile.homeDir,
        },
      };
    case 'ibkr':
      return {
        command: 'node',
        args: [path.join(profile.homeDir, '.ibkr', 'mcp.js')],
        env: {
          HOME: profile.homeDir,
        },
      };
    case 'notion':
      return {
        ...resolveMcpRemoteCommand('mcp-remote', 'https://mcp.notion.com/mcp'),
        env: {
          HOME: profile.homeDir,
          ...buildNpxCacheEnv(profile),
        },
      };
    case 'atlassian':
      return {
        ...resolveMcpRemoteCommand(
          'mcp-remote',
          'https://mcp.atlassian.com/v1/mcp',
        ),
        env: {
          HOME: profile.homeDir,
          ...buildNpxCacheEnv(profile),
        },
      };
    case 'slack':
      return {
        command: 'node',
        args: [path.join(profile.homeDir, '.slack', 'mcp.js')],
        env: {
          HOME: profile.homeDir,
        },
      };
    default:
      return null;
  }
}

function buildDirectMcpServerConfig(tool: string): {
  command: string;
  args: string[];
  env?: Record<string, string>;
} | null {
  switch (tool) {
    case 'ahrefs': {
      const key = process.env.AHREFS_MCP_KEY ?? '';
      if (!key) {
        log('AHREFS_MCP_KEY is not set; Ahrefs MCP server will be skipped');
        return null;
      }
      const command = resolveMcpRemoteCommand(
        'mcp-remote',
        'https://api.ahrefs.com/mcp/mcp',
      );

      return {
        ...command,
        args: [
          ...command.args,
          '--transport',
          'http-only',
          '--header',
          'Authorization:Bearer ${AHREFS_MCP_KEY}',
        ],
        env: {
          AHREFS_MCP_KEY: key,
          HOME: '/home/node',
        },
      };
    }
    default:
      return null;
  }
}

function execFileResult(
  command: string,
  args: string[],
  options: {
    env?: NodeJS.ProcessEnv;
    timeout?: number;
    cwd?: string;
  } = {},
): Promise<{ ok: boolean; output: string; error?: string }> {
  return new Promise((resolve) => {
    execFile(
      command,
      args,
      {
        env: options.env,
        timeout: options.timeout,
        cwd: options.cwd,
        maxBuffer: 1024 * 1024,
      },
      (error, stdout, stderr) => {
        const output = `${stdout || ''}\n${stderr || ''}`.trim();
        if (!error) {
          resolve({ ok: true, output });
          return;
        }

        resolve({
          ok: false,
          output,
          error: error.message,
        });
      },
    );
  });
}

async function probeNotionProfile(
  profile: ResolvedToolProfile,
  sdkEnv: Record<string, string | undefined>,
): Promise<ToolRuntimeStatus> {
  const authDir = path.join(profile.homeDir, '.mcp-auth');
  if (!fs.existsSync(authDir)) {
    return {
      profileId: profile.profileId,
      tool: profile.tool,
      transport: 'mcp',
      auth: 'missing',
      source: 'filesystem',
      detail: `Missing auth directory at ${authDir}`,
    };
  }
  const command = resolveMcpRemoteCommand(
    'mcp-remote-client',
    'https://mcp.notion.com/mcp',
  );

  const result = await execFileResult(
    command.command,
    command.args,
    {
      env: {
        ...process.env,
        ...sdkEnv,
        HOME: profile.homeDir,
        ...buildNpxCacheEnv(profile),
      },
      timeout: 20000,
    },
  );
  const classified = classifyNotionProbeResult(result);

  return {
    profileId: profile.profileId,
    tool: profile.tool,
    transport: 'mcp',
    auth: classified.auth,
    source: 'live_probe',
    detail: classified.detail,
  };
}

async function probeGwsProfile(
  profile: ResolvedToolProfile,
  sdkEnv: Record<string, string | undefined>,
): Promise<ToolRuntimeStatus> {
  const configDir = path.join(profile.homeDir, '.config', 'gws');
  const credentialsPath = path.join(configDir, 'credentials.json');
  if (!fs.existsSync(credentialsPath)) {
    return {
      profileId: profile.profileId,
      tool: profile.tool,
      transport: 'shell',
      auth: 'missing',
      source: 'filesystem',
      detail: `Missing credentials file at ${credentialsPath}`,
    };
  }

  const gwsPath = getProfileMountPath(profile, 'gws') || 'gws';
  const result = await execFileResult(
    gwsPath,
    [
      'calendar',
      'calendarList',
      'list',
      '--params',
      '{"maxResults":1}',
      '--format',
      'json',
    ],
    {
      env: {
        ...process.env,
        ...sdkEnv,
        HOME: profile.homeDir,
        GOOGLE_WORKSPACE_CLI_CONFIG_DIR: configDir,
        GOOGLE_WORKSPACE_CLI_CREDENTIALS_FILE: credentialsPath,
      },
      timeout: 15000,
    },
  );

  if (result.ok) {
    return {
      profileId: profile.profileId,
      tool: profile.tool,
      transport: 'shell',
      auth: 'working',
      source: 'live_probe',
      detail: 'GWS calendar probe succeeded in this container run',
    };
  }

  const haystack = `${result.output}\n${result.error || ''}`.toLowerCase();
  const authFailed =
    haystack.includes('auth') ||
    haystack.includes('oauth') ||
    haystack.includes('credential') ||
    haystack.includes('token') ||
    haystack.includes('unauthorized') ||
    haystack.includes('forbidden');

  return {
    profileId: profile.profileId,
    tool: profile.tool,
    transport: 'shell',
    auth: authFailed ? 'auth_failed' : 'unknown',
    source: 'live_probe',
    detail: result.error || result.output || 'GWS probe failed',
  };
}

async function getToolRuntimeStatus(
  profile: ResolvedToolProfile,
  sdkEnv: Record<string, string | undefined>,
): Promise<ToolRuntimeStatus> {
  switch (profile.tool) {
    case 'notion':
      return probeNotionProfile(profile, sdkEnv);
    case 'gws':
      return probeGwsProfile(profile, sdkEnv);
    default: {
      const hasAnyMount = profile.mounts.some((mount) =>
        fs.existsSync(mount.containerPath),
      );
      return {
        profileId: profile.profileId,
        tool: profile.tool,
        transport: buildProfileMcpServerConfig(profile) ? 'mcp' : 'unknown',
        auth: hasAnyMount ? 'unknown' : 'missing',
        source: 'filesystem',
        detail: hasAnyMount
          ? 'Profile mounts are present; no live auth probe implemented'
          : 'Expected profile mounts are missing',
      };
    }
  }
}

function getSingleProfileToolAliases(
  profiles: ResolvedToolProfile[],
): Map<string, ResolvedToolProfile> {
  const byTool = new Map<string, ResolvedToolProfile[]>();
  for (const profile of profiles) {
    const toolProfiles = byTool.get(profile.tool) ?? [];
    toolProfiles.push(profile);
    byTool.set(profile.tool, toolProfiles);
  }

  const aliases = new Map<string, ResolvedToolProfile>();
  for (const [tool, toolProfiles] of byTool.entries()) {
    if (toolProfiles.length === 1) {
      aliases.set(tool, toolProfiles[0]);
    }
  }
  return aliases;
}

function ensureLegacyToolHomes(profiles: ResolvedToolProfile[]): void {
  const legacyDirs: Record<
    string,
    { source: (profile: ResolvedToolProfile) => string; target: string }
  > = {
    littlelives: {
      source: (profile) => path.join(profile.homeDir, '.littlelives'),
      target: '/home/node/.littlelives',
    },
    ynab: {
      source: (profile) => path.join(profile.homeDir, '.ynab'),
      target: '/home/node/.ynab',
    },
    trakt: {
      source: (profile) => path.join(profile.homeDir, '.trakt'),
      target: '/home/node/.trakt',
    },
    ibkr: {
      source: (profile) => path.join(profile.homeDir, '.ibkr'),
      target: '/home/node/.ibkr',
    },
    slack: {
      source: (profile) => path.join(profile.homeDir, '.slack'),
      target: '/home/node/.slack',
    },
    notion: {
      source: (profile) => path.join(profile.homeDir, '.mcp-auth'),
      target: '/home/node/.mcp-auth',
    },
    gws: {
      source: (profile) => path.join(profile.homeDir, '.config', 'gws'),
      target: '/home/node/.config/gws',
    },
  };

  for (const profile of profiles) {
    const legacyDir = legacyDirs[profile.tool];
    if (!legacyDir) continue;

    const sourceDir = legacyDir.source(profile);
    if (!fs.existsSync(sourceDir)) continue;
    fs.mkdirSync(path.dirname(legacyDir.target), { recursive: true });

    try {
      if (
        fs.existsSync(legacyDir.target) ||
        fs.lstatSync(legacyDir.target).isSymbolicLink()
      ) {
        fs.rmSync(legacyDir.target, { recursive: true, force: true });
      }
    } catch {
      // Ignore missing paths and continue to recreate the legacy alias.
    }

    try {
      fs.symlinkSync(sourceDir, legacyDir.target, 'dir');
    } catch (err) {
      log(
        `Failed to create legacy home alias for ${profile.tool}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }
}

function ensureShellToolAliases(
  profiles: ResolvedToolProfile[],
): string | null {
  const binDir = '/tmp/nanoclaw-profile-bin';
  fs.mkdirSync(binDir, { recursive: true });

  let created = false;
  for (const profile of profiles) {
    for (const mount of profile.mounts) {
      if (!fs.existsSync(mount.containerPath)) continue;

      let stats: fs.Stats;
      try {
        stats = fs.statSync(mount.containerPath);
      } catch {
        continue;
      }

      if (!stats.isFile()) continue;

      const aliasName = path.basename(mount.hostPath);
      if (!aliasName || aliasName.includes(path.sep)) continue;

      const aliasPath = path.join(binDir, aliasName);
      try {
        if (fs.existsSync(aliasPath) || fs.lstatSync(aliasPath).isSymbolicLink()) {
          fs.rmSync(aliasPath, { force: true });
        }
      } catch {
        // Ignore stale/missing alias cleanup failures and retry the symlink.
      }

      try {
        fs.symlinkSync(mount.containerPath, aliasPath);
        created = true;
      } catch (err) {
        log(
          `Failed to create shell alias for ${profile.tool} (${aliasName}): ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    }
  }

  return created ? binDir : null;
}

function getShellToolAliases(profiles: ResolvedToolProfile[]): string[] {
  const aliases = new Set<string>();

  for (const profile of profiles) {
    for (const mount of profile.mounts) {
      if (!fs.existsSync(mount.containerPath)) continue;

      let stats: fs.Stats;
      try {
        stats = fs.statSync(mount.containerPath);
      } catch {
        continue;
      }

      if (!stats.isFile()) continue;

      const aliasName = path.basename(mount.hostPath);
      if (!aliasName || aliasName.includes(path.sep)) continue;
      aliases.add(aliasName);
    }
  }

  return [...aliases].sort();
}

async function buildToolAccessContext(
  containerInput: ContainerInput,
  sdkEnv: Record<string, string | undefined>,
): Promise<{ promptPrefix: string; runtimeStatuses: ToolRuntimeStatus[] }> {
  const allowedProfiles = getAllowedToolProfiles(containerInput);
  const toolFamilies = [...new Set(allowedProfiles.map((p) => p.tool))].sort();
  const profileIds = allowedProfiles.map((p) => p.profileId).sort();
  const callableToolPrefixes = new Set<string>();
  for (const profile of allowedProfiles) {
    if (!buildProfileMcpServerConfig(profile)) continue;
    callableToolPrefixes.add(`mcp__${profile.serverName}__*`);
  }
  for (const [tool, profile] of getSingleProfileToolAliases(allowedProfiles)) {
    if (!buildProfileMcpServerConfig(profile)) continue;
    callableToolPrefixes.add(`mcp__${tool}__*`);
  }
  const callableToolPrefixList = [...callableToolPrefixes].sort();
  const shellToolAliases = getShellToolAliases(allowedProfiles);
  const runtimeStatuses = await Promise.all(
    allowedProfiles.map((profile) => getToolRuntimeStatus(profile, sdkEnv)),
  );
  const runtimeStatusLines = runtimeStatuses
    .map(
      (status) =>
        `${status.profileId} tool=${status.tool} transport=${status.transport} auth=${status.auth} source=${status.source} detail="${status.detail.replace(/\s+/g, ' ').trim().slice(0, 160)}"`,
    )
    .sort();

  return {
    promptPrefix: [
    '<active_tool_access>',
    `main_group=${containerInput.isMain ? 'yes' : 'no'}`,
    `tool_families=${toolFamilies.length > 0 ? toolFamilies.join(', ') : 'none'}`,
    `profile_ids=${profileIds.length > 0 ? profileIds.join(', ') : 'none'}`,
    `callable_tool_prefixes=${callableToolPrefixList.length > 0 ? callableToolPrefixList.join(', ') : 'none'}`,
    `shell_tool_aliases=${shellToolAliases.length > 0 ? shellToolAliases.join(', ') : 'none'}`,
    `runtime_tool_status=${runtimeStatusLines.length > 0 ? 'present' : 'none'}`,
    'Use callable_tool_prefixes only as server-name prefixes; they are not exact tool names.',
    'Do not invent specific MCP method names such as search/create/update from a prefix alone.',
    'If a guessed MCP tool returns "no such tool", treat that as evidence the exact tool name is wrong before claiming the server is missing or not mounted.',
    'Use shell_tool_aliases via Bash as normal commands already on PATH inside the container.',
    'Treat runtime_tool_status as the source of truth for this container run, even if earlier messages claimed a tool was broken.',
    'If a tool shows auth=working, do not claim its auth is expired without a new contradictory live check.',
    'If a tool shows auth=unknown and you need it, perform a live check before claiming an auth problem.',
    'When the user asks which tools or profiles are active, report profile_ids, callable_tool_prefixes, shell_tool_aliases, and runtime_tool_status.',
    'Do not say an MCP server is unavailable solely because one inferred tool name failed.',
    ...runtimeStatusLines,
    '</active_tool_access>',
    '',
    ].join('\n'),
    runtimeStatuses,
  };
}

/**
 * Run a single query and stream results via writeOutput.
 * Uses MessageStream (AsyncIterable) to keep isSingleUserTurn=false,
 * allowing agent teams subagents to run to completion.
 * Also pipes IPC messages into the stream during the query.
 */
async function runQuery(
  prompt: string | ContentBlock[],
  sessionId: string | undefined,
  mcpServerPath: string,
  containerInput: ContainerInput,
  sdkEnv: Record<string, string | undefined>,
  toolRuntimeStatuses: ToolRuntimeStatus[],
  resumeAt?: string,
): Promise<{
  newSessionId?: string;
  lastAssistantUuid?: string;
  closedDuringQuery: boolean;
}> {
  const stream = new MessageStream();
  stream.push(prompt);

  // Poll IPC for follow-up messages and _close sentinel during the query
  let ipcPolling = true;
  let closedDuringQuery = false;
  const pollIpcDuringQuery = () => {
    if (!ipcPolling) return;
    if (shouldClose()) {
      log('Close sentinel detected during query, ending stream');
      closedDuringQuery = true;
      stream.end();
      ipcPolling = false;
      return;
    }
    const messages = drainIpcInput();
    for (const content of messages) {
      const len = typeof content === 'string' ? content.length : content.length;
      log(`Piping IPC message into active query (${len} blocks/chars)`);
      stream.push(content);
    }
    setTimeout(pollIpcDuringQuery, IPC_POLL_MS);
  };
  setTimeout(pollIpcDuringQuery, IPC_POLL_MS);

  let newSessionId: string | undefined;
  let lastAssistantUuid: string | undefined;
  let messageCount = 0;
  let resultCount = 0;

  // Load global CLAUDE.md as additional system context (shared across all groups)
  const globalClaudeMdPath = '/workspace/global/CLAUDE.md';
  let globalClaudeMd: string | undefined;
  if (fs.existsSync(globalClaudeMdPath)) {
    globalClaudeMd = fs.readFileSync(globalClaudeMdPath, 'utf-8');
  }

  // Discover additional directories mounted at /workspace/extra/*
  // These are passed to the SDK so their CLAUDE.md files are loaded automatically
  const extraDirs: string[] = [];
  const extraBase = '/workspace/extra';
  if (fs.existsSync(extraBase)) {
    for (const entry of fs.readdirSync(extraBase)) {
      const fullPath = path.join(extraBase, entry);
      if (fs.statSync(fullPath).isDirectory()) {
        extraDirs.push(fullPath);
      }
    }
  }
  if (extraDirs.length > 0) {
    log(`Additional directories: ${extraDirs.join(', ')}`);
  }

  const allowedToolProfiles = getAllowedToolProfiles(containerInput);
  ensureLegacyToolHomes(allowedToolProfiles);
  const singleProfileAliases = getSingleProfileToolAliases(allowedToolProfiles);
  if (singleProfileAliases.has('gws')) {
    sdkEnv.GOOGLE_WORKSPACE_CLI_CONFIG_DIR = '/home/node/.config/gws';
    sdkEnv.GOOGLE_WORKSPACE_CLI_CREDENTIALS_FILE =
      '/home/node/.config/gws/credentials.json';
  }
  const shellToolAliasDir = ensureShellToolAliases(allowedToolProfiles);
  if (shellToolAliasDir) {
    sdkEnv.PATH = `${shellToolAliasDir}:${sdkEnv.PATH || ''}`;
  }
  const externalMcpServers = Object.fromEntries(
    allowedToolProfiles.flatMap((profile) => {
      const config = buildProfileMcpServerConfig(profile);
      return config ? [[profile.serverName, config]] : [];
    }),
  );
  const allowedToolPatterns = new Set<string>();
  for (const profile of allowedToolProfiles) {
    if (!buildProfileMcpServerConfig(profile)) continue;
    allowedToolPatterns.add(`mcp__${profile.serverName}__*`);
  }
  for (const [tool, profile] of singleProfileAliases) {
    const config = buildProfileMcpServerConfig(profile);
    if (!config) continue;
    allowedToolPatterns.add(`mcp__${tool}__*`);
    externalMcpServers[tool] = config;
  }
  for (const tool of containerInput.toolPermissions?.mcpServers ?? []) {
    if (externalMcpServers[tool]) continue;
    const config = buildDirectMcpServerConfig(tool);
    if (!config) continue;
    allowedToolPatterns.add(`mcp__${tool}__*`);
    externalMcpServers[tool] = config;
  }

  for await (const message of query({
    prompt: stream,
    options: {
      cwd: '/workspace/group',
      additionalDirectories: extraDirs.length > 0 ? extraDirs : undefined,
      resume: sessionId,
      resumeSessionAt: resumeAt,
      systemPrompt: globalClaudeMd
        ? {
            type: 'preset' as const,
            preset: 'claude_code' as const,
            append: globalClaudeMd,
          }
        : undefined,
      allowedTools: [
        'Bash',
        'Read',
        'Write',
        'Edit',
        'Glob',
        'Grep',
        'WebSearch',
        'WebFetch',
        'Task',
        'TaskOutput',
        'TaskStop',
        'TeamCreate',
        'TeamDelete',
        'SendMessage',
        'TodoWrite',
        'ToolSearch',
        'Skill',
        'NotebookEdit',
        'mcp__nanoclaw__*',
        ...allowedToolPatterns,
      ],
      env: sdkEnv,
      permissionMode: 'bypassPermissions',
      allowDangerouslySkipPermissions: true,
      settingSources: ['project', 'user'],
      mcpServers: {
        nanoclaw: {
          command: 'node',
          args: [mcpServerPath],
          env: {
            NANOCLAW_CHAT_JID: containerInput.chatJid,
            NANOCLAW_GROUP_FOLDER: containerInput.groupFolder,
            NANOCLAW_IS_MAIN: containerInput.isMain ? '1' : '0',
          },
        },
        ...externalMcpServers,
      },
      hooks: {
        PreCompact: [
          { hooks: [createPreCompactHook(containerInput.assistantName)] },
        ],
      },
    },
  })) {
    messageCount++;
    const msgType =
      message.type === 'system'
        ? `system/${(message as { subtype?: string }).subtype}`
        : message.type;
    log(`[msg #${messageCount}] type=${msgType}`);

    if (message.type === 'assistant' && 'uuid' in message) {
      lastAssistantUuid = (message as { uuid: string }).uuid;
    }

    if (message.type === 'system' && message.subtype === 'init') {
      newSessionId = message.session_id;
      log(`Session initialized: ${newSessionId}`);
    }

    if (
      message.type === 'system' &&
      (message as { subtype?: string }).subtype === 'task_notification'
    ) {
      const tn = message as {
        task_id: string;
        status: string;
        summary: string;
      };
      log(
        `Task notification: task=${tn.task_id} status=${tn.status} summary=${tn.summary}`,
      );
    }

    if (message.type === 'result') {
      resultCount++;
      const textResult =
        'result' in message ? (message as { result?: string }).result : null;
      log(
        `Result #${resultCount}: subtype=${message.subtype}${textResult ? ` text=${textResult.slice(0, 200)}` : ''}`,
      );
      writeOutput({
        status: 'success',
        result: textResult || null,
        newSessionId,
        toolRuntimeStatuses,
      });
      // End the stream after each result so the query finishes cleanly.
      // The main loop will restart runQuery() for the next message, giving
      // fresh MCP server connections and preventing tool dropout in long sessions.
      ipcPolling = false;
      stream.end();
    }
  }

  ipcPolling = false;
  log(
    `Query done. Messages: ${messageCount}, results: ${resultCount}, lastAssistantUuid: ${lastAssistantUuid || 'none'}, closedDuringQuery: ${closedDuringQuery}`,
  );
  return { newSessionId, lastAssistantUuid, closedDuringQuery };
}

interface ScriptResult {
  wakeAgent: boolean;
  data?: unknown;
}

const SCRIPT_TIMEOUT_MS = 30_000;

async function runScript(script: string): Promise<ScriptResult | null> {
  const scriptPath = '/tmp/task-script.sh';
  fs.writeFileSync(scriptPath, script, { mode: 0o755 });

  return new Promise((resolve) => {
    execFile('bash', [scriptPath], {
      timeout: SCRIPT_TIMEOUT_MS,
      maxBuffer: 1024 * 1024,
      env: process.env,
    }, (error, stdout, stderr) => {
      if (stderr) {
        log(`Script stderr: ${stderr.slice(0, 500)}`);
      }

      if (error) {
        log(`Script error: ${error.message}`);
        return resolve(null);
      }

      // Parse last non-empty line of stdout as JSON
      const lines = stdout.trim().split('\n');
      const lastLine = lines[lines.length - 1];
      if (!lastLine) {
        log('Script produced no output');
        return resolve(null);
      }

      try {
        const result = JSON.parse(lastLine);
        if (typeof result.wakeAgent !== 'boolean') {
          log(`Script output missing wakeAgent boolean: ${lastLine.slice(0, 200)}`);
          return resolve(null);
        }
        resolve(result as ScriptResult);
      } catch {
        log(`Script output is not valid JSON: ${lastLine.slice(0, 200)}`);
        resolve(null);
      }
    });
  });
}

async function main(): Promise<void> {
  let containerInput: ContainerInput;

  try {
    const stdinData = await readStdin();
    containerInput = JSON.parse(stdinData);
    try {
      fs.unlinkSync('/tmp/input.json');
    } catch {
      /* may not exist */
    }
    log(`Received input for group: ${containerInput.groupFolder}`);
  } catch (err) {
    writeOutput({
      status: 'error',
      result: null,
      error: `Failed to parse input: ${err instanceof Error ? err.message : String(err)}`,
    });
    process.exit(1);
  }

  // Credentials are injected by the host's credential proxy via ANTHROPIC_BASE_URL.
  // No real secrets exist in the container environment.
  const sdkEnv: Record<string, string | undefined> = { ...process.env };

  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const mcpServerPath = path.join(__dirname, 'ipc-mcp-stdio.js');

  let sessionId = containerInput.sessionId;
  fs.mkdirSync(IPC_INPUT_DIR, { recursive: true });

  // Clean up stale _close sentinel from previous container runs
  try {
    fs.unlinkSync(IPC_INPUT_CLOSE_SENTINEL);
  } catch {
    /* ignore */
  }

  // Build initial prompt (drain any pending IPC messages too)
  let promptText = containerInput.prompt;
  const toolAccessContext = await buildToolAccessContext(containerInput, sdkEnv);
  const runtimeToolStatuses = toolAccessContext.runtimeStatuses;
  promptText = toolAccessContext.promptPrefix + promptText;
  if (containerInput.isScheduledTask) {
    promptText = `[SCHEDULED TASK - The following message was sent automatically and is not coming directly from the user or group.]\n\n${promptText}`;
  }
  const pending = drainIpcInput();
  if (pending.length > 0) {
    log(`Draining ${pending.length} pending IPC messages into initial prompt`);
    // Append only text IPC messages to the initial prompt text
    const textParts = pending.filter((m): m is string => typeof m === 'string');
    if (textParts.length > 0) promptText += '\n' + textParts.join('\n');
  }
  // prompt is string | ContentBlock[] depending on whether images are attached
  let prompt: string | ContentBlock[] = buildContent(
    promptText,
    containerInput.images,
  );

  // Script phase: run script before waking agent
  if (containerInput.script && containerInput.isScheduledTask) {
    log('Running task script...');
    const scriptResult = await runScript(containerInput.script);

    if (!scriptResult || !scriptResult.wakeAgent) {
      const reason = scriptResult ? 'wakeAgent=false' : 'script error/no output';
      log(`Script decided not to wake agent: ${reason}`);
      writeOutput({
        status: 'success',
        result: null,
        toolRuntimeStatuses: runtimeToolStatuses,
      });
      return;
    }

    // Script says wake agent — enrich prompt with script data
    log(`Script wakeAgent=true, enriching prompt with data`);
    prompt = `[SCHEDULED TASK]\n\nScript output:\n${JSON.stringify(scriptResult.data, null, 2)}\n\nInstructions:\n${containerInput.prompt}`;
  }

  // Query loop: run query → wait for IPC message → run new query → repeat
  let resumeAt: string | undefined;
  try {
    while (true) {
      log(
        `Starting query (session: ${sessionId || 'new'}, resumeAt: ${resumeAt || 'latest'})...`,
      );

      const queryResult = await runQuery(
        prompt,
        sessionId,
        mcpServerPath,
        containerInput,
        sdkEnv,
        runtimeToolStatuses,
        resumeAt,
      );
      if (queryResult.newSessionId) {
        sessionId = queryResult.newSessionId;
      }
      if (queryResult.lastAssistantUuid) {
        resumeAt = queryResult.lastAssistantUuid;
      }

      // If _close was consumed during the query, exit immediately.
      // Don't emit a session-update marker (it would reset the host's
      // idle timer and cause a 30-min delay before the next _close).
      if (queryResult.closedDuringQuery) {
        log('Close sentinel consumed during query, exiting');
        break;
      }

      // Emit session update so host can track it
      writeOutput({
        status: 'success',
        result: null,
        newSessionId: sessionId,
        toolRuntimeStatuses: runtimeToolStatuses,
      });

      log('Query ended, waiting for next IPC message...');

      // Wait for the next message or _close sentinel
      const nextMessage = await waitForIpcMessage();
      if (nextMessage === null) {
        log('Close sentinel received, exiting');
        break;
      }

      log(`Got new message (${nextMessage.length} chars), starting new query`);
      prompt = nextMessage;
    }
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    log(`Agent error: ${errorMessage}`);
    writeOutput({
      status: 'error',
      result: null,
      newSessionId: sessionId,
      error: errorMessage,
      toolRuntimeStatuses: runtimeToolStatuses,
    });
    process.exit(1);
  }
}

main();
