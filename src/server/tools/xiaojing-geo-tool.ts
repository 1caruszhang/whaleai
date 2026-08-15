import { basename, resolve } from 'node:path';

import { getXiaojingGeoProviderCapabilities } from '../geo/provider-runtime';
import {
  createKnowledgeAuthority,
  type FactKeyInput,
  type KnowledgeProposalInput,
} from '../geo/knowledge-authority';
import { createBrandMaterialPort, MaterialImportService } from '../geo/material-import';

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
      { id: 'brand-knowledge', status: 'available' },
      { id: 'brand-material-import', status: 'available' },
      { id: 'question-opportunities', status: 'available' },
      { id: 'content-production', status: 'planned' },
      { id: 'geo-observation', status: 'planned' },
    ],
  };
}

function knowledgeAuthority() {
  if (!context.workspace) throw new Error('Brand knowledge requires an explicit workspace identity');
  return createKnowledgeAuthority({
    workspaceId: basename(context.workspace),
    sessionId: context.sessionId,
  });
}

function materialImportService(): MaterialImportService {
  if (!context.workspace) throw new Error('Brand materials require an explicit workspace identity');
  const identity = { workspaceId: basename(context.workspace), sessionId: context.sessionId };
  return new MaterialImportService(
    identity,
    createBrandMaterialPort(identity),
    getXiaojingGeoProviderCapabilities().extraction,
    createKnowledgeAuthority(identity),
  );
}

export async function proposeBrandFact(input: KnowledgeProposalInput) {
  const candidate = await knowledgeAuthority().propose(input);
  return {
    kind: 'knowledge-conflict-card',
    candidate,
    requiresUserDecision: true,
  };
}

export async function inspectBrandFact(key: FactKeyInput) {
  return knowledgeAuthority().inspect(key);
}

/**
 * Product-owned MCP boundary for Xiaojing. Later GEO slices extend this one
 * server instead of exposing generic SDK, filesystem, plugin or external MCP
 * surfaces to the main Agent.
 */
export async function createXiaojingGeoServer() {
  // Materialize the fixed typed provider registry before exposing any GEO
  // tool. Later business slices receive these ports; they never read env or
  // provider DTOs directly.
  getXiaojingGeoProviderCapabilities();
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
      tool(
        'propose_brand_fact',
        'Submit raw text and one structured brand-fact candidate to KnowledgeAuthority. This never confirms a new or changed value. Use origin=model-inferred and intent=chat-observation for facts merely noticed during ordinary chat; those always remain suggestions. Use origin=user-stated and intent=knowledge-update only when the user explicitly asked to add or update knowledge.',
        {
          rawInput: z.string().min(1).max(20_000),
          origin: z.enum(['user-stated', 'model-inferred']),
          intent: z.enum(['knowledge-update', 'chat-observation']),
          subject: z.string().min(1).max(200),
          predicate: z.string().min(1).max(200),
          scope: z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()])).optional(),
          effectiveFrom: z.string().optional(),
          effectiveTo: z.string().optional(),
          value: z.json(),
          unit: z.string().max(80).optional(),
          materialId: z.string().max(200).optional(),
          excerpt: z.string().min(1).max(4_000),
          confidence: z.number().min(0).max(1),
          profileProvenance: z.enum(['extracted', 'asked', 'inferred']).optional(),
        },
        async (input) => {
          const result = await proposeBrandFact({
            rawInput: input.rawInput,
            origin: input.origin,
            intent: input.intent,
            key: {
              subject: input.subject,
              predicate: input.predicate,
              scope: input.scope,
              effectiveFrom: input.effectiveFrom,
              effectiveTo: input.effectiveTo,
            },
            value: input.value,
            unit: input.unit,
            source: {
              materialId: input.materialId,
              excerpt: input.excerpt,
              confidence: input.confidence,
              profileProvenance: input.profileProvenance,
            },
          });
          return { content: [{ type: 'text' as const, text: JSON.stringify(result) }] };
        },
        { alwaysLoad: true },
      ),
      tool(
        'inspect_brand_fact',
        'Read the current authoritative value for one exact structured fact key. Scope and effective time are part of the key and must be supplied explicitly when applicable.',
        {
          subject: z.string().min(1).max(200),
          predicate: z.string().min(1).max(200),
          scope: z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()])).optional(),
          effectiveFrom: z.string().optional(),
          effectiveTo: z.string().optional(),
        },
        async (input) => ({
          content: [{ type: 'text' as const, text: JSON.stringify({
            kind: 'knowledge-authority-read',
            current: await inspectBrandFact(input),
          }) }],
        }),
        { alwaysLoad: true },
      ),
      tool(
        'import_pasted_material',
        'Save user-pasted brand material as a traceable original, extract Enterprise Profile candidates, and submit every candidate to KnowledgeAuthority. Never use this for a local file path.',
        {
          text: z.string().min(1).max(2_000_000),
          displayName: z.string().min(1).max(180).optional(),
        },
        async (input) => ({
          content: [{ type: 'text' as const, text: JSON.stringify(
            await materialImportService().importPastedText(input.text, input.displayName),
          ) }],
        }),
        { alwaysLoad: true },
      ),
      tool(
        'import_website_material',
        'Fetch one public HTTPS official-site URL with SSRF, redirect, content-type, size and timeout guards; save the raw response before extracting candidates through KnowledgeAuthority.',
        { url: z.string().url().max(2_000) },
        async (input) => ({
          content: [{ type: 'text' as const, text: JSON.stringify(
            await materialImportService().importWebsite(input.url),
          ) }],
        }),
        { alwaysLoad: true },
      ),
      tool(
        'retry_brand_material',
        'Retry extraction for exactly one already-stored brand material. This does not rerun any other material.',
        { materialId: z.string().uuid() },
        async (input) => ({
          content: [{ type: 'text' as const, text: JSON.stringify(
            await materialImportService().process(input.materialId),
          ) }],
        }),
        { alwaysLoad: true },
      ),
    ],
  });
}
