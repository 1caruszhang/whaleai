import { PREFERENCE_CATEGORY_NAMES } from './preference-channels';

/**
 * 池快照行业过滤的垂类匹配规则——与桌面端分发计划「保底召回」的规则逐条
 * 一致（移植自 src/shared/geo/distributionPlan.ts 的官方附录码表 + 行业词
 * 匹配器，2026-08-28 用户裁决版），让运营台「这个行业的候选」与桌面保底
 * 召回「这个行业命中的资源」保持同一语义：
 *
 * - 自媒体：industry_category 与偏好行业码表（1-25）本就是同一张官方
 *   「行业分类」附录，直接按码相等过滤（26=工业贸易为补位码，自媒体
 *   附录无此类目，天然无命中）；
 * - 媒体：上游无行业字段，按官方「频道类型」附录（channel_type）经
 *   行业词匹配映射（如「美食」→「食品餐饮」码 18）；
 * - 官方 GEO 标记（geo_platforms 非空）**不入选行业候选**（用户裁决
 *   2026-09-08：GEO 是召回质量信号不是行业归属，恒入选会让行业视图混入
 *   无关渠道）——仅在结果表展示；桌面保底召回路的「GEO 恒入选」是召回
 *   语义，不属于本过滤；
 * - 营销专区/杂项类目按类目名排除（码在两张附录里含义不同，按码排除
 *   会误杀：媒体 13=套餐系列该排除，自媒体 13=美食是核心类目）。
 *
 * 桌面保底路另有「行业词名命中资源名」的次级信号（计划行业词是自由词
 * 面）；本过滤只取结构化信号（类目码 + GEO 标记），词名命中不并入。
 */

/** 附录：频道类型（媒体 channel_type）——官方文档逐条抄录。 */
export const MEDIA_CHANNEL_TYPE_NAMES: Readonly<Record<number, string>> = {
  1: 'IT科技', 2: '生活消费', 3: '女性时尚', 4: '娱乐休闲', 5: '游戏网站',
  6: '汽车网站', 7: '教育培训', 8: '酒店旅游', 9: '健康医疗', 10: '房产家居',
  11: '财经商业', 12: '新闻资讯', 13: '套餐系列', 14: '最新秒杀', 15: '十元专区',
  16: '文化艺术', 17: '体育运动', 18: '食品餐饮', 19: '工业贸易', 20: '亲子母婴',
  21: '慈善公益', 100: '其他频道',
};

/** 营销专区/杂项类目按类目名排除（跨附录按码排除会误杀，见模块注释）。 */
const NON_INDUSTRY_CATEGORY_NAMES = new Set([
  '套餐系列',
  '最新秒杀',
  '十元专区',
  '其他频道',
  '其他',
]);

/** 行业词 → 类目名碎片 别名：仅当词面与类目名互不包含时兜底。 */
const INDUSTRY_TERM_ALIASES: Readonly<Record<string, readonly string[]>> = {
  IT: ['科技'], 数码: ['科技'], 互联网: ['科技'], 软件: ['科技'], 人工智能: ['科技'],
  电子: ['科技'],
  医美: ['健康', '医疗'], 医疗: ['健康', '医疗'], 医药: ['健康', '医疗'], 养生: ['健康'],
  美妆: ['时尚'], 服饰: ['时尚'], 奢侈品: ['时尚'],
  影视: ['娱乐'], 综艺: ['娱乐'], 明星: ['娱乐'],
  电竞: ['游戏'],
  民宿: ['旅游'],
  装修: ['家居'], 建材: ['家居'],
  金融: ['财经'], 证券: ['财经'], 保险: ['财经'], 银行: ['财经'],
  理财: ['财经'], 投资: ['财经'],
  媒体: ['新闻'], 资讯: ['新闻'],
  驾校: ['汽车'], 汽修: ['汽车'], 汽配: ['汽车'], 车辆: ['汽车'], 驾驶: ['汽车'],
  慈善: ['公益'],
  孕产: ['母婴'],
  收藏: ['文化'], 书画: ['文化'],
  健身: ['体育'], 足球: ['体育'], 篮球: ['体育'],
  农业: ['食品', '三农'], 农资: ['食品', '三农'],
  制造: ['工业'], 机械: ['工业'], 能源: ['工业'], 化工: ['工业'], 物流: ['工业'],
  贸易: ['工业'],
  家政: ['生活'], 消费: ['生活'],
  美食: ['食品'],
  餐饮: ['美食', '食品'],
};

/**
 * 行业词与类目名是否匹配（与桌面 matchesCategoryName 算法逐条一致）：
 * 整串包含 ∨ 别名碎片 ∨ 类目名 2-gram 子串（中文连写词的最小有意义片段，
 * 「美食」经别名「食品」命中「食品餐饮」，而非旧一对一硬映射的错误）。
 */
function matchesCategoryName(industry: string, name: string): boolean {
  if (industry.includes(name) || name.includes(industry)) return true;
  for (const [term, fragments] of Object.entries(INDUSTRY_TERM_ALIASES)) {
    if (!industry.includes(term)) continue;
    if (fragments.some(fragment => name.includes(fragment))) return true;
  }
  const industryChars = Array.from(industry);
  const nameChars = Array.from(name);
  for (let i = 0; i + 2 <= nameChars.length; i += 1) {
    if (industry.includes(nameChars.slice(i, i + 2).join(''))) return true;
  }
  return false;
}

/** 行业词 → 官方类目码集合（排除营销专区/杂项）。 */
export function industryCodesFor(
  industry: string,
  names: Readonly<Record<number, string>>,
): Set<number> {
  const trimmed = industry.trim();
  const codes = new Set<number>();
  if (!trimmed) return codes;
  for (const [rawCode, name] of Object.entries(names)) {
    if (NON_INDUSTRY_CATEGORY_NAMES.has(name)) continue;
    if (matchesCategoryName(trimmed, name)) codes.add(Number(rawCode));
  }
  return codes;
}

/**
 * 偏好行业码 → 媒体 channel_type 码集（模块加载时按码表名匹配算定）。
 * 例：13 美食 → {18 食品餐饮}；24 家居与 19 房产同享 {10 房产家居}；
 * 历史/三农/动漫等无媒体类目映射 → 空集（这些行业只剩自媒体与 GEO 标记）。
 */
export const MEDIA_CHANNEL_TYPE_CODES_BY_INDUSTRY: ReadonlyMap<number, ReadonlySet<number>> =
  new Map(
    Object.entries(PREFERENCE_CATEGORY_NAMES)
      .filter(([rawCode]) => Number(rawCode) !== 0)
      .map(([rawCode, label]) => [
        Number(rawCode),
        industryCodesFor(label, MEDIA_CHANNEL_TYPE_NAMES),
      ]),
  );

export function mediaChannelTypeCodesFor(industry: number): ReadonlySet<number> {
  return MEDIA_CHANNEL_TYPE_CODES_BY_INDUSTRY.get(industry) ?? new Set<number>();
}
