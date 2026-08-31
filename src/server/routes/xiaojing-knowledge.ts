import { basename, resolve } from 'node:path';

import {
  buildKnowledgeCandidatesCardData,
  KNOWLEDGE_CARD_MAX_CANDIDATES,
  toKnowledgeCardCandidate,
} from '../../shared/geo/knowledgeCard';
import { MATERIAL_ERROR_CODES } from '../../shared/geo/materials';
import {
  buildKnowledgeBatchDecisionReminder,
  buildKnowledgeDecisionReminder,
  type KnowledgeDecisionReminderInput,
} from '../../shared/systemReminder';
import { createKnowledgeAuthority, type KnowledgeDecision } from '../geo/knowledge-authority';
import {
  createBrandMaterialPort,
  fetchWebsiteMaterial,
  MaterialImportService,
  materialLogProjection,
  type BrandMaterial,
  type MaterialErrorCode,
} from '../geo/material-import';
import { recordGeoOperationMilestone } from '../geo/operation-progress';
import {
  getXiaojingGeoBillingPermitChannel,
  getXiaojingGeoProviderCapabilities,
} from '../geo/provider-runtime';
import { jsonResponse } from '../utils/http';
import { sendXiaojingMessage } from '../xiaojing-reminder-send';
import { getRuntimeSessionIdForRequest, type XiaojingRouteContext } from './xiaojing-shared';

type MaterialIdentity = { workspaceId: string; sessionId: string };

/**
 * 存量重扫（ADR-0008 T7）的同步预算：转发控制面请求有 120s 代理上限，
 * 每份材料的提取预算（同时约束单次打标调用）25s、启动新材料前的总预算
 * 60s，最坏情况（60s 边界启动的最后一份 + 其在途打标调用）仍在 ~110s 内
 * 收敛。预算截断不丢工作：重扫幂等（sha256 预扫跳过已入池图），再次触发
 * 只花在余量上。
 */
const RESCAN_MATERIAL_BUDGET_MS = 25_000;
const RESCAN_TOTAL_BUDGET_MS = 60_000;

function logMaterial(input: Parameters<typeof materialLogProjection>[0]): void {
  console.log(`[materials] ${JSON.stringify(materialLogProjection(input))}`);
}

/**
 * 每 Session 一条串行后台抽取队列：LLM 处理不再挂在转发请求的 120s 代理
 * 超时后面，也不让批量导入并行打满 provider。队列只活在 Sidecar 进程内；
 * 材料与 attempt 状态由 Rust 持久化，进程重启后通过 retry 恢复。
 */
const sessionProcessingQueues = new Map<string, Promise<void>>();

function enqueueSessionProcessing(
  identity: MaterialIdentity,
  run: () => Promise<void>,
): void {
  const key = `${identity.workspaceId}:${identity.sessionId}`;
  const tail = sessionProcessingQueues.get(key) ?? Promise.resolve();
  const next = tail.then(run).catch(() => {});
  sessionProcessingQueues.set(key, next);
  void next.then(() => {
    if (sessionProcessingQueues.get(key) === next) sessionProcessingQueues.delete(key);
  });
}

async function runBackgroundProcessing(input: {
  identity: MaterialIdentity;
  materialIds: string[];
}): Promise<void> {
  const { identity, materialIds } = input;
  const capabilities = getXiaojingGeoProviderCapabilities();
  const service = new MaterialImportService(
    identity,
    createBrandMaterialPort(identity),
    capabilities.extraction,
    createKnowledgeAuthority(identity),
    {},
    capabilities.keywordSearch,
    undefined,
    getXiaojingGeoBillingPermitChannel(),
  );
  for (const materialId of materialIds) {
    const result = await service.process(materialId);
    logMaterial({
      operation: 'extract',
      workspaceId: identity.workspaceId,
      sessionId: identity.sessionId,
      materialId,
      status: result.ok ? 'completed' : 'failed',
      ...(result.ok ? {} : { error: new Error(result.errorCode) }),
    });
    if (result.ok && result.candidateIds.length > 0) {
      await recordGeoOperationMilestone(identity, 'materials-imported');
    }
  }
}

/** 存储阶段（快）内的一次失败：固定错误码直接投影给对应输入行。 */
function storageErrorCode(error: unknown, fallback: MaterialErrorCode): MaterialErrorCode {
  const message = error instanceof Error ? error.message : String(error);
  return MATERIAL_ERROR_CODES.find(
    (code) => code !== 'material_request_failed' && message.includes(code),
  ) ?? fallback;
}

export async function handleXiaojingKnowledgeRoute(
  pathname: string,
  request: Request,
  ctx: XiaojingRouteContext,
): Promise<Response | null> {
  const { workspacePath } = ctx;

  // User actions on a GEO knowledge card remain a structured control
  // request. The Renderer cannot write project.sqlite and cannot choose an
  // actor identity; this Session-scoped route delegates to the sole Node
  // KnowledgeAuthority and Rust authenticates the process generation.
  if (pathname === '/api/xiaojing/knowledge/decide' && request.method === 'POST') {
    try {
      const payload = await request.json() as {
        workspaceId: string;
        sessionId: string;
        candidateId: string;
        decision: KnowledgeDecision;
        expectedCurrentVersion: number;
        reason?: string;
        splitKey?: {
          subject: string;
          predicate: string;
          scope?: Record<string, string | number | boolean | null>;
          effectiveFrom?: string | null;
          effectiveTo?: string | null;
        };
      };
      const runtimeSessionId = getRuntimeSessionIdForRequest();
      const workspaceId = basename(resolve(workspacePath));
      if (payload.workspaceId !== workspaceId
        || payload.sessionId !== runtimeSessionId) {
        return jsonResponse({
          success: false,
          error: 'Knowledge decision identity does not match this brand Session.',
        }, 403);
      }
      const result = await createKnowledgeAuthority({ workspaceId, sessionId: runtimeSessionId }).decide({
        candidateId: payload.candidateId,
        decision: payload.decision,
        expectedCurrentVersion: payload.expectedCurrentVersion,
        actorId: 'desktop-user',
        reason: payload.reason,
        splitKey: payload.splitKey,
      });
      // The decision is already durably committed. Reuse the existing
      // Session message + hidden reminder path so the Agent can
      // respond naturally without a fabricated visible user message.
      // Notification admission is best-effort and cannot roll back or
      // obscure the authoritative knowledge result.
      const notification = await sendXiaojingMessage(buildKnowledgeDecisionReminder({
          candidateId: payload.candidateId,
          decision: payload.decision,
          status: result.status,
          factKey: result.factKey,
          currentVersion: result.current?.version,
          brandKnowledgeVersion: result.knowledgeVersion,
        }), undefined, workspacePath);
      await recordGeoOperationMilestone(
        { workspaceId, sessionId: runtimeSessionId },
        'knowledge-confirmed',
      );
      return jsonResponse({
        success: true,
        result,
        notificationQueued: notification.success,
        ...(!notification.success && notification.error
          ? { notificationError: notification.error }
          : {}),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const status = message.includes('knowledge_version_conflict') ? 409 : 400;
      return jsonResponse({ success: false, error: message }, status);
    }
  }

  // 批量确认卡的一次性提交：逐条经 KnowledgeAuthority 裁决（各自
  // SQLite IMMEDIATE + CAS），结果逐条返回；reminder 只投递一条聚合
  // 摘要，避免逐条隐藏消息刷屏。部分失败不回滚已提交项。
  if (pathname === '/api/xiaojing/knowledge/decide-batch' && request.method === 'POST') {
    try {
      const payload = await request.json() as {
        workspaceId: string;
        sessionId: string;
        decisions: Array<{
          candidateId: string;
          decision: KnowledgeDecision;
          expectedCurrentVersion: number;
          editedValue?: unknown;
        }>;
      };
      const runtimeSessionId = getRuntimeSessionIdForRequest();
      const workspaceId = basename(resolve(workspacePath));
      if (payload.workspaceId !== workspaceId
        || payload.sessionId !== runtimeSessionId) {
        return jsonResponse({
          success: false,
          error: 'Knowledge decision identity does not match this brand Session.',
        }, 403);
      }
      if (!Array.isArray(payload.decisions) || payload.decisions.length === 0
        || payload.decisions.length > 100) {
        return jsonResponse({ success: false, error: 'knowledge_decisions_invalid' }, 400);
      }
      const authority = createKnowledgeAuthority({ workspaceId, sessionId: runtimeSessionId });
      const results: Array<{ candidateId: string; ok: boolean; status?: string; error?: string }> = [];
      const reminders: KnowledgeDecisionReminderInput[] = [];
      for (const item of payload.decisions) {
        try {
          const result = await authority.decide({
            candidateId: item.candidateId,
            decision: item.decision,
            expectedCurrentVersion: item.expectedCurrentVersion,
            actorId: 'desktop-user',
            editedValue: item.editedValue,
          });
          results.push({ candidateId: item.candidateId, ok: true, status: result.status });
          reminders.push({
            candidateId: item.candidateId,
            decision: item.decision,
            status: result.status,
            factKey: result.factKey,
            currentVersion: result.current?.version,
            brandKnowledgeVersion: result.knowledgeVersion,
          });
        } catch (error) {
          results.push({
            candidateId: item.candidateId,
            ok: false,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
      const notification = reminders.length > 0
        ? await sendXiaojingMessage(buildKnowledgeBatchDecisionReminder(reminders), undefined, workspacePath)
        : { success: true };
      if (reminders.some((reminder) => reminder.decision !== 'reject')) {
        await recordGeoOperationMilestone(
          { workspaceId, sessionId: runtimeSessionId },
          'knowledge-confirmed',
        );
      }
      return jsonResponse({
        success: results.every((item) => item.ok),
        results,
        notificationQueued: notification.success,
        ...(!notification.success && notification.error
          ? { notificationError: notification.error }
          : {}),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return jsonResponse({ success: false, error: message }, 400);
    }
  }

  // 卡片状态水合：会话重载后按 id 批量读取候选当前状态，已裁决条目
  // 直接渲染结果而不是重复按钮。只允许读取本 Session 的候选。
  if (pathname === '/api/xiaojing/knowledge/candidates' && request.method === 'POST') {
    try {
      const payload = await request.json() as {
        workspaceId: string;
        sessionId: string;
        candidateIds: string[];
      };
      const runtimeSessionId = getRuntimeSessionIdForRequest();
      const workspaceId = basename(resolve(workspacePath));
      if (payload.workspaceId !== workspaceId
        || payload.sessionId !== runtimeSessionId) {
        return jsonResponse({
          success: false,
          error: 'Knowledge candidate identity does not match this brand Session.',
        }, 403);
      }
      if (!Array.isArray(payload.candidateIds) || payload.candidateIds.length === 0
        || payload.candidateIds.length > KNOWLEDGE_CARD_MAX_CANDIDATES
        || payload.candidateIds.some((id) => typeof id !== 'string')) {
        return jsonResponse({ success: false, error: 'knowledge_candidate_ids_invalid' }, 400);
      }
      const authority = createKnowledgeAuthority({ workspaceId, sessionId: runtimeSessionId });
      const candidates = await Promise.all(payload.candidateIds.map(async (candidateId) => {
        try {
          return await authority.candidate(candidateId);
        } catch {
          return null;
        }
      }));
      return jsonResponse({
        success: true,
        candidates: candidates.map((candidate) => candidate && toKnowledgeCardCandidate(candidate)),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return jsonResponse({ success: false, error: message }, 400);
    }
  }

  // Brand material ingestion is a structured Session control operation.
  // Local paths are only forwarded to Rust, which performs the no-follow
  // read and atomic copy; Node never opens them. Raw website/paste content
  // is persisted before the extraction capability is invoked.
  //
  // GD-materials: storage happens inside the request (bounded, no LLM);
  // extraction runs on the Session's serial background queue because it can
  // far outlive the 120s proxy ceiling on forwarded control-plane requests.
  // The renderer polls /materials/status and rebuilds the confirmation card
  // from durable candidate state, so a lost response can no longer strand
  // the knowledge confirmation gate.
  if (pathname === '/api/xiaojing/materials/import' && request.method === 'POST') {
    type ImportEntry = { ok: true; material: BrandMaterial } | { ok: false; errorCode: MaterialErrorCode };
    try {
      const payload = await request.json() as {
        workspaceId: string;
        sessionId: string;
        input:
          | { kind: 'files'; sourcePaths: string[] }
          | { kind: 'pasted-text'; text: string; displayName?: string }
          | { kind: 'website-url'; url: string };
      };
      const runtimeSessionId = getRuntimeSessionIdForRequest();
      const workspaceId = basename(resolve(workspacePath));
      if (payload.workspaceId !== workspaceId
        || payload.sessionId !== runtimeSessionId) {
        return jsonResponse({ success: false, error: 'material_identity_mismatch' }, 403);
      }
      const identity = { workspaceId, sessionId: runtimeSessionId };
      const port = createBrandMaterialPort(identity);
      const entries: ImportEntry[] = [];
      switch (payload.input.kind) {
        case 'files': {
          if (payload.input.sourcePaths.length === 0 || payload.input.sourcePaths.length > 20) {
            return jsonResponse({ success: false, error: 'material_file_count_invalid' }, 400);
          }
          for (const sourcePath of payload.input.sourcePaths) {
            try {
              const material = await port.importFile(sourcePath);
              entries.push({ ok: true, material });
              logMaterial({
                operation: 'import-file', workspaceId, sessionId: runtimeSessionId,
                materialId: material.id, status: 'completed',
              });
            } catch (error) {
              entries.push({ ok: false, errorCode: storageErrorCode(error, 'material_import_failed') });
              logMaterial({
                operation: 'import-file', workspaceId, sessionId: runtimeSessionId,
                status: 'failed', error,
              });
            }
          }
          break;
        }
        case 'pasted-text': {
          try {
            const material = await port.importText({
              inputKind: 'pasted-text',
              displayName: payload.input.displayName ?? '粘贴资料.txt',
              text: payload.input.text,
            });
            entries.push({ ok: true, material });
            logMaterial({
              operation: 'import-text', workspaceId, sessionId: runtimeSessionId,
              materialId: material.id, status: 'completed',
            });
          } catch (error) {
            entries.push({ ok: false, errorCode: storageErrorCode(error, 'material_import_failed') });
            logMaterial({
              operation: 'import-text', workspaceId, sessionId: runtimeSessionId,
              status: 'failed', error,
            });
          }
          break;
        }
        case 'website-url': {
          try {
            const fetched = await fetchWebsiteMaterial(payload.input.url, {}, request.signal);
            const material = await port.importText({
              inputKind: 'website-url',
              displayName: fetched.displayName,
              text: fetched.html,
              sourceUrl: fetched.finalUrl,
            });
            entries.push({ ok: true, material });
            logMaterial({
              operation: 'fetch-website', workspaceId, sessionId: runtimeSessionId,
              materialId: material.id, status: 'completed',
            });
          } catch (error) {
            entries.push({ ok: false, errorCode: storageErrorCode(error, 'website_fetch_failed') });
            logMaterial({
              operation: 'fetch-website', workspaceId, sessionId: runtimeSessionId,
              status: 'failed', error,
            });
          }
          break;
        }
        default:
          return jsonResponse({ success: false, error: 'material_input_kind_invalid' }, 400);
      }
      const materialIds = entries
        .filter((entry): entry is { ok: true; material: BrandMaterial } => entry.ok)
        .map((entry) => entry.material.id);
      if (materialIds.length > 0) {
        enqueueSessionProcessing(identity, () => runBackgroundProcessing({ identity, materialIds }));
      }
      return jsonResponse({ success: true, result: { entries } });
    } catch {
      return jsonResponse({ success: false, error: 'material_import_failed' }, 400);
    }
  }

  // 状态轮询与恢复：materialIds 提供时只查那些材料；缺省返回本 Session 最近
  // 的材料。非处理中材料附带批量确认卡投影，前端据此弹出/恢复确认卡——
  // 卡片数据不再只活在一次性响应里。
  if (pathname === '/api/xiaojing/materials/status' && request.method === 'POST') {
    try {
      const payload = await request.json() as {
        workspaceId: string;
        sessionId: string;
        materialIds?: string[];
      };
      const runtimeSessionId = getRuntimeSessionIdForRequest();
      const workspaceId = basename(resolve(workspacePath));
      if (payload.workspaceId !== workspaceId
        || payload.sessionId !== runtimeSessionId) {
        return jsonResponse({ success: false, error: 'material_identity_mismatch' }, 403);
      }
      if (payload.materialIds !== undefined
        && (payload.materialIds.length === 0
          || payload.materialIds.length > 50
          || payload.materialIds.some((id) => typeof id !== 'string'))) {
        return jsonResponse({ success: false, error: 'material_ids_invalid' }, 400);
      }
      const identity = { workspaceId, sessionId: runtimeSessionId };
      const items = await createBrandMaterialPort(identity).list({
        ...(payload.materialIds ? { materialIds: payload.materialIds } : {}),
        limit: 10,
      });
      const authority = createKnowledgeAuthority(identity);
      const materials = await Promise.all(items.map(async (item) => {
        let card = null;
        const terminal = item.material.status === 'awaiting-confirmation'
          || item.material.status === 'processed';
        if (terminal && item.candidateIds.length > 0) {
          // 不做前置截断：配额分配与溢出归因统一由 buildKnowledgeCandidatesCardData
          // 完成，否则第 51 条之后的候选永远不会出现在任何卡上（重建死胡同）。
          const candidates = await Promise.all(
            item.candidateIds.map(async (candidateId) => {
              try {
                return toKnowledgeCardCandidate(await authority.candidate(candidateId));
              } catch {
                return null;
              }
            }),
          );
          card = buildKnowledgeCandidatesCardData(
            { id: item.material.id, displayName: item.material.displayName },
            candidates.filter((candidate): candidate is NonNullable<typeof candidate> => candidate !== null),
          );
        }
        return { material: item.material, card };
      }));
      return jsonResponse({ success: true, materials });
    } catch {
      return jsonResponse({ success: false, error: 'material_status_failed' }, 400);
    }
  }

  if (pathname === '/api/xiaojing/materials/retry' && request.method === 'POST') {
    try {
      const payload = await request.json() as {
        workspaceId: string;
        sessionId: string;
        materialId: string;
      };
      const runtimeSessionId = getRuntimeSessionIdForRequest();
      const workspaceId = basename(resolve(workspacePath));
      if (payload.workspaceId !== workspaceId
        || payload.sessionId !== runtimeSessionId) {
        return jsonResponse({ success: false, error: 'material_identity_mismatch' }, 403);
      }
      const identity = { workspaceId, sessionId: runtimeSessionId };
      const port = createBrandMaterialPort(identity);
      const material = await port.get(payload.materialId);
      logMaterial({
        operation: 'retry', workspaceId, sessionId: runtimeSessionId,
        materialId: material.id, status: 'started',
      });
      enqueueSessionProcessing(identity, () => runBackgroundProcessing({
        identity,
        materialIds: [material.id],
      }));
      return jsonResponse({ success: true, result: { entries: [{ ok: true, material }] } });
    } catch (error) {
      logMaterial({
        operation: 'retry', workspaceId: basename(resolve(workspacePath)),
        sessionId: getRuntimeSessionIdForRequest(), status: 'failed', error,
      });
      return jsonResponse({ success: false, error: 'material_retry_failed' }, 400);
    }
  }

  if (pathname === '/api/xiaojing/materials/delete' && request.method === 'POST') {
    try {
      const payload = await request.json() as {
        workspaceId: string;
        sessionId: string;
        materialId: string;
      };
      const runtimeSessionId = getRuntimeSessionIdForRequest();
      const workspaceId = basename(resolve(workspacePath));
      if (payload.workspaceId !== workspaceId
        || payload.sessionId !== runtimeSessionId) {
        return jsonResponse({ success: false, error: 'material_identity_mismatch' }, 403);
      }
      const identity = { workspaceId, sessionId: runtimeSessionId };
      await createBrandMaterialPort(identity).delete(payload.materialId);
      logMaterial({
        operation: 'delete', workspaceId, sessionId: runtimeSessionId,
        materialId: payload.materialId, status: 'completed',
      });
      return jsonResponse({ success: true, result: { materialId: payload.materialId } });
    } catch (error) {
      logMaterial({
        operation: 'delete', workspaceId: basename(resolve(workspacePath)),
        sessionId: getRuntimeSessionIdForRequest(), status: 'failed', error,
      });
      // 固定码（material_processing_active / material_not_found 等）透传给
      // 渲染层：「处理中稍后再删」与真失败必须在 UI 上可区分。
      const message = error instanceof Error ? error.message : '';
      const code = MATERIAL_ERROR_CODES.find((candidate) => message.includes(candidate))
        ?? 'material_delete_failed';
      return jsonResponse({ success: false, error: code }, 400);
    }
  }

  // 存量材料手动重扫（ADR-0008 T7）：对 workspace 内已导入的 docx/pptx 旧
  // 材料（图片曾被丢弃、原始字节留存）手动触发一次内嵌图提取，复用 T3 的
  // 同一条提取/打标/入库管线；sha256 唯一键保证幂等，重复触发不产生重复
  // 候选。同步一次通过（时间预算有界，预算截断幂等可续）；不动材料 attempt
  // 与终态、不产出知识候选。
  if (pathname === '/api/xiaojing/materials/rescan-images' && request.method === 'POST') {
    try {
      const payload = await request.json() as { workspaceId: string; sessionId: string };
      const runtimeSessionId = getRuntimeSessionIdForRequest();
      const workspaceId = basename(resolve(workspacePath));
      if (payload.workspaceId !== workspaceId
        || payload.sessionId !== runtimeSessionId) {
        return jsonResponse({ success: false, error: 'material_identity_mismatch' }, 403);
      }
      const identity = { workspaceId, sessionId: runtimeSessionId };
      const capabilities = getXiaojingGeoProviderCapabilities();
      logMaterial({
        operation: 'rescan-images', workspaceId, sessionId: runtimeSessionId,
        status: 'started',
      });
      // 每份材料的提取预算（也约束单次打标调用）与整次通过的总预算共同
      // 保证同步请求落在转发控制面 120s 超时内；预算截断由幂等续扫兜底。
      const service = new MaterialImportService(
        identity,
        createBrandMaterialPort(identity),
        capabilities.extraction,
        createKnowledgeAuthority(identity),
        {},
        capabilities.keywordSearch,
        RESCAN_MATERIAL_BUDGET_MS,
      );
      const result = await service.rescanWorkspaceDocumentImages({
        totalBudgetMs: RESCAN_TOTAL_BUDGET_MS,
      });
      logMaterial({
        operation: 'rescan-images', workspaceId, sessionId: runtimeSessionId,
        status: 'completed',
      });
      return jsonResponse({ success: true, result });
    } catch (error) {
      logMaterial({
        operation: 'rescan-images', workspaceId: basename(resolve(workspacePath)),
        sessionId: getRuntimeSessionIdForRequest(), status: 'failed', error,
      });
      return jsonResponse({ success: false, error: 'material_rescan_failed' }, 400);
    }
  }

  // 材料图片候选清单（配图候选只读预览条的唯一清单源）：renderer 经本
  // Session 控制面请求，Sidecar 走 T2 的 management images/list 端点
  // （workspace 作用域、created_at 倒序、limit clamp 1..200）。只读投影，
  // 无写操作；纯清单不含图片字节（字节按需走下方 content 路由）。
  if (pathname === '/api/xiaojing/material-images/list' && request.method === 'POST') {
    try {
      const payload = await request.json() as {
        workspaceId: string;
        sessionId: string;
        limit?: number;
      };
      const runtimeSessionId = getRuntimeSessionIdForRequest();
      const workspaceId = basename(resolve(workspacePath));
      if (payload.workspaceId !== workspaceId
        || payload.sessionId !== runtimeSessionId) {
        return jsonResponse({ success: false, error: 'material_identity_mismatch' }, 403);
      }
      // 与 Rust images/list 的 clamp 对齐：未提供用存储缺省，提供必须是有界整数。
      if (payload.limit !== undefined
        && (!Number.isInteger(payload.limit) || payload.limit < 1 || payload.limit > 200)) {
        return jsonResponse({ success: false, error: 'material_image_limit_invalid' }, 400);
      }
      const identity = { workspaceId, sessionId: runtimeSessionId };
      const images = await createBrandMaterialPort(identity)
        .listImageAssets(payload.limit !== undefined ? { limit: payload.limit } : {});
      return jsonResponse({ success: true, images });
    } catch (error) {
      logMaterial({
        operation: 'image-list', workspaceId: basename(resolve(workspacePath)),
        sessionId: getRuntimeSessionIdForRequest(), status: 'failed', error,
      });
      // Rust/management 固定码原样透传，其余收敛为本路由固定码。
      const message = error instanceof Error ? error.message : '';
      const code = MATERIAL_ERROR_CODES.find((candidate) => message.includes(candidate))
        ?? 'material_image_list_failed';
      return jsonResponse({ success: false, error: code }, 400);
    }
  }

  // 材料图片内容取回（ADR-0008 批准预览换 blob 的唯一字节源）：renderer 经
  // 本 Session 控制面请求，Sidecar 走 T2 的 management images/content 端点
  // （Rust 侧 sha256 校验 + committed-session 闸）。字节以 base64 过控制面
  // （预览单图 ≤10MB，与 egress 上传载荷同款形态）。
  if (pathname === '/api/xiaojing/material-images/content' && request.method === 'POST') {
    try {
      const payload = await request.json() as {
        workspaceId: string;
        sessionId: string;
        imageId: string;
      };
      const runtimeSessionId = getRuntimeSessionIdForRequest();
      const workspaceId = basename(resolve(workspacePath));
      if (payload.workspaceId !== workspaceId
        || payload.sessionId !== runtimeSessionId) {
        return jsonResponse({ success: false, error: 'material_identity_mismatch' }, 403);
      }
      if (typeof payload.imageId !== 'string'
        || !/^[A-Za-z0-9-]{1,64}$/.test(payload.imageId)) {
        return jsonResponse({ success: false, error: 'material_image_id_invalid' }, 400);
      }
      const identity = { workspaceId, sessionId: runtimeSessionId };
      const { bytes, mediaType } = await createBrandMaterialPort(identity)
        .imageAssetContent(payload.imageId);
      return jsonResponse({
        success: true,
        image: {
          imageId: payload.imageId,
          mediaType,
          bytesB64: Buffer.from(bytes).toString('base64'),
        },
      });
    } catch (error) {
      logMaterial({
        operation: 'image-content', workspaceId: basename(resolve(workspacePath)),
        sessionId: getRuntimeSessionIdForRequest(), status: 'failed', error,
      });
      const message = error instanceof Error ? error.message : '';
      const code = MATERIAL_ERROR_CODES.find((candidate) => message.includes(candidate))
        ?? 'material_image_content_failed';
      return jsonResponse({ success: false, error: code }, 400);
    }
  }

  return null;
}
