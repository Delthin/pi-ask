export const MAX_KNOWLEDGE_DEPTH = 3;

export interface ModelChoice {
  provider: string;
  id: string;
}

export interface AskConfig {
  version: 1;
  directory: string;
  /** null follows the current chat model and reuses its context for organization. */
  model: ModelChoice | null;
  timeoutMs: number;
}

export interface KnowledgeNode {
  id: string;
  kind: "group" | "knowledge";
  parentId: string | null;
  title: string;
  summary: string;
  /** Groups have no card. */
  file: string | null;
  createdAt: string;
  updatedAt: string;
  /** One discussion may contribute to several nodes. Unique within each node. */
  recordIds: string[];
}

/** Undirected semantic relationships, separate from parentId hierarchy. */
export interface KnowledgeEdge {
  source: string;
  target: string;
  relation: string;
  reason: string;
}

export interface ArchivedDiscussion {
  id: string;
  file: string;
  createdAt: string;
  organizer: string;
  nodeIds: string[];
}

export interface KnowledgeIndex {
  version: 2;
  revision: number;
  updatedAt: string;
  nodes: KnowledgeNode[];
  edges: KnowledgeEdge[];
  discussions: ArchivedDiscussion[];
}

/** The ONLY historical knowledge supplied to retrieval and routing calls. */
export type CatalogEntry = Pick<KnowledgeNode, "id" | "title" | "summary" | "kind" | "parentId">;

export interface Draft {
  id: string;
  directory: string;
  question: string;
  startedAt: string;
}

export interface TranscriptMessage {
  role: "user" | "assistant";
  text: string;
  timestamp: number;
  model?: string;
  status?: "error" | "aborted" | "length";
}

export interface OrganizedNote {
  /** Unique within this discussion, not a persisted card ID. */
  id: string;
  title: string;
  summary: string;
  background: string;
  content: string;
  /** Zero-based positions in the frozen discussion transcript. */
  messageIndices: number[];
}

export type NodeRef = `existing:${string}` | `target:${string}` | `group:${string}`;

export interface RoutingTarget {
  key: string;
  /** Every incoming note appears in exactly one target. */
  noteIds: string[];
  matchId: string | null;
  title: string;
  summary: string;
  parent: NodeRef | null;
}

export interface RoutingGroup {
  key: string;
  title: string;
  summary: string;
  parent: NodeRef | null;
}

export interface Routing {
  targets: RoutingTarget[];
  groups: RoutingGroup[];
  relations: { source: NodeRef; target: NodeRef; relation: string; reason: string }[];
}

/** Read-only projection of recognized append-only card batches. Never persisted to index.json. */
export interface CardReading {
  introduction: string;
  records: {
    id: string;
    archivedAt: string;
    organizer: string;
    titles: string[];
    content: string;
    transcript: string;
  }[];
}

export interface GraphData {
  version: 2;
  /** Stable namespace for browser-only layout preferences. */
  libraryId: string;
  generatedAt: string;
  nodes: (Omit<KnowledgeNode, "recordIds"> & {
    entryCount: number;
    /** Empty for grouping nodes. */
    markdown: string;
    /** Absent when the original Markdown cannot be split unambiguously. */
    reading?: CardReading;
  })[];
  edges: KnowledgeEdge[];
}

/** Requests return JSON. No model tool calls are ever executed by this extension. */
export type ModelCall = (system: string, data: unknown) => Promise<unknown>;
