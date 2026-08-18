export interface BrandHistoryReference {
  kind: string;
  id: string;
  revision?: number | null;
}

export interface BrandKnowledgeHistorySource {
  materialId?: string | null;
  excerpt: string;
  origin: string;
  createdAt: string;
}

export interface BrandKnowledgeHistoryFact {
  factKey: string;
  factVersion: number;
  normalizedValueJson: string;
  unit?: string | null;
  sources: BrandKnowledgeHistorySource[];
}

export interface BrandKnowledgeHistoryVersion {
  version: number;
  actorSessionId: string;
  createdAt: string;
  facts: BrandKnowledgeHistoryFact[];
  usedBy: BrandHistoryReference[];
}

export interface BrandArtifactHistoryItem {
  id: string;
  kind: string;
  revision?: number | null;
  knowledgeVersion?: number | null;
  operationId: string;
  sessionId: string;
  status: string;
  sourceRefs: BrandHistoryReference[];
  usedBy: BrandHistoryReference[];
  createdAt: string;
}

export interface BrandHistoryProjection {
  workspaceId: string;
  knowledgeVersions: BrandKnowledgeHistoryVersion[];
  artifacts: BrandArtifactHistoryItem[];
}
