#!/usr/bin/env node
// geo-plan-normalization 票 10（端到端验收）的会话驱动器：对一个由真实桌面
// 应用拉起的 Session Sidecar（127.0.0.1:<port>）以 HTTP/SSE 驱动真实主
// Agent 会话，把每一步证据（用户消息、助手 wire 块、工具调用与结果、
// 隐藏决策回执、确认门放行、操作状态机快照）落盘为 JSONL，供验收核对
// 与思考块量级对比（票 01 观察记录的口径）。
//
// 前提：应用（Rust 管理面 + 凭据 admission）已运行且已创建聊天会话——
// sidecar 必须由 Rust 拉起，GEO 持久化才能走真实管理 API。本脚本不注入
// 任何凭据、不绕过任何门：所有动作与 renderer 走同一组 sidecar 路由，
// 确认门放行调用的就是进度卡/确认卡按钮背后的路由。
//
// 一次性命令模式（会话状态由服务端持久化，逐命令独立连接互不影响）：
//   node scripts/e2e-geo-acceptance.mjs --port 31415 --scenario s1 --cmd 'send 帮我做GEO优化'
// 命令：
//   send <文本>                          发一条用户消息并等本轮收尾/悬卡
//   pick <requestId尾缀> <题面子串>=<选项子串>...   以结构化答案回复提问卡
//   state [operationId尾缀]               读 project.sqlite 输出操作步骤态
//   pools                                列最近问题池（id/status/revision）
//   confirm-pool <poolId尾缀> <选择数N>   复用卡确认（预勾选项里取前 N 个）
//   release-plan <operationId尾缀>        计划认可门放行（confirm-step）
//   who                                  打印会话身份与状态
//
// 收尾判定：会话回 idle，或 AskUserQuestion 悬卡出现并静默 20 秒（模型在
// 等用户作答，turn 不收尾属正常）。重连时冷回放的历史按消息 id/正文去重，
// 只记本命令窗口内的新事件；隐藏 reminder 按正文去重（两次连接各看到一次
// 时只落一次）。
//
// 证据文件：.scratch/geo-plan-normalization/e2e/<scenario>-events.jsonl，
// 每行 {t, kind, ...}。凭据与 token 永不出现在事件里。

import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const args = process.argv.slice(2);
const value = (flag) => {
  const i = args.indexOf(flag);
  return i < 0 ? null : args[i + 1];
};
const port = Number(value('--port') ?? 0);
const scenario = value('--scenario') ?? 'ad-hoc';
const command = value('--cmd') ?? '';
if (!port || !command) {
  console.error('用法: node scripts/e2e-geo-acceptance.mjs --port <sidecar端口> --scenario <名> --cmd <命令>');
  process.exit(1);
}

const base = `http://127.0.0.1:${port}`;
const evidenceDir = join(process.cwd(), '.scratch', 'geo-plan-normalization', 'e2e');
mkdirSync(evidenceDir, { recursive: true });
const evidencePath = join(evidenceDir, `${scenario}-events.jsonl`);

function record(kind, data = {}) {
  appendFileSync(evidencePath, JSON.stringify({ t: new Date().toISOString(), kind, ...data }) + '\n');
}

// 去重集合：本场景证据里已出现过的消息 id 与 reminder 正文。
const seenMessageIds = new Set();
const seenReminderTexts = new Set();
if (existsSync(evidencePath)) {
  for (const line of readFileSync(evidencePath, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      const ev = JSON.parse(line);
      if (ev.kind === 'assistant-message' && ev.id) seenMessageIds.add(ev.id);
      if (ev.kind === 'hidden-reminder' && ev.content) seenReminderTexts.add(ev.content);
    } catch { /* 行损坏即跳过 */ }
  }
}

// 会话身份（chat:init 携带）；确认路由要求与运行时会话一致。
let sessionId = null;
let sessionState = 'unknown';
const pendingAsks = new Map(); // requestId -> questions[]

function parseWireBlocks(message) {
  if (typeof message?.content !== 'string') return [];
  const s = message.content;
  if (!s.startsWith('[{')) return [];
  try {
    const parsed = JSON.parse(s);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

async function post(path, body) {
  const resp = await fetch(base + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await resp.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* 保留原文 */ }
  return { status: resp.status, json, text };
}

function identity(extra = {}) {
  if (!sessionId) throw new Error('尚无会话身份（等待 chat:init）');
  return { sessionId, ...extra };
}

// ---- SSE（event: <name>\ndata: <json>\n\n）----
const controller = new AbortController();
const sse = await fetch(base + '/chat/stream', { signal: controller.signal });
if (!sse.ok || !sse.body) {
  console.error(`SSE 连接失败: HTTP ${sse.status}`);
  process.exit(1);
}
const reader = sse.body.getReader();
const decoder = new TextDecoder();
let sseBuffer = '';

// 收尾信号不再驱动 waitTurn（改轮询），悬卡信息仍由 SSE 喂给 pendingAsks。

function handleEvent(event, payload) {
  if (event === 'chat:init') {
    sessionId = payload.sessionId;
    sessionState = payload.sessionState;
    console.log(`[init] session=${sessionId} state=${sessionState}`);
    record('chat-init', { sessionId, sessionState });
    return;
  }
  if (event === 'chat:status') {
    const prev = sessionState;
    sessionState = payload.sessionState;
    console.log(`[status] ${prev} -> ${sessionState}`);
    record('chat-status', { from: prev, to: sessionState });
    return;
  }
  if (event === 'ask-user-question:request') {
    pendingAsks.set(payload.requestId, payload.questions ?? []);
    console.log(`[ask] 悬卡 ${payload.requestId.slice(0, 8)}`);
    printAsks(payload.requestId);
    record('ask-request', { requestId: payload.requestId, questions: payload.questions });
    return;
  }
  if (event === 'chat:message-complete') {
    const message = payload.message;
    if (!message || message.role !== 'assistant') return;
    if (seenMessageIds.has(message.id)) return; // 冷回放去重
    seenMessageIds.add(message.id);
    const blocks = parseWireBlocks(message);
    console.log(`[assistant] ${blocks.map(describeBlock).join(' | ')}`);
    record('assistant-message', {
      id: message.id,
      durationMs: message.durationMs,
      usage: message.usage,
      thinkingLengths: blocks.filter((b) => b.type === 'thinking').map((b) => b.thinking.length),
      toolCalls: blocks.filter((b) => b.type === 'tool_use').map((b) => ({
        name: b.tool?.name,
        input: b.tool?.parsedInput,
        resultPreview: typeof b.tool?.result === 'string' ? b.tool.result.slice(0, 500) : undefined,
      })),
      textBlocks: blocks.filter((b) => b.type === 'text').map((b) => b.text),
    });
    return;
  }
  if (event === 'chat:message-replay') {
    const message = payload.message;
    if (message?.role === 'user') {
      // 隐藏 reminder 是门放行后的决策回执信封（next-step 引述载体）。
      const isReminder = typeof message.content === 'string' && message.content.includes('<system-reminder>');
      if (isReminder && !seenReminderTexts.has(message.content)) {
        seenReminderTexts.add(message.content);
        console.log(`[reminder] ${summarize(message.content, 200)}`);
        record('hidden-reminder', { content: message.content });
      }
    }
    return;
  }
  if (event === 'chat:agent-error') {
    console.log(`[agent-error] ${payload.message}`);
    record('agent-error', { message: payload.message });
  }
}

function describeBlock(b) {
  if (b.type === 'thinking') return `thinking(${b.thinking.length}字)`;
  if (b.type === 'text') return `text(${b.text.length}字)`;
  if (b.type === 'tool_use') return `tool:${b.tool?.name}`;
  return b.type;
}

function summarize(text, limit) {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length <= limit ? flat : `${flat.slice(0, limit)}…`;
}

async function pumpSse() {
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      sseBuffer += decoder.decode(value, { stream: true });
      let idx;
      let currentEventName = '?';
      while ((idx = sseBuffer.indexOf('\n')) >= 0) {
        const raw = sseBuffer.slice(0, idx).replace(/\r$/, '');
        sseBuffer = sseBuffer.slice(idx + 1);
        if (raw.startsWith('event:')) {
          currentEventName = raw.slice(6).trim();
          continue;
        }
        if (!raw.startsWith('data:')) continue;
        let payload;
        try { payload = JSON.parse(raw.slice(5).trim()); } catch { continue; }
        handleEvent(currentEventName, payload);
      }
    }
  } catch {
    // 结束时的 reader.cancel()/进程退出会以 AbortError 结束读取，属正常。
  }
}

function printAsks(requestId) {
  const questions = pendingAsks.get(requestId) ?? [];
  for (const q of questions) {
    console.log(`  题: ${q.question}`);
    for (const o of q.options ?? []) {
      console.log(`    - ${o.label}: ${summarize(o.description ?? '', 90)}`);
    }
  }
}

// ---- 品牌库只读快照 ----
function brandsRoot() {
  return join(process.env.LOCALAPPDATA, 'Xiaojing', 'brands');
}

function brandWorkspaceId() {
  const dirs = readdirSync(brandsRoot(), { withFileTypes: true }).filter((e) => e.isDirectory());
  if (dirs.length !== 1) throw new Error(`品牌目录数 ${dirs.length}，无法缺省（本驱动按单品牌工作台设计）`);
  return dirs[0].name;
}

function withBrandDb(fn) {
  const db = new DatabaseSync(join(brandsRoot(), brandWorkspaceId(), 'project.sqlite'), { readOnly: true });
  try {
    return fn(db);
  } finally {
    db.close();
  }
}

function findOperation(db, suffix) {
  const rows = db.prepare('SELECT id FROM geo_operations').all();
  const hits = rows.filter((r) => r.id.startsWith(suffix));
  if (hits.length !== 1) throw new Error(`操作尾缀 ${suffix} 命中 ${hits.length} 行`);
  return hits[0].id;
}

function printOperationState(suffix) {
  const view = withBrandDb((db) => {
    const opId = findOperation(db, suffix);
    const op = db.prepare(
      'SELECT id, kind, goal, state, status, session_id, revision, update_knowledge, updated_at FROM geo_operations WHERE id = ?',
    ).get(opId);
    const steps = JSON.parse(db.prepare('SELECT steps_json FROM geo_operations WHERE id = ?').get(opId).steps_json);
    return { ...op, steps: steps.map((s) => `${s.id}:${s.status}`) };
  });
  console.log(JSON.stringify(view, null, 1));
  record('operation-state', { operation: view });
}

// ---- 收尾等待 ----
// 以 /api/session-state 轮询为准（SSE 状态事件相对 POST 返回有传播延迟，
// 只看本地镜像会把「已发消息但 starting 事件未达」误判成本轮已收尾）。
async function waitTurn(timeoutMs = 420_000) {
  const startedAt = Date.now();
  const deadline = startedAt + timeoutMs;
  let sawBusy = false;
  let askPendingSince = null;
  for (;;) {
    let state = null;
    try {
      state = await (await fetch(base + '/api/session-state')).json();
    } catch {
      state = null;
    }
    if (state?.isBusy) sawBusy = true;
    if (sawBusy && state && !state.isBusy) return 'idle';
    if (pendingAsks.size > 0) {
      askPendingSince ??= Date.now();
      if (Date.now() - askPendingSince > 20_000) return 'ask-pending';
    } else {
      askPendingSince = null;
    }
    // 消息发出后迟迟不见 busy 且无悬卡：本轮可能瞬间失败（如凭据缺失
    // fail-fast）——给 8 秒观察窗后以现状收尾，错误事件已另行记录。
    if (!sawBusy && !state?.isBusy && pendingAsks.size === 0 && Date.now() - startedAt > 8_000) {
      return 'idle-no-busy-observed';
    }
    if (Date.now() > deadline) return 'timeout';
    await new Promise((r) => setTimeout(r, 1_000));
  }
}

async function runCommand() {
  const spaceIdx = command.indexOf(' ');
  const cmd = spaceIdx < 0 ? command : command.slice(0, spaceIdx);
  const rest = spaceIdx < 0 ? '' : command.slice(spaceIdx + 1).trim();

  if (cmd === 'send') {
    record('user-send', { text: rest });
    const resp = await post('/chat/send', identity({ text: rest }));
    console.log(`[send] HTTP ${resp.status} ${JSON.stringify(resp.json ?? resp.text)}`);
  } else if (cmd === 'pick') {
    // pick <requestId尾缀> <题面子串>=<选项子串> [题面子串=选项子串 ...]
    const [ridSuffix, ...pairs] = rest.split(/\s+/);
    const entry = [...pendingAsks.entries()].find(([rid]) => rid.startsWith(ridSuffix));
    let questions;
    let rid;
    if (entry) {
      [rid, questions] = entry;
    } else {
      // 本连接未见悬卡（逐命令连接的常态）：从服务端快照接口拿不到悬卡，
      // 需要先以 asks 语义确认。此处直接报错提示先跑一次不带 --cmd 的
      // 观察连接或重发上一命令。
      throw new Error('本连接未见悬卡——请在同一命令里先 send，或重跑触发悬卡的命令');
    }
    const answers = {};
    for (const pair of pairs) {
      const eq = pair.indexOf('=');
      if (eq < 0) throw new Error('格式: 题面子串=选项子串');
      const qSub = pair.slice(0, eq);
      const oSub = pair.slice(eq + 1);
      const q = questions.find((x) => x.question?.includes(qSub));
      if (!q) throw new Error(`题面未命中: ${qSub}`);
      const o = (q.options ?? []).find((x) => x.label?.includes(oSub) || (x.description ?? '').includes(oSub));
      if (!o) throw new Error(`选项未命中: ${oSub}（选项: ${(q.options ?? []).map((x) => x.label).join(' / ')}）`);
      answers[q.question] = o.label;
    }
    record('ask-answer', { requestId: rid, answers });
    const resp = await post('/api/ask-user-question/respond', { requestId: rid, answers });
    console.log(`[respond] HTTP ${resp.status} ${JSON.stringify(resp.json)}`);
    pendingAsks.delete(rid);
  } else if (cmd === 'state') {
    printOperationState(rest || '0cada786');
    return;
  } else if (cmd === 'pools') {
    const rows = withBrandDb((db) => db.prepare(
      'SELECT id, status, revision, product_line, owner_session_id, updated_at FROM geo_question_pools ORDER BY updated_at DESC LIMIT 5',
    ).all());
    for (const r of rows) console.log(JSON.stringify(r));
    record('pools', { rows });
    return;
  } else if (cmd === 'confirm-pool') {
    // confirm-pool <poolId尾缀> <选择数N>——预勾选卡确认，取卡上前 N 问
    const [suffix, countArg] = rest.split(/\s+/);
    const { pool, selected } = withBrandDb((db) => {
      const rows = db.prepare('SELECT id, status, revision, questions_json FROM geo_question_pools ORDER BY updated_at DESC').all();
      const hits = rows.filter((r) => r.id.startsWith(suffix));
      if (hits.length !== 1) throw new Error(`池尾缀命中 ${hits.length} 行`);
      const target = hits[0];
      const questions = JSON.parse(target.questions_json);
      const n = Math.max(1, Math.min(Number(countArg ?? 3), questions.length));
      return { pool: target, selected: questions.slice(0, n) };
    });
    record('pool-confirm-request', { poolId: pool.id, expectedRevision: pool.revision, count: selected.length });
    const resp = await post('/api/xiaojing/question-pools/confirm', identity({
      poolId: pool.id,
      expectedRevision: pool.revision,
      questions: selected,
    }));
    console.log(`[confirm-pool] HTTP ${resp.status} ${summarize(JSON.stringify(resp.json ?? resp.text), 500)}`);
    record('pool-confirm-response', { status: resp.status, body: resp.json ?? resp.text });
  } else if (cmd === 'release-plan') {
    // release-plan <operationId尾缀>——进度卡「放行计划」同款路由
    const suffix = rest;
    const { opId, revision } = withBrandDb((db) => {
      const id = findOperation(db, suffix);
      return { opId: id, revision: db.prepare('SELECT revision FROM geo_operations WHERE id = ?').get(id).revision };
    });
    record('release-plan-request', { operationId: opId, expectedRevision: revision });
    const resp = await post('/api/xiaojing/geo-operations/confirm-step', identity({
      workspaceId: brandWorkspaceId(),
      operationId: opId,
      expectedRevision: revision,
      stepId: 'acknowledge-plan',
    }));
    console.log(`[release-plan] HTTP ${resp.status} ${summarize(JSON.stringify(resp.json ?? resp.text), 300)}`);
    record('release-plan-response', { status: resp.status, body: resp.json ?? resp.text });
  } else if (cmd === 'who' || cmd === 'observe') {
    if (cmd === 'observe') {
      const outcome = await waitTurn();
      console.log(`[turn] ${outcome}`);
      record('turn-outcome', { outcome, via: 'observe' });
      return;
    }
    console.log(`session=${sessionId} state=${sessionState}`);
    return;
  } else {
    throw new Error(`未知命令: ${cmd}`);
  }

  const outcome = await waitTurn();
  console.log(`[turn] ${outcome}`);
  record('turn-outcome', { outcome });
}

console.log(`驱动器就绪 → ${base}（证据: ${evidencePath}）`);
record('driver-start', { port, scenario, command: cmd0(command) });
void pumpSse();

// 等 chat:init 到位再执行命令（身份依赖）。
for (let i = 0; i < 100 && !sessionId; i++) {
  await new Promise((r) => setTimeout(r, 100));
}
try {
  await runCommand();
} catch (error) {
  console.error(`[错误] ${error instanceof Error ? error.message : error}`);
  record('driver-error', { message: error instanceof Error ? error.message : String(error) });
  process.exitCode = 1;
}
record('driver-exit', {});
// 平滑收尾：cancel 流读取后短暂让事件循环排空，再强退规避 libuv 在
// Windows 上 abort 活动请求的断言崩溃。
try {
  await reader.cancel();
} catch { /* 已关闭 */ }
controller.abort();
await new Promise((r) => setTimeout(r, 200));
process.exit(process.exitCode ?? 0);

function cmd0(full) {
  const i = full.indexOf(' ');
  return i < 0 ? full : full.slice(0, i);
}
