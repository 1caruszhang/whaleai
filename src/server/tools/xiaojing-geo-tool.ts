import { basename, resolve } from 'node:path';

import {
  configureXiaojingGeoProviderAdmission,
  getXiaojingGeoProviderCapabilities,
} from '../geo/provider-runtime';
import {
  createKnowledgeAuthority,
  type FactKeyInput,
  type KnowledgeProposalInput,
} from '../geo/knowledge-authority';
import { createBrandMaterialPort, MaterialImportService, materialLogProjection, type MaterialProcessResult } from '../geo/material-import';
import {
  createQuestionPoolPort,
  QuestionPoolService,
} from '../geo/question-pool';
import { createTopicPlanPort, TopicPlanService } from '../geo/topic-plan';
import type { TopicPlanProjection } from '../../shared/geo/topicPlan';
import {
  createArticlePort,
  ArticleGenerationService,
} from '../geo/article-generation';
import {
  createDistributionPlanPort,
  DistributionPlanningService,
} from '../geo/distribution-plan';
import type { DistributionPlanProjection } from '../../shared/geo/distributionPlan';
import { createPublishSchedulerPort } from '../geo/publish-scheduler';
import type { PublishExecutionProjection } from '../../shared/geo/publishScheduler';
import type {
  ArticleOperationProjection,
  ArticleOperationSource,
} from '../../shared/geo/articleGeneration';
import type { QuestionPoolProjection } from '../../shared/geo/questionPool';
import { GEO_PORT_CONTRACT } from '../../shared/geo/portContract';
import type { GeoContentType } from '../../shared/geo/portContract';
import { recordGeoOperationMilestone } from '../geo/operation-progress';
import {
  createGeoOperationService,
  type GeoOperationCreateInput,
} from '../geo/operation';
import { buildKnowledgeCandidatesCardData } from '../../shared/geo/knowledgeCard';
import { buildMaterialRequestCardData } from '../../shared/geo/materialRequestCard';
import {
  dispatchGateRevision,
  GATE_REVISION_GATE_TYPES,
  GATE_REVISION_MAX_OPERATIONS,
  GATE_REVISION_MAX_USER_INSTRUCTION_CHARS,
  GATE_REVISION_TOOL_DESCRIPTION,
  GATE_REVISION_TOOL_NAME,
  type GateRevisionOperation,
  type GateRevisionReceipt,
} from '../geo/gate-revision';
import { managementApi } from '../utils/management-api-client';
import {
  isSessionFileReference,
  isSessionFileTextReadable,
  SESSION_FILE_READ_HEAD_CHARS,
  SESSION_FILE_READ_MAX_OFFSET_CHARS,
} from '../../shared/sessionFileReference';
import {
  GEO_OPERATION_KINDS,
  GEO_OPERATION_REFERENCE_KINDS,
  type GeoOperationReference,
} from '../../shared/geo/operation';

interface XiaojingGeoContext {
  workspace?: string;
  sessionId: string;
}

let context: XiaojingGeoContext = { sessionId: 'default' };

/**
 * 会话内已升级为品牌材料的附件名（按 import_pasted_material 的 displayName
 * 记录）。仅当前 Sidecar 生命周期内有效：用于附件提醒的"已导入"标注，
 * 让模型查询品牌知识而不是回读文件（ADR-0001）。
 */
const importedMaterialNames = new Set<string>();

export function markSessionFileImported(name: string): void {
  const trimmed = name.trim();
  if (trimmed) importedMaterialNames.add(trimmed);
}

export function isSessionFileImported(name: string): boolean {
  return importedMaterialNames.has(name.trim());
}

export function configureXiaojingGeo(
  _env: Record<string, string>,
  next: XiaojingGeoContext,
): void {
  context = {
    sessionId: next.sessionId,
    ...(next.workspace ? { workspace: resolve(next.workspace) } : {}),
  };
  configureXiaojingGeoProviderAdmission({
    workspacePath: next.workspace,
    sessionId: next.sessionId,
  });
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
      { id: 'intent-driven-operations', status: 'available' },
      { id: 'question-opportunities', status: 'available' },
      { id: 'content-planning', status: 'available' },
      { id: 'content-production', status: 'available' },
      { id: 'geo-observation', status: 'available' },
      { id: 'distribution-planning', status: 'available' },
      { id: 'publishing', status: 'available' },
      { id: 'monitoring', status: 'available' },
      { id: 'geo-dashboard', status: 'available' },
    ],
  };
}

function geoOperationService() {
  if (!context.workspace)
    throw new Error('GeoOperation requires an explicit workspace identity');
  return createGeoOperationService({
    workspaceId: basename(context.workspace),
    sessionId: context.sessionId,
  });
}

export async function startGeoOperation(input: GeoOperationCreateInput) {
  return geoOperationService().create(input);
}

export async function inspectGeoOperations(input: {
  operationId?: string;
  limit?: number;
}) {
  const service = geoOperationService();
  return input.operationId
    ? service.get(input.operationId)
    : service.list({
        includeAllSessions: false,
        limit: input.limit,
      });
}

const EMPTY_OPERATION_LIST_HINT =
  "No GeoOperations recorded for this session yet. Confirm the user's explicit intent first, then create one with start_geo_operation.";

/**
 * inspect_geo_operations 的工具负载：空列表是合法的权威结果，但裸 `[]`
 * 会让模型无话可说——附上建模提示，引导它向用户解释并走创建路径。
 */
export function geoOperationProjectionPayload(
  result: Awaited<ReturnType<typeof inspectGeoOperations>>,
): {
  kind: "geo-operation-projection";
  result: unknown;
  hint?: string;
} {
  return Array.isArray(result) && result.length === 0
    ? { kind: "geo-operation-projection", result, hint: EMPTY_OPERATION_LIST_HINT }
    : { kind: "geo-operation-projection", result };
}

/**
 * control_geo_operation 的失败投影：裸 throw 只会变成 SDK 的 isError 单行
 * 文本，模型拿不到恢复路径。与材料失败的 ok:false 结果同构；合法动作列表
 * 由 Rust 状态机错误文本携带（geo_operations.rs），这里只补中文恢复指引，
 * 不在 Node 侧复制状态表。
 */
export function geoOperationControlFailure(error: unknown): {
  kind: "geo-operation-control";
  ok: false;
  error: string;
  hint: string;
} {
  const message = error instanceof Error ? error.message : String(error);
  const hint = message.includes("geo_operation_transition_invalid")
    ? "当前操作状态不允许该动作；错误信息中列出了此状态下合法的控制动作。改用其中的动作并携带 inspect_geo_operations 返回的最新 revision，或先查看操作状态。"
    : message.includes("geo_operation_already_terminal")
      ? "操作已处于终态（succeeded/failed/cancelled），不能再控制。如需继续同一目标，请用 start_geo_operation 创建新操作。"
      : message.includes("geo_operation_error_not_retryable")
        ? "只有标记为可重试的失败才能 retry。请改用 start_geo_operation 创建新操作，或与用户确认下一步。"
        : message.includes("revision_conflict")
          ? "expectedRevision 已过期：操作已被其他步骤推进。先调用 inspect_geo_operations 获取最新 revision 再重试。"
          : "控制请求被拒绝。先调用 inspect_geo_operations 查看最新状态与 revision，再选择合法动作。";
  return { kind: "geo-operation-control", ok: false, error: message, hint };
}

export async function controlGeoOperation(input: {
  operationId: string;
  expectedRevision: number;
  action: 'pause' | 'resume' | 'retry' | 'cancel';
}) {
  return geoOperationService().control(input);
}

export async function chooseNextRoundKnowledge(input: {
  operationId: string;
  expectedRevision: number;
  updateKnowledge: boolean;
}) {
  return geoOperationService().chooseNextRoundKnowledge(input);
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
  const capabilities = getXiaojingGeoProviderCapabilities();
  return new MaterialImportService(
    identity,
    createBrandMaterialPort(identity),
    capabilities.extraction,
    createKnowledgeAuthority(identity),
    {},
    capabilities.keywordSearch,
  );
}

// 题库/主题服务与 index.ts 的 HTTP 路由共用同一构造；这里按 Session 缓存实例，
// 保证 agent 工具与面板/卡片走完全相同的领域语义与复用规则。
function stageIdentity(): { workspaceId: string; sessionId: string } {
  if (!context.workspace) throw new Error('This stage requires an explicit workspace identity');
  return { workspaceId: basename(context.workspace), sessionId: context.sessionId };
}

let questionPoolRuntime: { key: string; service: QuestionPoolService } | null = null;
function questionPoolService(): QuestionPoolService {
  const identity = stageIdentity();
  const key = `${identity.workspaceId}:${identity.sessionId}`;
  if (questionPoolRuntime?.key === key) return questionPoolRuntime.service;
  const capabilities = getXiaojingGeoProviderCapabilities();
  const service = new QuestionPoolService(
    identity,
    createQuestionPoolPort(identity),
    capabilities.keywordSearch,
    capabilities.generation,
    capabilities.embedding,
  );
  questionPoolRuntime = { key, service };
  return service;
}

let topicPlanRuntime: { key: string; service: TopicPlanService } | null = null;
function topicPlanService(): TopicPlanService {
  const identity = stageIdentity();
  const key = `${identity.workspaceId}:${identity.sessionId}`;
  if (topicPlanRuntime?.key === key) return topicPlanRuntime.service;
  const capabilities = getXiaojingGeoProviderCapabilities();
  const service = new TopicPlanService(
    identity,
    createTopicPlanPort(identity),
    capabilities.generation,
    capabilities.embedding,
  );
  topicPlanRuntime = { key, service };
  return service;
}

let articleRuntime: { key: string; service: ArticleGenerationService } | null = null;
function articleService(): ArticleGenerationService {
  const identity = stageIdentity();
  const key = `${identity.workspaceId}:${identity.sessionId}`;
  if (articleRuntime?.key === key) return articleRuntime.service;
  const capabilities = getXiaojingGeoProviderCapabilities();
  const service = new ArticleGenerationService(
    identity,
    createArticlePort(identity),
    capabilities.generation,
    capabilities.reflection,
  );
  articleRuntime = { key, service };
  return service;
}

let distributionRuntime: { key: string; service: DistributionPlanningService } | null = null;
function distributionService(): DistributionPlanningService {
  const identity = stageIdentity();
  const key = `${identity.workspaceId}:${identity.sessionId}`;
  if (distributionRuntime?.key === key) return distributionRuntime.service;
  const capabilities = getXiaojingGeoProviderCapabilities();
  const service = new DistributionPlanningService(
    identity,
    createDistributionPlanPort(identity),
    capabilities.distribution,
    capabilities.keywordSearch,
  );
  distributionRuntime = { key, service };
  return service;
}

let publishPreviewRuntime: { key: string; port: ReturnType<typeof createPublishSchedulerPort> } | null = null;
function publishPreviewPort(): ReturnType<typeof createPublishSchedulerPort> {
  const identity = stageIdentity();
  const key = `${identity.workspaceId}:${identity.sessionId}`;
  if (publishPreviewRuntime?.key === key) return publishPreviewRuntime.port;
  const port = createPublishSchedulerPort(identity);
  publishPreviewRuntime = { key, port };
  return port;
}

/** 导入产出候选后推进 GeoOperation 的材料/抽取步骤；best-effort，不阻断工具结果。 */
async function recordMaterialImportedMilestone(result: MaterialProcessResult): Promise<void> {
  if (!result.ok || result.candidateIds.length === 0 || !context.workspace) return;
  await recordGeoOperationMilestone(
    { workspaceId: basename(context.workspace), sessionId: context.sessionId },
    'materials-imported',
  );
}

/**
 * Agent 工具路径与 HTTP 路由共用同一份 [materials] 脱敏投影：没有它，
 * 工具发起的导入失败在 sidecar 日志中没有任何时间线（只存在于 SQLite）。
 */
function logMaterialTool(
  operation: 'import-text' | 'fetch-website' | 'retry',
  status: 'started' | 'completed' | 'failed',
  payload: { materialId?: string; errorCode?: string } = {},
): void {
  if (!context.workspace) return;
  console.log(`[materials] ${JSON.stringify(materialLogProjection({
    operation,
    workspaceId: basename(context.workspace),
    sessionId: context.sessionId,
    materialId: payload.materialId,
    status,
    ...(status === 'failed' && payload.errorCode ? { error: new Error(payload.errorCode) } : {}),
  }))}`);
}

function materialResultLogInfo(result: MaterialProcessResult): { materialId?: string; errorCode?: string } {
  return result.ok
    ? { materialId: result.material.id }
    : { materialId: result.materialId, errorCode: result.errorCode };
}

/**
 * 成功的材料导入渲染为批量知识确认卡（用户在聊天卡片内裁决），
 * 失败结果保持原样供模型诊断。ADR-0001 裁决门的唯一会话内呈现形态。
 */
function materialCandidatesToolText(result: MaterialProcessResult): string {
  if (result.ok) {
    const card = buildKnowledgeCandidatesCardData(
      { id: result.material.id, displayName: result.material.displayName },
      result.candidates ?? [],
    );
    if (card) return JSON.stringify(card);
  }
  return JSON.stringify(result);
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
 * Product-owned capability boundary for Xiaojing. Later GEO slices extend this
 * one fixed server instead of exposing unregistered capability sources.
 */
export async function createXiaojingGeoServer() {
  // Materialize the fixed typed provider registry before exposing any GEO
  // tool. Later business slices receive these ports; they never read env or
  // provider DTOs directly.
  getXiaojingGeoProviderCapabilities();
  const { createSdkMcpServer, tool } = await import('@anthropic-ai/claude-agent-sdk');
  const { z } = await import('zod/v4');
  const operationReferenceSchema = z.object({
    kind: z.enum(GEO_OPERATION_REFERENCE_KINDS),
    id: z
      .string()
      .min(1)
      .max(200)
      .regex(/^[A-Za-z0-9_.-]+$/),
    revision: z.number().int().min(0).optional(),
  });
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
        'start_geo_operation',
        "Create the one BrandWorkspace GeoOperation that matches the user's intent. Use the direct intent when the user names a specific stage; when the user states a GEO goal without naming a stage, create full-optimization instead of asking which intent to pick. Keep goal a short plain-language phrase (e.g. 一轮完整的 GEO 优化) — the chat progress card broadcasts the full stage and step plan, so never restate every step in prose; report only the stage and the confirmation gate the operation currently stops at. Every new operation first parks at the plan acknowledgement gate: after creating it, briefly state the goal and the opening stage, tell the user to review and release the plan on the progress card, then end your turn — do not start any stage before the operation event reminder tells you the plan was released. For next-round-optimization, omit updateKnowledge first so the operation stops and asks, then record the user's answer with choose_next_round_knowledge; the explicit answer releases the replaced plan, which starts directly at its first work step (still stopping at that stage's confirmation gate). When reporting to the user, use natural, professional Simplified Chinese and keep your own thinking in Simplified Chinese; never surface internal enum values, operation IDs, UUIDs, revision numbers, tool names, or endpoint names — describe the operation by its goal and stages in plain language.",
        {
          intent: z.enum(GEO_OPERATION_KINDS),
          goal: z.string().min(1).max(500),
          inputRefs: z.array(operationReferenceSchema).max(256).optional(),
          sourceOperationId: z
            .string()
            .min(1)
            .max(200)
            .regex(/^[A-Za-z0-9_.-]+$/)
            .optional(),
          updateKnowledge: z.boolean().optional(),
        },
        async (input) => ({
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({
                kind: 'geo-operation',
                operation: await startGeoOperation({
                  intent: input.intent,
                  goal: input.goal,
                  inputRefs: input.inputRefs as
                    | GeoOperationReference[]
                    | undefined,
                  sourceOperationId: input.sourceOperationId,
                  updateKnowledge: input.updateKnowledge,
                }),
              }),
            },
          ],
        }),
        { alwaysLoad: true },
      ),
      tool(
        'inspect_geo_operations',
        'Read one exact GeoOperation, or list operations owned by the current Session. Execution context is never shared across Sessions.',
        {
          operationId: z
            .string()
            .min(1)
            .max(200)
            .regex(/^[A-Za-z0-9_.-]+$/)
            .optional(),
          limit: z.number().int().min(1).max(200).optional(),
        },
        async (input) => ({
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify(
                geoOperationProjectionPayload(await inspectGeoOperations(input)),
              ),
            },
          ],
        }),
        { alwaysLoad: true },
      ),
      tool(
        'choose_next_round_knowledge',
        "Record the user's explicit answer to the next-round knowledge-refresh question. Never infer this answer from a dashboard report.",
        {
          operationId: z
            .string()
            .min(1)
            .max(200)
            .regex(/^[A-Za-z0-9_.-]+$/),
          expectedRevision: z.number().int().min(1),
          updateKnowledge: z.boolean(),
        },
        async (input) => ({
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({
                kind: 'geo-operation',
                operation: await chooseNextRoundKnowledge(input),
              }),
            },
          ],
        }),
        { alwaysLoad: true },
      ),
      tool(
        'control_geo_operation',
        'Pause, resume, retry, or cancel one exact GeoOperation with revision CAS. Valid by status: pause works from ready/queued/running/recovering; resume only from paused/recovering; retry only for failed operations whose error is retryable; cancel works until the operation is terminal. An invalid-transition error lists the actions valid for the current status. This tool cannot confirm knowledge, paid publishing, external publishing, or monitoring activation.',
        {
          operationId: z
            .string()
            .min(1)
            .max(200)
            .regex(/^[A-Za-z0-9_.-]+$/),
          expectedRevision: z.number().int().min(1),
          action: z.enum(['pause', 'resume', 'retry', 'cancel']),
        },
        async (input) => {
          try {
            const operation = await controlGeoOperation(input);
            return {
              content: [
                {
                  type: 'text' as const,
                  text: JSON.stringify({
                    kind: 'geo-operation',
                    operation,
                  }),
                },
              ],
            };
          } catch (error) {
            return {
              content: [
                { type: 'text' as const, text: JSON.stringify(geoOperationControlFailure(error)) },
              ],
            };
          }
        },
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
        GATE_REVISION_TOOL_NAME,
        GATE_REVISION_TOOL_DESCRIPTION,
        {
          gate: z.enum(GATE_REVISION_GATE_TYPES),
          operations: z
            .array(
              z.object({
                action: z.enum(['modify', 'delete', 'add']),
                targetId: z.string().min(1).max(200).optional()
                  .describe('modify/delete: pending entry id from the confirmation card (knowledge gate = candidate id; distribution channel ops use the resourceId, publish item ops use the item id).'),
                subject: z.string().min(1).max(200).optional()
                  .describe('Entry kind. knowledge add: fact subject of the new entry. question-pool: "keyword" targets a mined search term, omit for a candidate question. distribution-plan: "channel" | "assignment" (omit for plan-level budget/publishStartAt). publish-preparation: "item" (omit for execution-level budget/publishStartAt).'),
                predicate: z.string().min(1).max(200).optional()
                  .describe('add: fact predicate of the new entry.'),
                scope: z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()])).optional(),
                effectiveFrom: z.string().optional(),
                effectiveTo: z.string().optional(),
                value: z.json().optional()
                  .describe('modify/add: the new value the user asked for.'),
                unit: z.string().max(80).optional(),
                materialId: z.string().min(1).max(200).optional()
                  .describe('add: material id of the pending confirmation card — required for the knowledge gate so the new row joins that card; facts outside a pending card go through propose_brand_fact.'),
                userInstruction: z
                  .string()
                  .min(1)
                  .max(GATE_REVISION_MAX_USER_INSTRUCTION_CHARS)
                  .describe('The user\'s explicit instruction quoted verbatim; recorded in the audit trail.'),
              }),
            )
            .min(1)
            .max(GATE_REVISION_MAX_OPERATIONS),
        },
        async (input) => {
          let receipt: GateRevisionReceipt;
          if (!context.workspace) {
            receipt = {
              kind: 'gate-revision',
              gate: input.gate,
              ok: false,
              code: 'workspace_required',
              error: 'Gate revision requires an explicit workspace identity',
              results: [],
            };
          } else {
            receipt = await dispatchGateRevision(
              input.gate,
              input.operations as GateRevisionOperation[],
              {
                workspaceId: basename(context.workspace),
                sessionId: context.sessionId,
              },
            );
          }
          return {
            content: [{ type: 'text' as const, text: JSON.stringify(receipt) }],
          };
        },
        { alwaysLoad: true },
      ),
      tool(
        'request_brand_material',
        "Surface the brand-material request card in chat where the user uploads materials (file picker, pasted text or official-site URL; PDF/Office are parsed there). Call it exactly when: (1) a released plan's material-collection step runs and the brand has no confirmed knowledge, or the confirmed knowledge is clearly too thin for the goal — judge sufficiency once at planning time, but never emit this card before the plan is released; (2) the user explicitly asks to add brand material; (3) the user attached a binary file that read_session_file cannot parse and it is brand material. Never call it mid-operation just because a gate lacks material evidence — proceed with AI-completion rows and let the user adjudicate on that card. reason is one plain-language line shown on the card header. After calling it, tell the user to upload on the card and end your turn; the knowledge confirmation card follows the import automatically.",
        { reason: z.string().min(1).max(300).describe('One plain-language line telling the user why material is needed now.') },
        async (input) => ({
          content: [
            { type: 'text' as const, text: JSON.stringify(buildMaterialRequestCardData(input.reason)) },
          ],
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
        async (input) => {
          logMaterialTool('import-text', 'started');
          const result = await materialImportService().importPastedText(input.text, input.displayName);
          logMaterialTool('import-text', result.ok ? 'completed' : 'failed', materialResultLogInfo(result));
          // 记录附件名→已导入，供后续附件提醒标注（ADR-0001）。
          if (input.displayName) markSessionFileImported(input.displayName);
          await recordMaterialImportedMilestone(result);
          return {
            content: [{ type: 'text' as const, text: materialCandidatesToolText(result) }],
          };
        },
        { alwaysLoad: true },
      ),
      tool(
        'read_session_file',
        'Read one file the user attached to a chat message. Scope is strictly the current session directory xiaojing_files/<sessionId>/; returns a bounded head of text plus totalChars and a truncated flag — continue larger files with offsetChars. Binary attachments are rejected with guidance to surface the material request card via request_brand_material instead.',
        {
          path: z
            .string()
            .min(1)
            .max(600)
            .describe('Workspace-relative path from the session-files reminder, e.g. xiaojing_files/<sessionId>/notes.md'),
          offsetChars: z
            .number()
            .int()
            .min(0)
            .max(SESSION_FILE_READ_MAX_OFFSET_CHARS)
            .optional()
            .describe('Character offset to continue from a previous truncated read.'),
        },
        async (input) => {
          const fail = (error: string, hint: string) => ({
            content: [{ type: 'text' as const, text: JSON.stringify({ kind: 'session-file-read', ok: false, error, hint }) }],
          });
          if (!isSessionFileReference(input.path, context.sessionId)) {
            return fail(
              'path_out_of_scope',
              'Only files under the current session directory xiaojing_files/<sessionId>/ are readable.',
            );
          }
          if (!isSessionFileTextReadable(input.path)) {
            return fail(
              'binary_not_readable',
              'This file type cannot be read as text. If it is brand material, call request_brand_material so the user can upload it on the chat material request card (paste, official-site URL or file picker; PDF/Office are parsed there).',
            );
          }
          const sidecarId = process.env.XIAOJING_SIDECAR_ID?.trim();
          if (!context.workspace || !sidecarId) {
            return fail('sidecar_identity_missing', 'Session file reading requires an authenticated Sidecar identity.');
          }
          const result = await managementApi(
            '/api/workspace-files/read-session-file',
            'POST',
            {
              sidecarId,
              workspaceId: basename(context.workspace),
              sessionId: context.sessionId,
              payload: {
                relativePath: input.path,
                offsetChars: input.offsetChars ?? 0,
                maxChars: SESSION_FILE_READ_HEAD_CHARS,
              },
            },
          );
          if (result.ok !== true) {
            return fail(
              typeof result.code === 'string' ? result.code : 'management_read_failed',
              typeof result.error === 'string' ? result.error : 'The desktop shell refused or failed the scoped file read.',
            );
          }
          return {
            content: [{
              type: 'text' as const,
              text: JSON.stringify({
                kind: 'session-file-read',
                ok: true,
                path: input.path,
                offsetChars: typeof result.offsetChars === 'number' ? result.offsetChars : (input.offsetChars ?? 0),
                content: typeof result.content === 'string' ? result.content : '',
                totalChars: typeof result.totalChars === 'number' ? result.totalChars : 0,
                truncated: result.truncated === true,
              }),
            }],
          };
        },
        { alwaysLoad: true },
      ),
      tool(
        'import_website_material',
        'Fetch one public HTTPS official-site URL with SSRF, redirect, content-type, size and timeout guards; save the raw response before extracting candidates through KnowledgeAuthority.',
        { url: z.string().url().max(2_000) },
        async (input) => {
          logMaterialTool('fetch-website', 'started');
          const result = await materialImportService().importWebsite(input.url);
          logMaterialTool('fetch-website', result.ok ? 'completed' : 'failed', materialResultLogInfo(result));
          await recordMaterialImportedMilestone(result);
          return {
            content: [{ type: 'text' as const, text: materialCandidatesToolText(result) }],
          };
        },
        { alwaysLoad: true },
      ),
      tool(
        'retry_brand_material',
        'Retry extraction for exactly one already-stored brand material. This does not rerun any other material.',
        { materialId: z.string().uuid() },
        async (input) => {
          logMaterialTool('retry', 'started', { materialId: input.materialId });
          const result = await materialImportService().process(input.materialId);
          logMaterialTool('retry', result.ok ? 'completed' : 'failed', materialResultLogInfo(result));
          await recordMaterialImportedMilestone(result);
          return {
            content: [{ type: 'text' as const, text: materialCandidatesToolText(result) }],
          };
        },
        { alwaysLoad: true },
      ),
      tool(
        'run_question_pool',
        'Run the question-opportunity stage for one product line (domain-level, e.g. 汽车音响改装 — not a fine-grained service item): the service reuses the confirmed pool for the current knowledge version when valid, otherwise mines keywords online and generates candidate questions (real provider spend). Omit productLine to use the brand\'s first confirmed product line (synced from the industry fact at knowledge confirmation — if none exists, call request_brand_material so the user can import brand material and confirm knowledge first, then retry). When the user names a specific business within the domain (e.g. 汽车隔音), pass it as businessFocus instead of inventing a new product line. The result renders as the confirmation card where the user reviews the mined keywords and selects questions — never claim the pool is confirmed; the user confirms on the card. Keyword geography is bounded by the user-declared service area (服务区域): the declared scope kept at its own granularity (e.g. 新都区 stays 新都区, not the whole 成都) is both the mining anchor and the ceiling — terms never reference regions beyond it, and store addresses only anchor when no usable scope is declared. For targetRegion pass the declared scope as a plain name (e.g. 新都区 or 成都); never prose like 成都本地，辐射西南地区 and never boundless values such as 全国 — nationwide/online service mines in geo-free mode.',
        {
          productLine: z.string().min(1).max(120).optional(),
          targetRegion: z.string().min(1).max(60),
          businessFocus: z.string().min(2).max(120).optional(),
          idempotencyKey: z.string().min(8).max(120).optional(),
        },
        async (input): Promise<{ content: Array<{ type: 'text'; text: string }> }> => {
          const identity = stageIdentity();
          let productLine = input.productLine?.trim();
          if (!productLine) {
            const sidecarId = process.env.XIAOJING_SIDECAR_ID?.trim();
            if (!sidecarId) {
              throw new Error('Brand workspace info requires an authenticated Sidecar identity');
            }
            const info = await managementApi('/api/brand-workspace/info', 'POST', {
              sidecarId,
              workspaceId: identity.workspaceId,
              sessionId: identity.sessionId,
              payload: {},
            });
            const lines: unknown = (info as { workspace?: { productLines?: unknown } }).workspace?.productLines;
            if (info.ok !== true || !Array.isArray(lines)) {
              throw new Error(
                typeof (info as { error?: unknown }).error === 'string'
                  ? (info as { error: string }).error
                  : 'brand_workspace_info_unavailable',
              );
            }
            const first = (lines as string[]).find((line) => line.trim().length > 0);
            if (!first) {
              throw new Error(
                '品牌还没有已确认的产品线（领域）：请先用 request_brand_material 发起材料请求，待用户上传品牌资料并在确认卡片上完成知识裁决后重试；行业事实确认后产品线会自动同步。',
              );
            }
            productLine = first;
          }
          const pool: QuestionPoolProjection = await questionPoolService().generate({
            ...identity,
            productLine,
            targetRegion: input.targetRegion,
            ...(input.businessFocus ? { businessFocus: input.businessFocus } : {}),
            idempotencyKey: input.idempotencyKey ?? `agent-pool-${crypto.randomUUID()}`,
          });
          await recordGeoOperationMilestone(identity, 'question-pool-generated');
          return {
            content: [{ type: 'text' as const, text: JSON.stringify({ kind: 'question-pool', pool }) }],
          };
        },
        { alwaysLoad: true },
      ),
      tool(
        'plan_topics',
        'Run the content-planning stage: cluster the confirmed questions semantically and produce the five-type topic/title plan (real provider spend; the service reuses the existing plan for the current pool when valid). The result renders as the confirmation card where the user approves plan items — never claim the plan is confirmed; the user confirms on the card. Requires a confirmed question pool first.',
        {
          questionPoolId: z.string().min(1).max(120).optional(),
        },
        async (input): Promise<{ content: Array<{ type: 'text'; text: string }> }> => {
          const identity = stageIdentity();
          const plan: TopicPlanProjection = await topicPlanService().generate({
            ...identity,
            ...(input.questionPoolId ? { questionPoolId: input.questionPoolId } : {}),
          });
          return {
            content: [{ type: 'text' as const, text: JSON.stringify({ kind: 'topic-plan', plan }) }],
          };
        },
        { alwaysLoad: true },
      ),
      tool(
        'generate_articles',
        'Run the article stage from the confirmed topic plan (or a direct explicit article task the user asked for). Real provider spend; drafts then pass the dual quality-gate review. The result renders as the approval card where the user reads each draft and approves — never claim an article is approved; only the user can approve on the card.',
        {
          planId: z.string().min(1).max(120).optional(),
          direct: z.object({
            count: z.number().int().min(1).max(10),
            themes: z.array(z.string().min(1).max(200)).min(1).max(10),
            contentType: z.enum(
              GEO_PORT_CONTRACT.contentTypes.slice() as unknown as [string, ...string[]],
            ),
            constraints: z.string().max(2000),
          }).optional(),
        },
        async (input): Promise<{ content: Array<{ type: 'text'; text: string }> }> => {
          if ((input.planId ? 1 : 0) + (input.direct ? 1 : 0) !== 1) {
            throw new Error('generate_articles requires exactly one of planId or direct');
          }
          const source: ArticleOperationSource = input.direct
            ? {
              kind: 'direct',
              count: input.direct.count,
              themes: input.direct.themes,
              contentType: input.direct.contentType as GeoContentType,
              constraints: input.direct.constraints,
            }
            : { kind: 'confirmed-topic-plan', ...(input.planId ? { planId: input.planId } : {}) };
          const operation: ArticleOperationProjection = await articleService().start({
            ...stageIdentity(),
            source,
          });
          return {
            content: [{ type: 'text' as const, text: JSON.stringify({ kind: 'article-operation', operation }) }],
          };
        },
        { alwaysLoad: true },
      ),
      tool(
        'plan_distribution',
        'Run the distribution-planning stage: discover real channel candidates from the approved articles and persisted evidence, then render the confirmation card where the user selects channels and confirms the plan. Confirming the plan never places orders or spends money. Derive targetAudience from brand context or the user goal; optional mappingMode/ratio/budget/publishStartAt default to product defaults.',
        {
          targetAudience: z.string().min(2).max(200),
          mappingMode: z.enum(['one-to-one', 'ratio']).optional(),
          mediaRatio: z.number().min(0).max(100).optional(),
          weMediaRatio: z.number().min(0).max(100).optional(),
          budgetCny: z.number().min(0).max(10_000_000).optional(),
          publishStartAt: z.string().datetime().optional(),
        },
        async (input): Promise<{ content: Array<{ type: 'text'; text: string }> }> => {
          const identity = stageIdentity();
          const service = distributionService();
          const context = await service.context({ ...stageIdentity() });
          if (context.articles.length === 0) {
            throw new Error('distribution_approved_articles_required');
          }
          const plan: DistributionPlanProjection = await service.start({
            ...identity,
            source: {
              articleOperationId: context.articles[0]?.operationId ?? '',
              articleIds: context.articles.map((article) => article.id),
              industry: context.industry,
              targetAudience: input.targetAudience,
              // 被动路证据由服务在现场探测问题池产出（js_ai 语义），工具不再
              // 透传基线快照；偏好路由品牌 overlay 合成。
              questionSources: [],
              preferredResourceIds: [],
              mappingMode: input.mappingMode ?? 'one-to-one',
              ratio: {
                media: input.mediaRatio ?? 2,
                weMedia: input.weMediaRatio ?? 1,
              },
              budgetCny: input.budgetCny ?? 1_000,
              publishStartAt:
                input.publishStartAt ?? new Date(Date.now() + 3_600_000).toISOString(),
            },
          });
          // 工具结果是聊天转录的一部分：只回「卡片初始渲染 + agent 复述」
          // 所需的最小投影（id/状态/预算/选择/阻断 + 候选的名称·报价·路径·
          // 适配·证据标签），把转录占用压到 ~1/7；卡片 3s 轮询 /latest 后即
          // 切换为完整权威投影，编辑/确认请求不依赖这份瘦身数据（assignments
          // 全量保留以防轮询前确认）。
          const cardPlan = {
            id: plan.id,
            status: plan.status,
            revision: plan.revision,
            budgetCny: plan.budgetCny,
            workspaceId: plan.workspaceId,
            publishStartAt: plan.publishStartAt,
            selectedResourceIds: plan.selectedResourceIds,
            blockingIssues: plan.blockingIssues,
            articles: plan.articles.map((article) => ({ id: article.id })),
            assignments: plan.assignments,
            candidates: plan.candidates.map((candidate) => ({
              resourceId: candidate.resourceId,
              kind: candidate.kind,
              name: candidate.name,
              estimatedPriceCny: candidate.estimatedPriceCny,
              pathHits: candidate.pathHits,
              fitReasons: candidate.fitReasons,
              evidence: candidate.evidence.map((item) => ({
                path: item.path,
                label:
                  item.label.length > 64
                    ? `${item.label.slice(0, 64)}…`
                    : item.label,
              })),
            })),
          };
          return {
            content: [{ type: 'text' as const, text: JSON.stringify({ kind: 'distribution-plan', plan: cardPlan }) }],
          };
        },
        { alwaysLoad: true },
      ),
      tool(
        'prepare_publish',
        'Run the publishing stage: build the exact publish-execution preview (final approved articles, channels, prices, budget, schedule) from the confirmed distribution plan. This uploads nothing, charges nothing and places no order. The result renders as the irreversible-authorization card; the user authorizes and starts publishing there — the Agent can never authorize or start a paid publish.',
        {
          planId: z.string().min(1).max(120).optional(),
        },
        async (input): Promise<{ content: Array<{ type: 'text'; text: string }> }> => {
          const execution = await publishPreviewPort().preview(input.planId);
          if (!execution) {
            throw new Error('publish_preview_requires_confirmed_plan');
          }
          const preview: PublishExecutionProjection = execution;
          return {
            content: [{ type: 'text' as const, text: JSON.stringify({ kind: 'publish-execution', execution: preview }) }],
          };
        },
        { alwaysLoad: true },
      ),
    ],
  });
}
