#!/usr/bin/env node
// 存量清理（geo-plan-normalization 票 09，2026-09-02 执行）：取消三具卡死在
// 材料收集步骤的死锁轮。
//
// 背景：跳过材料收集出口（票 07）上线前，「全链意图 + 不更新知识」组合会生成
// 含知识段的计划，操作在计划放行后永久停在 collect-materials:ready，任何会话
// 都无法推进（见 specs/plans/2026-09-02-geo-plan-normalization-spec.md 决策 8）。
// 本脚本把三具存量轮落库为 cancelled 终态，终态写法对齐 Rust cancel mutation
// （mutate_geo_operation action=cancel）：state/status='cancelled'、revision+1、
// updated_at/terminal_at=now（RFC3339，Z 形式），步骤状态按 cancel 语义原样保留；
// error_json 是本票要求的留痕额外写入（Rust cancel 不写 error），原因可追溯：
// 卡死在材料收集、跳过出口上线前的存量。
//
// NULL 0cada786 是「下一轮优化 + 不更新知识」的正确形状（起点即从问题池选择、
// 停在问题确认门），保留不动——它是票 10 跨会话接管的端到端验收样本。
//
// 幂等：目标行已处于终态时跳过并提示；死锁特征不匹配时 fail-loud 不写库。
// 用法：node scripts/cancel-legacy-geo-operations.mjs [--db <project.sqlite 路径>]
// （缺省扫描 %LOCALAPPDATA%/Xiaojing/brands/*/project.sqlite。）

import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';

const CANCELLED_CODE = 'legacy-material-collection-deadlock';
const CANCELLED_MESSAGE =
  '存量清理取消：该轮卡死在材料收集步骤（跳过材料收集出口上线前的旧计划形状），' +
  '由 geo-plan-normalization 票 09 清理；操作记录见仓库 scripts/cancel-legacy-geo-operations.mjs。';

// 票 09 指名的三具死锁轮（id 前缀即票据口径：fa450460 会话 97495290、
// f74ce69e 会话 b5c8420c、NULL 1b44fd12）。
const TARGETS = [
  '97495290-6165-400f-aa0c-8978edc398a0',
  'b5c8420c-becb-4fbf-b711-f4c0124728ff',
  '1b44fd12-e061-49f4-a707-3e1fad2444d1',
];
// 保留不动的验收样本（票 10 跨会话接管端到端）。
const PRESERVED = '0cada786-d2c7-4f48-809b-a3ed247943c9';

const TERMINAL_STATUSES = new Set(['succeeded', 'failed', 'cancelled']);
// 步骤未走完集合（pending 属于未走完，含它才对得起「首个未走完步骤」的判断）。
const UNFINISHED_STEP_STATUSES = [
  'pending',
  'ready',
  'running',
  'awaiting-confirmation',
  'failed',
];

function candidateDatabases() {
  const localAppData =
    process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local');
  const brandsRoot = join(localAppData, 'Xiaojing', 'brands');
  let entries = [];
  try {
    entries = readdirSync(brandsRoot, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(brandsRoot, entry.name, 'project.sqlite'));
}

function assertDeadlockSignature(operation) {
  // 死锁特征：计划认可门已放行（acknowledge-plan succeeded），其后首个
  // 未走完步骤停在 collect-materials:ready。特征不符说明瞄错了行，宁可不写。
  const steps = JSON.parse(operation.steps_json);
  const ack = steps.find((step) => step.id === 'acknowledge-plan');
  const stuck = steps.find((step) =>
    UNFINISHED_STEP_STATUSES.includes(step.status),
  );
  if (!ack || ack.status !== 'succeeded') {
    throw new Error('死锁特征不符：计划认可门未放行');
  }
  if (!stuck || stuck.id !== 'collect-materials' || stuck.status !== 'ready') {
    throw new Error(
      `死锁特征不符：首个未走完步骤为 ${stuck ? `${stuck.id}:${stuck.status}` : '无'}`,
    );
  }
}

const dbFlagIndex = process.argv.indexOf('--db');
const dbPath = dbFlagIndex !== -1 ? process.argv[dbFlagIndex + 1] : undefined;
if (dbFlagIndex !== -1 && !dbPath) {
  console.error('--db 需要一个 project.sqlite 路径参数');
  process.exit(1);
}
const databases = dbPath ? [dbPath] : candidateDatabases();

let cancelled = 0;
let skipped = 0;
for (const path of databases) {
  const db = new DatabaseSync(path);
  try {
    const preserved = db
      .prepare('SELECT id, status FROM geo_operations WHERE id = ?')
      .get(PRESERVED);
    // 验收样本若缺失或已终态（如票 10 接管后走完全链），只警告不阻断——
    // 本脚本对三具目标行本就幂等跳过。
    if (!preserved) {
      console.warn(`警告：验收样本 ${PRESERVED} 不存在，请核对是否瞄错了库`);
    } else if (TERMINAL_STATUSES.has(preserved.status)) {
      console.warn(
        `警告：验收样本 ${PRESERVED} 已处于终态 ${preserved.status}（票 10 完成后的合法状态）`,
      );
    }
    for (const id of TARGETS) {
      const operation = db
        .prepare(
          'SELECT status, revision, steps_json FROM geo_operations WHERE id = ?',
        )
        .get(id);
      if (!operation) continue;
      if (TERMINAL_STATUSES.has(operation.status)) {
        console.log(`跳过 ${id}（已终态 ${operation.status}）`);
        skipped += 1;
        continue;
      }
      assertDeadlockSignature(operation);
      const now = new Date().toISOString();
      const errorJson = JSON.stringify({
        code: CANCELLED_CODE,
        message: CANCELLED_MESSAGE,
        retryable: false,
      });
      const changed = db
        .prepare(
          `UPDATE geo_operations
             SET state = 'cancelled', status = 'cancelled',
                 revision = revision + 1,
                 updated_at = ?, terminal_at = ?, error_json = ?
           WHERE id = ? AND status NOT IN ('succeeded','failed','cancelled')`,
        )
        .run(now, now, errorJson, id);
      if (changed.changes !== 1) {
        throw new Error(`取消 ${id} 时条件更新未命中（并发写？）`);
      }
      console.log(
        `取消 ${id}（原 status=${operation.status}, revision=${operation.revision} → ${operation.revision + 1}）`,
      );
      cancelled += 1;
    }
  } finally {
    db.close();
  }
}

console.log(`完成：取消 ${cancelled} 具，跳过 ${skipped} 具；${PRESERVED} 保留不动。`);
if (cancelled === 0 && skipped === 0) {
  console.error('未找到任何目标行：请用 --db 指定 project.sqlite 路径。');
  process.exitCode = 1;
}
