/**
 * 合规文案注册表（票 11）：三份公示文件以 `docs/compliance/` 下的 markdown
 * 为唯一权威源，经 Vite `?raw` 在构建期内联为字符串——客户端展示与仓内
 * 文件天然同源，不存在第二份可漂移的文本。价目数字与
 * `backend/src/domain/pricing.ts` 权威值的一致性由
 * `backend/tests/compliance-docs.test.ts` 对表校验兜底。
 */

import agreementDoc from "../../../../docs/compliance/用户协议（2026年正式版）.md?raw";
import pricingDoc from "../../../../docs/compliance/计费标准.md?raw";
import privacyDoc from "../../../../docs/compliance/隐私政策.md?raw";

export type ComplianceDocId =
  | "user-agreement"
  | "privacy-policy"
  | "pricing-standard";

export interface ComplianceDoc {
  id: ComplianceDocId;
  /** 查看器标题与设置页入口文案（法定文件名为中文，不随界面语言改写）。 */
  title: string;
  /** markdown 全文（构建期内联，只读展示）。 */
  content: string;
}

export const COMPLIANCE_DOCS: readonly ComplianceDoc[] = [
  {
    id: "user-agreement",
    title: "用户协议（2026 年正式版）",
    content: agreementDoc,
  },
  { id: "privacy-policy", title: "隐私政策", content: privacyDoc },
  { id: "pricing-standard", title: "计费标准", content: pricingDoc },
];

export function complianceDocById(id: ComplianceDocId): ComplianceDoc {
  const doc = COMPLIANCE_DOCS.find((candidate) => candidate.id === id);
  if (!doc) throw new Error(`Unknown compliance doc: ${id}`);
  return doc;
}
