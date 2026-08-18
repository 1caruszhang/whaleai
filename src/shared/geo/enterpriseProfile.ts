/** js_ai dev Enterprise Profile contract, adapted to BrandWorkspace scopes. */
export const ENTERPRISE_PROFILE_FIELDS = [
  'fullName',
  'shortNames',
  'addresses',
  'serviceArea',
  'industry',
  'products',
  'relatedBrands',
  'competitors',
  'targetCustomers',
  'coreAdvantages',
  'trustEndorsements',
  'customerPainPoints',
  'customerCases',
  'contactInfo',
  'derivedKeywords',
] as const;

export type EnterpriseProfileField = (typeof ENTERPRISE_PROFILE_FIELDS)[number];

export const REQUIRED_ENTERPRISE_PROFILE_FIELDS = [
  'fullName',
  'industry',
  'products',
  'coreAdvantages',
] as const satisfies readonly EnterpriseProfileField[];

export type ProfileProvenance = 'extracted' | 'asked' | 'inferred';

export const PROFILE_PROVENANCE_RANK: Readonly<Record<ProfileProvenance, number>> = {
  extracted: 3,
  asked: 2,
  inferred: 1,
};

export type EnterpriseProfileScope =
  | { kind: 'brand' }
  | { kind: 'product-line'; productLine: string };

export function isEnterpriseProfileField(value: string): value is EnterpriseProfileField {
  return (ENTERPRISE_PROFILE_FIELDS as readonly string[]).includes(value);
}

/**
 * 大小写不敏感地归一为规范 camelCase 字段 token。知识 identity 入库时
 * predicate 会被统一小写（knowledge_authority.md 归一化契约），而字段表是
 * camelCase：展示与分组侧必须经此还原，否则 `serviceArea` 类字段会以
 * `enterprise-profile.servicearea` 裸 predicate 形态漏出到 UI。
 */
export function canonicalEnterpriseProfileField(
  value: string,
): EnterpriseProfileField | null {
  const lowered = value.toLocaleLowerCase('zh-CN');
  for (const field of ENTERPRISE_PROFILE_FIELDS) {
    if (field.toLowerCase() === lowered) return field;
  }
  return null;
}
