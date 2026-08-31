/**
 * material-image 占位符契约（ADR-0008 Decision 3，TS/Rust 同构）。
 *
 * 正文里的配图占位符 = 标准 Markdown 图片语法 + 受控 uri scheme：
 * `![alt 文本](material-image://<图片ID>)`。语法与校验用例钉在
 * `materialImagePlaceholderContractCases.json`——TS 侧（本文件消费的
 * 正文解析/审核）与 #15 的 Rust 发布替换侧共同读同一份 JSON，防止两
 * 端对「什么算一个占位符」的认定漂移。
 *
 * 语义纪律：
 * - scheme 只允许出现在上述完整图片语法内；裸文本、普通链接、空 id、
 *   id 含白名单外字符或括号内空白都算文本逃逸，按未解析占位符处理。
 * - 外链（https 等）图片语法不在本契约管辖内，扫描不触碰、替换不动。
 * - 密度上限是配图纪律（内容契约），由确定性审核门执行，不在扫描内。
 */

/** 受控 uri scheme；与 Rust 替换侧共用（契约 JSON 顶部同值钉死）。 */
export const MATERIAL_IMAGE_URI_SCHEME = "material-image://";

/**
 * 配图纪律密度上限（跨进程硬顶）：单篇 material-image 占位符数量的绝对
 * 上限，与 Rust 发布侧常量逐值同步。类型级配额见 articleGeneration.ts
 * 的 ARTICLE_IMAGE_QUOTA_BY_TYPE（用户裁决 2026-08-31：详情/指南 3–8 张、
 * 新闻类 3 张、对比清单 1 张），本常量取各类型配额的最大值。
 */
export const MATERIAL_IMAGE_MAX_PER_ARTICLE = 8;

export interface MaterialImagePlaceholder {
  alt: string;
  imageId: string;
}

export interface MaterialImagePlaceholderScan {
  /** 按出现顺序列出的合法占位符。 */
  placeholders: MaterialImagePlaceholder[];
  /** scheme 出现但不构成合法图片语法占位符的违例描述（中文，供审核门拼装）。 */
  violations: string[];
}

/**
 * 图片 ID 字符集：字母/数字/连字符（覆盖 Rust 侧 UUID 主键形态）。
 * 下划线、空白、括号等一律不认——占位符必须逐字复制候选清单里的 id。
 */
const IMAGE_ID_CHARSET = "[A-Za-z0-9-]+";

const PLACEHOLDER_PATTERN = new RegExp(
  `!\\[([^\\]\\n]*)\\]\\(${MATERIAL_IMAGE_URI_SCHEME}(${IMAGE_ID_CHARSET})\\)`,
  "g",
);

const SCHEME_OCCURRENCE_PATTERN = new RegExp(MATERIAL_IMAGE_URI_SCHEME, "g");

export function scanMaterialImagePlaceholders(
  body: string,
): MaterialImagePlaceholderScan {
  const placeholders: MaterialImagePlaceholder[] = [];
  const covered: Array<[number, number]> = [];
  for (const match of body.matchAll(PLACEHOLDER_PATTERN)) {
    placeholders.push({ alt: match[1], imageId: match[2] });
    const start = match.index ?? 0;
    covered.push([start, start + match[0].length]);
  }
  const violations: string[] = [];
  for (const occurrence of body.matchAll(SCHEME_OCCURRENCE_PATTERN)) {
    const at = occurrence.index ?? 0;
    const insidePlaceholder = covered.some(
      ([start, end]) => at >= start && at < end,
    );
    if (!insidePlaceholder) {
      violations.push(
        `material-image:// 只能以标准 Markdown 图片语法 ![alt 文本](material-image://图片ID) 出现（第 ${at} 字符处出现逃逸用法）`,
      );
    }
  }
  return { placeholders, violations };
}
