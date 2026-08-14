import { basename, resolve } from 'node:path';

interface XiaojingGeoContext {
  workspace?: string;
  sessionId: string;
}

let context: XiaojingGeoContext = { sessionId: 'default' };

export function configureXiaojingGeo(
  _env: Record<string, string>,
  next: XiaojingGeoContext,
): void {
  context = {
    sessionId: next.sessionId,
    ...(next.workspace ? { workspace: resolve(next.workspace) } : {}),
  };
}

export function xiaojingGeoContextSnapshot(): {
  brandWorkspaceId: string | null;
  sessionId: string;
  capabilities: Array<{ id: string; status: 'available' | 'planned' }>;
} {
  return {
    brandWorkspaceId: context.workspace ? basename(context.workspace) : null,
    sessionId: context.sessionId,
    capabilities: [
      { id: 'inspect-brand-context', status: 'available' },
      { id: 'brand-knowledge', status: 'planned' },
      { id: 'question-opportunities', status: 'planned' },
      { id: 'content-production', status: 'planned' },
      { id: 'geo-observation', status: 'planned' },
    ],
  };
}

/**
 * Product-owned MCP boundary for Xiaojing. Later GEO slices extend this one
 * server instead of exposing generic SDK, filesystem, plugin or external MCP
 * surfaces to the main Agent.
 */
export async function createXiaojingGeoServer() {
  const { createSdkMcpServer, tool } = await import('@anthropic-ai/claude-agent-sdk');
  const { z } = await import('zod/v4');
  return createSdkMcpServer({
    name: 'xiaojing-geo',
    version: '1.0.0',
    instructions: 'Only report capabilities marked available. Never invent results for planned GEO slices.',
    alwaysLoad: true,
    tools: [
      tool(
        'inspect_brand_context',
        'Read the current Xiaojing brand/session identity and the registered GEO capability availability. Call this before proposing a GEO action.',
        { reason: z.string().max(200).optional().describe('Why the current GEO context is needed.') },
        async () => ({
          content: [{ type: 'text' as const, text: JSON.stringify(xiaojingGeoContextSnapshot()) }],
        }),
        { alwaysLoad: true },
      ),
    ],
  });
}
