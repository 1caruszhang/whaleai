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
