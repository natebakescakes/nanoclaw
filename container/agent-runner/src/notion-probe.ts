export interface ProbeResultLike {
  ok: boolean;
  output: string;
  error?: string;
}

export function classifyNotionProbeResult(result: ProbeResultLike): {
  auth: 'working' | 'auth_failed' | 'unknown';
  detail: string;
} {
  const detail = result.error || result.output || 'Notion probe failed';
  const haystack = `${result.output}\n${result.error || ''}`.toLowerCase();

  const connected =
    haystack.includes('connected successfully!') &&
    (haystack.includes('requesting tools list') ||
      haystack.includes('"tools"') ||
      haystack.includes('received message:'));

  if (result.ok || connected) {
    return {
      auth: 'working',
      detail: 'Connected to Notion MCP and listed tools in this container run',
    };
  }

  const authFailed =
    haystack.includes('authentication required') ||
    haystack.includes('waiting for authorization') ||
    haystack.includes('please authorize this client') ||
    haystack.includes('expired') ||
    haystack.includes('401') ||
    haystack.includes('403') ||
    haystack.includes('token') ||
    haystack.includes('oauth') ||
    haystack.includes('unauthorized') ||
    haystack.includes('forbidden');

  return {
    auth: authFailed ? 'auth_failed' : 'unknown',
    detail,
  };
}
