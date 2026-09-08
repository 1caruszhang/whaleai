import type { SqlClient } from './client';

export interface Migration {
  name: string;
  sql: string;
}

/**
 * 迁移注册表：只追加、不改已发布条目。SQL 写成 SQLite 与 PostgreSQL
 * 都能直读的 ANSI 形态（TEXT 主键、ISO 时间戳、INTEGER 布尔），迁 PG 时
 * 由 pg 版 SqlClient 直接重放同一批文件。
 */
export const MIGRATIONS: readonly Migration[] = [
  {
    name: '0001_accounts_sessions_ledger',
    sql: `
      CREATE TABLE accounts (
        id TEXT PRIMARY KEY,
        phone TEXT NOT NULL UNIQUE,
        password_hash TEXT NOT NULL,
        password_version INTEGER NOT NULL DEFAULT 1,
        status TEXT NOT NULL DEFAULT 'active',
        must_change_password INTEGER NOT NULL DEFAULT 0,
        balance INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE auth_sessions (
        id TEXT PRIMARY KEY,
        account_id TEXT NOT NULL REFERENCES accounts(id),
        created_at TEXT NOT NULL,
        last_seen_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        revoked_at TEXT,
        revoked_reason TEXT
      );
      CREATE INDEX idx_auth_sessions_account ON auth_sessions(account_id);

      CREATE TABLE refresh_tokens (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES auth_sessions(id),
        token_hash TEXT NOT NULL UNIQUE,
        issued_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        consumed_at TEXT,
        replaced_by TEXT,
        revoked_at TEXT
      );
      CREATE INDEX idx_refresh_tokens_session ON refresh_tokens(session_id);

      CREATE TABLE ledger_entries (
        id TEXT PRIMARY KEY,
        account_id TEXT NOT NULL REFERENCES accounts(id),
        delta INTEGER NOT NULL,
        balance_after INTEGER NOT NULL,
        kind TEXT NOT NULL,
        note TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL
      );
      CREATE INDEX idx_ledger_entries_account ON ledger_entries(account_id, created_at);
    `,
  },
  {
    name: '0002_billing_permits',
    sql: `
      CREATE TABLE billing_permits (
        id TEXT PRIMARY KEY,
        account_id TEXT NOT NULL REFERENCES accounts(id),
        operation TEXT NOT NULL,
        units INTEGER NOT NULL,
        unit_price INTEGER NOT NULL,
        base_price INTEGER NOT NULL DEFAULT 0,
        frozen_remaining INTEGER NOT NULL,
        status TEXT NOT NULL DEFAULT 'open',
        created_at TEXT NOT NULL,
        settled_at TEXT
      );
      CREATE INDEX idx_billing_permits_account_status ON billing_permits(account_id, status);

      CREATE TABLE permit_unit_reports (
        permit_id TEXT NOT NULL REFERENCES billing_permits(id),
        unit_index INTEGER NOT NULL,
        outcome TEXT NOT NULL,
        reported_at TEXT NOT NULL,
        PRIMARY KEY (permit_id, unit_index)
      );
    `,
  },
  {
    // 账本流水序号：created_at 同毫秒并列时它才是全序的落账顺序依据
    // （毫秒精度的 ISO 时间戳 + 随机 uuid 都给不出插入顺序）。取值由
    // applyBalanceChange 在写流水的同一事务里按账号 MAX(seq)+1 发号，
    // 不用 SQLite 自增/rowid——本列是普通 INTEGER，PG 直读。存量行按
    // (created_at, id) 定序回填：同毫秒旧行的真实插入顺序已不可考，
    // id 只作确定性决胜，回填后新发号不再受影响。
    name: '0003_ledger_entry_seq',
    sql: `
      ALTER TABLE ledger_entries ADD COLUMN seq INTEGER NOT NULL DEFAULT 0;
      UPDATE ledger_entries AS entry
      SET seq = numbered.rn
      FROM (
        SELECT id, ROW_NUMBER() OVER (ORDER BY created_at, id) AS rn FROM ledger_entries
      ) AS numbered
      WHERE entry.id = numbered.id;
      CREATE UNIQUE INDEX idx_ledger_entries_account_seq ON ledger_entries(account_id, seq);
      DROP INDEX idx_ledger_entries_account;
    `,
  },
  {
    // 票 04：对话隐藏额度。accounts.chat_quota_used_milli 为本充值周期内的
    // 旁路计量累计（千分之一点），由 topup 入账事务清零（任意档位充值刷新）；
    // chat_usage_records 按请求落 token 用量与折点，供运营与 DeepSeek 账单
    // 对账。免费对话无余额变动，故不进 ledger_entries（Σdelta == balance
    // 的账本口径不被污染）。
    name: '0004_chat_usage_metering',
    sql: `
      ALTER TABLE accounts ADD COLUMN chat_quota_used_milli INTEGER NOT NULL DEFAULT 0;

      CREATE TABLE chat_usage_records (
        id TEXT PRIMARY KEY,
        account_id TEXT NOT NULL REFERENCES accounts(id),
        model TEXT NOT NULL DEFAULT '',
        input_tokens INTEGER NOT NULL DEFAULT 0,
        cache_read_tokens INTEGER NOT NULL DEFAULT 0,
        cache_creation_tokens INTEGER NOT NULL DEFAULT 0,
        output_tokens INTEGER NOT NULL DEFAULT 0,
        points_milli INTEGER NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX idx_chat_usage_records_account ON chat_usage_records(account_id, created_at);
    `,
  },
  {
    // 票 05：Provider 代理旁路计量。网关代理的每次 Provider 请求（2xx 成功）
    // 落一行真实 token 用量（OpenAI 系 usage 口径；OSS/超级媒介无 token 则
    // 记次数）供运营与火山/豆包/OSS 账单对账。与 chat_usage_records 同理：
    // 计量不是余额变动，不进 ledger_entries（Σdelta == balance 不变量不被
    // 污染）；计费扣点走 permit 通道（票 03/07），本表只做旁路对账。
    name: '0005_provider_usage_metering',
    sql: `
      CREATE TABLE provider_usage_records (
        id TEXT PRIMARY KEY,
        account_id TEXT NOT NULL REFERENCES accounts(id),
        provider TEXT NOT NULL,
        route TEXT NOT NULL,
        input_tokens INTEGER NOT NULL DEFAULT 0,
        output_tokens INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL
      );
      CREATE INDEX idx_provider_usage_records_account ON provider_usage_records(account_id, created_at);
    `,
  },
  {
    // 票 08：发布订单状态机 + 渠道资源快照缓存。publish_orders 是订单
    // 预扣/结转/退点的权威行：sn = 客户端生成的代理商订单号（幂等键，
    // 与上游同键，≤64）；placement_status 跟踪下单三态（pending/
    // placed/failed，failed 已释放冻结可安全重试）；ledger_status 三态
    // （frozen/settled/refunded）驱动账本——frozen 计入账号冻结口径
    // （total = available + frozen 不变量同时覆盖 permit 与订单两条
    // 冻结通道），settled 落 consume 流水，refunded 原路回补（frozen
    // 释放不动流水、settled 后退款落 refund 正流水）。closed_observed_at
    // 为「已关闭(9)」观察标记（资金语义上线后核实，期间维持冻结）。
    // media_price_cents 存下单时的上游权威媒介价（分），points =
    // ceil(分 × 4 / 25)（媒介费×1.6 含 60% 服务费 × 1元=10点锚点，
    // 向上取整）。distribution_resource_cache 为下单定价的渠道快照
    // 缓存（价格权威在服务器：下单读缓存、miss 回源 resource/query，
    // 资源变更回调刷新）。
    name: '0006_publish_orders',
    sql: `
      CREATE TABLE publish_orders (
        sn TEXT PRIMARY KEY,
        account_id TEXT NOT NULL REFERENCES accounts(id),
        kind TEXT NOT NULL,
        resource_id INTEGER NOT NULL,
        title TEXT NOT NULL,
        content_url TEXT NOT NULL,
        remark TEXT NOT NULL DEFAULT '',
        owner TEXT NOT NULL DEFAULT '',
        publish_form INTEGER,
        publish_type INTEGER,
        account_rule INTEGER,
        media_price_cents INTEGER NOT NULL,
        points INTEGER NOT NULL,
        placement_status TEXT NOT NULL,
        ledger_status TEXT NOT NULL,
        partner_sn TEXT,
        upstream_status INTEGER,
        url TEXT,
        published_at TEXT,
        closed_observed_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX idx_publish_orders_account ON publish_orders(account_id, created_at);

      CREATE TABLE distribution_resource_cache (
        kind TEXT NOT NULL,
        resource_id INTEGER NOT NULL,
        name TEXT NOT NULL DEFAULT '',
        price_cents INTEGER NOT NULL,
        status INTEGER,
        fetched_at TEXT NOT NULL,
        PRIMARY KEY (kind, resource_id)
      );
    `,
  },
  {
    // 用户在分发计划中冻结的点数护栏。网关按 execution_id 聚合尚未退款
    // 的订单，并在与订单冻结相同的事务中用服务器侧最新媒介价校验单篇/
    // 单次上限。默认值只用于兼容迁移前的历史订单，新订单必须显式携带。
    name: '0007_publish_order_spend_limits',
    sql: `
      ALTER TABLE publish_orders ADD COLUMN execution_id TEXT NOT NULL DEFAULT '';
      ALTER TABLE publish_orders ADD COLUMN item_id TEXT NOT NULL DEFAULT '';
      ALTER TABLE publish_orders ADD COLUMN per_article_max_points INTEGER NOT NULL DEFAULT 160000000;
      ALTER TABLE publish_orders ADD COLUMN execution_max_points INTEGER NOT NULL DEFAULT 160000000;
      CREATE INDEX idx_publish_orders_execution
        ON publish_orders(account_id, execution_id, ledger_status);
    `,
  },
  {
    // 悬挂回收第二档（按活跃度）：TTL 判据从 created_at 换成
    // last_activity_at——reportPermitUnit 每次成功回报（含幂等重放）都
    // 续活。长批量（文章逐篇回报）跑多久都不会被误回收；真死掉的
    // permit 从最后一次活跃起算 TTL。存量行按 created_at 回填，行为
    // 与第一档（纯创建时间判据）完全一致，平滑升级。
    name: '0008_permit_last_activity',
    sql: `
      ALTER TABLE billing_permits ADD COLUMN last_activity_at TEXT NOT NULL DEFAULT '';
      UPDATE billing_permits SET last_activity_at = created_at WHERE last_activity_at = '';
      CREATE INDEX idx_billing_permits_account_status_activity
        ON billing_permits(account_id, status, last_activity_at);
      DROP INDEX idx_billing_permits_account_status;
    `,
  },
  {
    // 运营备注：运营台给账号挂的内部标识（「这是谁的号」），只经 /admin
    // 读写，不进面向终端用户的 accountProjection。与账本 note、订单
    // remark 语义互不相干，故独立命名 admin_note。
    name: '0009_accounts_admin_note',
    sql: `
      ALTER TABLE accounts ADD COLUMN admin_note TEXT NOT NULL DEFAULT '';
    `,
  },
  {
    // 偏好召回名单（js_ai preferenceChannels 的运营台化）：权威来源从桌面
    // 端硬编码（src/shared/geo/channelRecall.ts DEFAULT_PREFERENCE_CHANNELS）
    // 迁到运营台。category 引用超级媒介官方「行业分类」词表（桌面
    // WE_MEDIA_INDUSTRY_NAMES）：0=通用兜底，1-25=行业行，26=工业贸易为
    // 媒体附录独有类目的补位码（100「其他」被
    // 桌面 industryCodesFor 的 NON_INDUSTRY 集排除、永不匹配，不入白名单）。
    // 注意两张官方码表码值冲突（媒体 channel_type 13=套餐系列 vs 自媒体
    // industry_category 13=美食），偏好打标只用行业分类词表。种子十项 =
    // 原内置名单（全部通用、精确名匹配），上线当天行为不变；桌面端经
    // /config/preference-channels?codes=… 按码拉取。
    name: '0010_preference_channels',
    sql: `
      CREATE TABLE preference_channels (
        id TEXT PRIMARY KEY,
        category INTEGER NOT NULL DEFAULT 0,
        name TEXT NOT NULL,
        domain TEXT NOT NULL DEFAULT '',
        exact INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX idx_preference_channels_category
        ON preference_channels(category, created_at);
      INSERT INTO preference_channels (id, category, name, domain, exact, created_at, updated_at) VALUES
        ('seed-preference-01', 0, '蓝色河畔（GEO排名）', '', 1, '2026-09-07T00:00:00.000Z', '2026-09-07T00:00:00.000Z'),
        ('seed-preference-02', 0, '红安网（GEO排名）', '', 1, '2026-09-07T00:00:00.000Z', '2026-09-07T00:00:00.000Z'),
        ('seed-preference-03', 0, '咸宁网主站', '', 1, '2026-09-07T00:00:00.000Z', '2026-09-07T00:00:00.000Z'),
        ('seed-preference-04', 0, '咸阳新闻网（GEO排名）', '', 1, '2026-09-07T00:00:00.000Z', '2026-09-07T00:00:00.000Z'),
        ('seed-preference-05', 0, '盐城网', '', 1, '2026-09-07T00:00:00.000Z', '2026-09-07T00:00:00.000Z'),
        ('seed-preference-06', 0, '南郡新闻（官方头条号）', '', 1, '2026-09-07T00:00:00.000Z', '2026-09-07T00:00:00.000Z'),
        ('seed-preference-07', 0, '济南时报（官方头条号）', '', 1, '2026-09-07T00:00:00.000Z', '2026-09-07T00:00:00.000Z'),
        ('seed-preference-08', 0, '安庆都市网（可发GEO）', '', 1, '2026-09-07T00:00:00.000Z', '2026-09-07T00:00:00.000Z'),
        ('seed-preference-09', 0, '博客园（GEO 优化首选，秒发带联系方式）', '', 1, '2026-09-07T00:00:00.000Z', '2026-09-07T00:00:00.000Z'),
        ('seed-preference-10', 0, '列举网（AI包收录）', '', 1, '2026-09-07T00:00:00.000Z', '2026-09-07T00:00:00.000Z');
    `,
  },
  {
    // 偏好名单匹配挑选流程（0011）：preference_channels 扩两列支持 id 绑定
    // ——kind 为 ''（名称条目，0010 种子与手输口子，桌面走既有名称匹配）或
    // 'media'/'we-media'（勾选行，resource_id 非空，桌面按 id 相等命中，
    // 形态天然正确、挂牌名漂移不再断裂）。种子十项不迁移：运营在页面渐进
    // 删除重绑。distribution_pool_snapshot 为资源池快照（上游无名称搜索，
    // 「点击匹配」自建）：管理页手动全量刷新（分页串行拉取）后搜索只打
    // 本地表；status≠2 即下架，页面标红提醒。domain 存 entrance_link 的
    // 主机名（勾选确认落 preference_channels.domain 用）。
    name: '0011_preference_channel_pick_flow',
    sql: `
      ALTER TABLE preference_channels ADD COLUMN kind TEXT NOT NULL DEFAULT '';
      ALTER TABLE preference_channels ADD COLUMN resource_id INTEGER;
      CREATE INDEX idx_preference_channels_binding
        ON preference_channels(kind, resource_id);

      CREATE TABLE distribution_pool_snapshot (
        kind TEXT NOT NULL,
        resource_id INTEGER NOT NULL,
        name TEXT NOT NULL DEFAULT '',
        domain TEXT NOT NULL DEFAULT '',
        status INTEGER,
        price_cents INTEGER NOT NULL DEFAULT 0,
        geo_count INTEGER NOT NULL DEFAULT 0,
        fetched_at TEXT NOT NULL,
        PRIMARY KEY (kind, resource_id)
      );
    `,
  },
  {
    // 偏好名单匹配挑选·行业联动（0012）：快照补结构化类目与 GEO 标记，
    // 支撑「按品牌所属行业过滤候选」与保底召回同一套垂类规则对齐——
    // category_code 按形态解释（同码不同义，绝不能跨形态比较）：媒体存
    // channel_type（官方「频道类型」附录，如 18=食品餐饮），自媒体存
    // industry_category（官方「行业分类」附录 1-25，与偏好行业码表同一张
    // 表）；geo=1 即官方 GEO 标记（geo_platforms 非空），行业无关、不入选
    // 行业候选（用户裁决 2026-09-08：GEO 是召回质量信号不是行业归属），
    // 仅在管理页结果表展示（GEO ×N 列）。
    name: '0012_pool_snapshot_category_geo',
    sql: `
      ALTER TABLE distribution_pool_snapshot ADD COLUMN category_code INTEGER;
      ALTER TABLE distribution_pool_snapshot ADD COLUMN geo INTEGER NOT NULL DEFAULT 0;
    `,
  },
];

/** 建表只经本 runner：幂等、每条迁移独立事务、记录进 schema_migrations。 */
export function migrateDatabase(db: SqlClient): string[] {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      name TEXT PRIMARY KEY,
      applied_at TEXT NOT NULL
    )
  `);
  const applied = new Set(
    db.all<{ name: string }>('SELECT name FROM schema_migrations', []).map(row => row.name),
  );
  const newlyApplied: string[] = [];
  for (const migration of MIGRATIONS) {
    if (applied.has(migration.name)) continue;
    db.transaction(() => {
      db.exec(migration.sql);
      db.run('INSERT INTO schema_migrations (name, applied_at) VALUES (?, ?)', [
        migration.name,
        new Date().toISOString(),
      ]);
    });
    newlyApplied.push(migration.name);
  }
  return newlyApplied;
}
