export const GEO_BASELINE_POLICY_VERSION = "xiaojing-geo-baseline-v2";
export const GEO_BASELINE_ENGINE_IDS = ["doubao"] as const;

export type GeoBaselineEngineId = (typeof GEO_BASELINE_ENGINE_IDS)[number];
export type GeoBaselineUnitStatus =
  | "pending"
  | "running"
  | "succeeded"
  | "failed";

export interface GeoBaselineProviderSnapshot {
  engineId: GeoBaselineEngineId;
  provider: "volcengine";
  capabilitySlot: "keyword-search";
  model: string;
  endpointFamily: "ark-responses";
  searchMode: "doubao-app-ai-search";
  /** SHA-256 of the Rust-owned service config; never contains the credential. */
  configurationFingerprint: string;
  policyVersion: typeof GEO_BASELINE_POLICY_VERSION;
}

export interface GeoBaselineEngineAvailability {
  id: GeoBaselineEngineId;
  label: string;
  available: boolean;
  unavailableReason?: string;
  snapshot: GeoBaselineProviderSnapshot;
}

export interface GeoProbeCitation {
  url: string;
  title?: string;
  /** 站点名（豆包 url_citation 的 site_name）：渠道显示名优先用它而非裸域名。 */
  siteName?: string;
  provenance: "structured-provider" | "answer-link";
}

export interface GeoProbeAnalysis {
  brandMentioned: boolean;
  brandRecommended: boolean;
  hasCitationEvidence: boolean;
  mentionExcerpt?: string;
  recommendationExcerpt?: string;
  /** Frozen competitor names found verbatim in the answer. */
  competitorMentions?: string[];
  competitorExcerpt?: string;
  /**
   * A negative cue occurred near the exact brand name. Deliberately decoupled
   * from the recommendation verdict: positive and negative cues may coexist.
   */
  suspectedNegative?: boolean;
}

export interface GeoBaselineAttempt {
  attemptNumber: number;
  status: "running" | "succeeded" | "failed";
  startedAt: string;
  finishedAt?: string | null;
  durationMs?: number | null;
  errorCode?: string | null;
  errorMessage?: string | null;
}

export interface GeoBaselineEvidenceUnit {
  id: string;
  questionId: string;
  question: string;
  engineId: GeoBaselineEngineId;
  providerSnapshot: GeoBaselineProviderSnapshot;
  status: GeoBaselineUnitStatus;
  attemptNumber: number;
  rawAnswer?: string | null;
  rawEvidence?: unknown;
  citations: GeoProbeCitation[];
  analysis?: GeoProbeAnalysis | null;
  startedAt?: string | null;
  finishedAt?: string | null;
  durationMs?: number | null;
  errorCode?: string | null;
  errorMessage?: string | null;
  attempts: GeoBaselineAttempt[];
}

export interface GeoBaselineMetrics {
  total: number;
  completed: number;
  succeeded: number;
  failed: number;
  pending: number;
  brandMentioned: number;
  brandRecommended: number;
  withCitationEvidence: number;
  mentionRate: number | null;
  recommendationRate: number | null;
  citationRate: number | null;
  evidenceUnitIds: {
    brandMentioned: string[];
    brandRecommended: string[];
    withCitationEvidence: string[];
    failed: string[];
  };
}

export interface GeoBaselineProjection {
  id: string;
  operationId: string;
  workspaceId: string;
  createdBySessionId: string;
  questionPoolId: string;
  questionPoolRevision: number;
  knowledgeVersion: number;
  /** Frozen exact brand identifiers used by the metric parser. */
  brandNames: string[];
  /** Frozen confirmed competitor names used by the metric parser. */
  competitorNames: string[];
  providerSnapshots: GeoBaselineProviderSnapshot[];
  policyVersion: typeof GEO_BASELINE_POLICY_VERSION;
  status: "running" | "succeeded" | "partial" | "failed";
  metrics: GeoBaselineMetrics;
  units: GeoBaselineEvidenceUnit[];
  createdAt: string;
  updatedAt: string;
}

function validHttpUrl(value: string): string | null {
  try {
    const url = new URL(value.trim());
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    return url.toString();
  } catch {
    return null;
  }
}

function rawAnswerFromProvider(value: unknown): string {
  if (!value || typeof value !== "object") return "";
  const record = value as Record<string, unknown>;
  if (typeof record.output_text === "string" && record.output_text.trim()) {
    return record.output_text.trim();
  }
  const output = Array.isArray(record.output) ? record.output : [];
  const parts: string[] = [];
  for (const item of output) {
    if (!item || typeof item !== "object") continue;
    const holder = item as Record<string, unknown>;
    // ARK `doubao_app` calls carry the answer in typed blocks
    // (`blocks[type=output_text].text`) instead of a `content` array.
    const blocks = Array.isArray(holder.blocks) ? holder.blocks : [];
    for (const block of blocks) {
      if (!block || typeof block !== "object") continue;
      const blockHolder = block as Record<string, unknown>;
      if (
        blockHolder.type === "output_text" &&
        typeof blockHolder.text === "string"
      ) {
        if (blockHolder.text.trim()) parts.push(blockHolder.text.trim());
      }
    }
    const content = holder.content;
    if (typeof content === "string" && content.trim()) parts.push(content);
    if (!Array.isArray(content)) continue;
    for (const part of content) {
      if (typeof part === "string" && part.trim()) parts.push(part);
      if (!part || typeof part !== "object") continue;
      const partHolder = part as Record<string, unknown>;
      for (const key of ["text", "output_text"]) {
        if (typeof partHolder[key] === "string" && partHolder[key].trim()) {
          parts.push(partHolder[key].trim());
        }
      }
    }
  }
  return parts.join("\n").trim();
}

function structuredCitations(value: unknown): GeoProbeCitation[] {
  const citations: GeoProbeCitation[] = [];
  const seen = new Set<string>();
  const visit = (node: unknown): void => {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) {
      node.forEach(visit);
      return;
    }
    const holder = node as Record<string, unknown>;
    let title: string | undefined;
    for (const key of ["title", "name"]) {
      if (typeof holder[key] === "string" && holder[key].trim()) {
        title = holder[key].trim();
        break;
      }
    }
    // site_name 是站点级名称，与文章标题分开保留（渠道显示名优先站点名）。
    let siteName: string | undefined;
    for (const key of ["site_name", "sitename"]) {
      if (typeof holder[key] === "string" && holder[key].trim()) {
        siteName = holder[key].trim();
        break;
      }
    }
    for (const [key, candidate] of Object.entries(holder)) {
      if (
        typeof candidate === "string" &&
        /^(url|link|href|source_url)$/i.test(key)
      ) {
        const url = validHttpUrl(candidate);
        if (url && !seen.has(url)) {
          seen.add(url);
          citations.push({
            url,
            ...(title ? { title } : {}),
            ...(siteName ? { siteName } : {}),
            provenance: "structured-provider",
          });
        }
      }
      visit(candidate);
    }
  };
  visit(value);
  return citations;
}

function answerLinkCitations(
  answer: string,
  alreadySeen: Set<string>,
): GeoProbeCitation[] {
  const citations: GeoProbeCitation[] = [];
  const markdown = /\[([^\]]+)]\((https?:\/\/[^\s)]+)\)/g;
  let match: RegExpExecArray | null;
  while ((match = markdown.exec(answer)) !== null) {
    const url = validHttpUrl(match[2]);
    if (!url || alreadySeen.has(url)) continue;
    alreadySeen.add(url);
    citations.push({
      url,
      title: match[1].trim(),
      provenance: "answer-link",
    });
  }
  const bare = /https?:\/\/[^\s<>"')\]，。；]+/g;
  while ((match = bare.exec(answer)) !== null) {
    const url = validHttpUrl(match[0]);
    if (!url || alreadySeen.has(url)) continue;
    alreadySeen.add(url);
    citations.push({ url, provenance: "answer-link" });
  }
  return citations;
}

/** Parse the real ARK Responses payload without assuming one undocumented block shape. */
export function parseGeoProbeProviderResponse(raw: unknown): {
  answer: string;
  citations: GeoProbeCitation[];
} {
  const answer = rawAnswerFromProvider(raw);
  if (!answer) throw new Error("geo_baseline_empty_response");
  const structured = structuredCitations(raw);
  const seen = new Set(structured.map((citation) => citation.url));
  return {
    answer,
    citations: [...structured, ...answerLinkCitations(answer, seen)],
  };
}

function normalizedBrandNames(values: readonly string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))].sort(
    (left, right) => right.length - left.length,
  );
}

function relevantExcerpt(
  answer: string,
  index: number,
  length: number,
): string {
  const start = Math.max(0, index - 60);
  const end = Math.min(answer.length, index + length + 80);
  return answer.slice(start, end).replace(/\s+/g, " ").trim();
}

/**
 * Derive three independent metrics. Recommendation is deliberately stricter
 * than mention: a recommendation cue must occur near the exact brand name and
 * a nearby negative cue wins.
 */
export function analyzeGeoProbeAnswer(
  answer: string,
  brandNames: readonly string[],
  citations: readonly GeoProbeCitation[],
  competitorNames: readonly string[] = [],
): GeoProbeAnalysis {
  const names = normalizedBrandNames(brandNames);
  let mentionExcerpt: string | undefined;
  let recommendationExcerpt: string | undefined;
  let suspectedNegative = false;
  for (const name of names) {
    let cursor = answer.indexOf(name);
    while (cursor >= 0) {
      const excerpt = relevantExcerpt(answer, cursor, name.length);
      mentionExcerpt ??= excerpt;
      const positive =
        /(推荐|首选|优先选择|值得(?:选择|考虑|信赖)|建议(?:选择|考虑)|榜单|排名|口碑(?:较好|优秀)|靠谱)/.test(
          excerpt,
        );
      const negative =
        /(不推荐|不建议|不值得|避免选择|谨慎选择|风险|投诉|不靠谱)/.test(
          excerpt,
        );
      suspectedNegative ||= negative;
      if (positive && !negative) recommendationExcerpt ??= excerpt;
      cursor = answer.indexOf(name, cursor + name.length);
    }
  }
  const competitorMentions: string[] = [];
  let competitorExcerpt: string | undefined;
  for (const name of normalizedBrandNames(competitorNames)) {
    const index = answer.indexOf(name);
    if (index < 0) continue;
    competitorMentions.push(name);
    competitorExcerpt ??= relevantExcerpt(answer, index, name.length);
  }
  return {
    brandMentioned: mentionExcerpt !== undefined,
    brandRecommended: recommendationExcerpt !== undefined,
    hasCitationEvidence: citations.length > 0,
    ...(mentionExcerpt ? { mentionExcerpt } : {}),
    ...(recommendationExcerpt ? { recommendationExcerpt } : {}),
    ...(competitorMentions.length > 0 ? { competitorMentions } : {}),
    ...(competitorExcerpt ? { competitorExcerpt } : {}),
    ...(suspectedNegative ? { suspectedNegative } : {}),
  };
}

export type GeoQuestionDiagnosis =
  | "suspected-negative"
  | "competitor-dominated"
  | "absent"
  | "low-ranked"
  | "ok";

/**
 * Per-question diagnosis shared by the baseline units and the monitoring
 * probe units. Priority: suspected negative > competitor dominated (brand
 * absent while a competitor is present) > absent > low ranked (mentioned but
 * no explicit TOP 1/2/3) > ok. `rankPosition` left undefined (baseline units
 * carry no rank notion) skips the rank check; an explicit null from a real
 * monitoring probe means "mentioned but not in the top three".
 */
export function classifyGeoQuestionDiagnosis(input: {
  analysis?: Pick<
    GeoProbeAnalysis,
    "brandMentioned" | "suspectedNegative" | "competitorMentions"
  > | null;
  rankPosition?: 1 | 2 | 3 | null;
}): GeoQuestionDiagnosis {
  const analysis = input.analysis ?? undefined;
  if (analysis?.suspectedNegative === true) return "suspected-negative";
  if (analysis?.brandMentioned !== true) {
    return (analysis?.competitorMentions?.length ?? 0) > 0
      ? "competitor-dominated"
      : "absent";
  }
  if (input.rankPosition === null) return "low-ranked";
  return "ok";
}

export function aggregateGeoBaselineUnits(
  units: readonly Pick<GeoBaselineEvidenceUnit, "id" | "status" | "analysis">[],
): GeoBaselineMetrics {
  const succeeded = units.filter((unit) => unit.status === "succeeded");
  const failed = units.filter((unit) => unit.status === "failed");
  const mentioned = succeeded.filter(
    (unit) => unit.analysis?.brandMentioned === true,
  );
  const recommended = succeeded.filter(
    (unit) => unit.analysis?.brandRecommended === true,
  );
  const cited = succeeded.filter(
    (unit) => unit.analysis?.hasCitationEvidence === true,
  );
  const rate = (count: number) =>
    succeeded.length === 0
      ? null
      : Math.round((count / succeeded.length) * 100);
  return {
    total: units.length,
    completed: succeeded.length + failed.length,
    succeeded: succeeded.length,
    failed: failed.length,
    pending: units.length - succeeded.length - failed.length,
    brandMentioned: mentioned.length,
    brandRecommended: recommended.length,
    withCitationEvidence: cited.length,
    mentionRate: rate(mentioned.length),
    recommendationRate: rate(recommended.length),
    citationRate: rate(cited.length),
    evidenceUnitIds: {
      brandMentioned: mentioned.map((unit) => unit.id),
      brandRecommended: recommended.map((unit) => unit.id),
      withCitationEvidence: cited.map((unit) => unit.id),
      failed: failed.map((unit) => unit.id),
    },
  };
}
