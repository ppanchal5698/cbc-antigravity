import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { extractJson } from './xlsx/coerce';
import { WORKSPACE_ROOT } from './workspace-db';
import type { GraphEdge, GraphNode } from './graph-types';

/**
 * The OKF knowledge graph - CBC's institutional memory.
 *
 * `graph.json` is already `{nodes, edges}`, the canonical graph shape, and no
 * MCP tool returns it, so this reads the file. Every learn path saves to disk
 * immediately, so the file is never behind the server's in-memory copy.
 *
 * Nodes are a discriminated union on `class`, and the shared fields are only
 * `id`, `class` and `confidence` - everything else is class-dependent.
 */

export * from './graph-types';

export type KnowledgeGraph = {
  okfVersion: string;
  title: string;
  lastUpdated: string | null;
  learningCycles: number;
  pricePolicy: string | null;
  marginPolicy: string | null;
  nodes: GraphNode[];
  edges: GraphEdge[];
  byClass: { class: string; count: number }[];
  edgeTypes: { type: string; count: number }[];
  /** Edges whose source or target does not resolve - an OKF invariant breach. */
  danglingEdges: GraphEdge[];
  orphans: number;
};

export async function readKnowledgeGraph(): Promise<KnowledgeGraph | null> {
  const path = join(WORKSPACE_ROOT, 'memory', 'knowledge_graph', 'graph.json');
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch {
    return null;
  }

  // extractJson tolerates trailing junk, which several memory files carry.
  const parsed = extractJson(raw) as {
    okf_version?: string;
    metadata?: Record<string, unknown>;
    nodes?: GraphNode[];
    edges?: GraphEdge[];
  };

  const nodes = Array.isArray(parsed.nodes) ? parsed.nodes : [];
  const edges = Array.isArray(parsed.edges) ? parsed.edges : [];
  const metadata = parsed.metadata ?? {};

  const ids = new Set(nodes.map((node) => node.id));
  const connected = new Set<string>();
  const danglingEdges: GraphEdge[] = [];
  for (const edge of edges) {
    if (!ids.has(edge.source) || !ids.has(edge.target)) {
      danglingEdges.push(edge);
      continue;
    }
    connected.add(edge.source);
    connected.add(edge.target);
  }

  const tally = (values: string[]) => {
    const counts = new Map<string, number>();
    for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
    return [...counts.entries()]
      .map(([key, count]) => ({ key, count }))
      .sort((a, b) => b.count - a.count);
  };

  const asString = (value: unknown) => (typeof value === 'string' ? value : null);
  const asNumber = (value: unknown) => (typeof value === 'number' ? value : 0);

  return {
    okfVersion: parsed.okf_version ?? 'unknown',
    title: asString(metadata.title) ?? 'OKF knowledge graph',
    lastUpdated: asString(metadata.last_updated),
    learningCycles: asNumber(metadata.learning_cycles_completed),
    pricePolicy: asString(metadata.price_policy),
    marginPolicy: asString(metadata.margin_policy),
    nodes,
    edges,
    // Counts come from the arrays. metadata.total_nodes is stale in the file.
    byClass: tally(nodes.map((node) => String(node.class))).map(({ key, count }) => ({
      class: key,
      count,
    })),
    edgeTypes: tally(edges.map((edge) => edge.type)).map(({ key, count }) => ({
      type: key,
      count,
    })),
    danglingEdges,
    orphans: nodes.filter((node) => !connected.has(node.id)).length,
  };
}

export type ActiveProject = {
  projectName: string;
  phaseCompleted: number;
  mode: string | null;
  clientAccount: string | null;
  projectState: string | null;
  salesTaxRate: number;
  lastUpdated: string | null;
  next: string | null;
  doorLines: number;
  accessoryLines: number;
  frpProvisional: boolean;
  unresolvedRfis: string[];
  pendingRfqs: string[];
  pricing: {
    doors: number;
    accessories: number;
    frp: number;
    baseBid: number;
    salesTax: number;
    grandTotal: number;
    /** A string, unlike every sibling: "TBD - excluded at estimate stage". */
    freight: string;
  } | null;
};

/**
 * The job record. The file on disk currently has two stray `}` at EOF and
 * `JSON.parse` throws on it, so this goes through the same tolerant reader.
 */
export async function readActiveProject(): Promise<ActiveProject | null> {
  const path = join(WORKSPACE_ROOT, 'memory', 'active_project.json');
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch {
    return null;
  }

  let parsed: Record<string, unknown>;
  try {
    parsed = extractJson(raw) as Record<string, unknown>;
  } catch {
    return null;
  }

  const str = (value: unknown) => (typeof value === 'string' ? value : null);
  const num = (value: unknown) => (typeof value === 'number' ? value : 0);
  const list = (value: unknown) =>
    Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];

  const schedules = (parsed.extracted_schedules ?? {}) as Record<string, unknown>;
  const frp = (schedules.frp_takeoff ?? {}) as Record<string, unknown>;
  const summary = parsed.pricing_summary as Record<string, unknown> | undefined;

  return {
    projectName: str(parsed.project_name) ?? 'Untitled project',
    phaseCompleted: num(parsed.phase_completed),
    mode: str(parsed.mode),
    clientAccount: str(parsed.client_account),
    projectState: str(parsed.project_state),
    salesTaxRate: num(parsed.sales_tax_rate),
    lastUpdated: str(parsed.last_updated),
    next: str(parsed._next),
    doorLines: Array.isArray(schedules.door_schedule) ? schedules.door_schedule.length : 0,
    accessoryLines: Array.isArray(schedules.accessories) ? schedules.accessories.length : 0,
    frpProvisional: frp.provisional === true,
    unresolvedRfis: list(parsed.unresolved_rfis),
    pendingRfqs: list(parsed.pending_vendor_rfqs),
    pricing: summary
      ? {
          doors: num(summary.doors_subtotal),
          accessories: num(summary.accessories_subtotal),
          frp: num(summary.frp_subtotal),
          baseBid: num(summary.base_bid_subtotal),
          salesTax: num(summary.sales_tax),
          grandTotal: num(summary.grand_total),
          freight: str(summary.freight) ?? 'TBD',
        }
      : null,
  };
}
