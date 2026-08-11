import { readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { WORKSPACE_ROOT } from './workspace-db.ts';

import type { GraphEdge, GraphNode } from './graph-types.ts';

/**
 * These two files are plain JSON and `JSON.parse` reads them.
 *
 * This used to go through `extractJson`, the tolerant reader built for agy's streamed
 * output, on the strength of a comment saying `active_project.json` "currently has two
 * stray `}` at EOF". It does not, and both files parse cleanly. The cost of the workaround
 * was not just a character-by-character scan on every render: `extractJson` returns the
 * LAST balanced span that parses, so a genuinely truncated file would have been read as
 * some earlier fragment and rendered as if it were the whole record. Failing to read a
 * corrupt job record is the correct outcome.
 */
function parseJsonFile(raw: string): Record<string, unknown> | null {
  try {
    const value = JSON.parse(raw) as unknown;
    return value && typeof value === 'object' ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/**
 * Read a memory file, reparsed only when it changes on disk.
 *
 * `workspace-db`'s `memoizeOnIndex` is the same idea for the SQLite indexes, but it is
 * synchronous and these reads are not. Both files are small; what this really buys is that
 * a page rendering several sections does not re-read and re-parse the same graph once per
 * section. Keyed on mtime+size, so a learn pass writing the graph is picked up at once.
 */
const fileMemos = new Map<string, { stamp: string; value: unknown }>();

async function readMemoized<T>(
  path: string,
  parse: (raw: string) => T,
): Promise<T | null> {
  let stamp: string;
  try {
    const info = await stat(path);
    stamp = `${info.mtimeMs}:${info.size}`;
  } catch {
    fileMemos.delete(path);
    return null;
  }

  const hit = fileMemos.get(path);
  if (hit && hit.stamp === stamp) return hit.value as T;

  const value = parse(await readFile(path, 'utf8'));
  fileMemos.set(path, { stamp, value });
  return value;
}

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

export * from './graph-types.ts';

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
  const parsed = (await readMemoized(path, parseJsonFile)) as null | {
    okf_version?: string;
    metadata?: Record<string, unknown>;
    nodes?: GraphNode[];
    edges?: GraphEdge[];
  };
  if (!parsed) return null;

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
  /** What the job record SAYS. Written by the agent, checked by nobody until now. */
  phaseCompleted: number;
  /**
   * Phase 6's exit gate is "subtotals synced, archive written, learning pass run"
   * (`cbc-phase-gates`). Each is an artifact that either exists or does not, so the claim
   * is checkable — and the live record failed it: `phase_completed: 6` with
   * `memory/prior_quotes/` holding nothing but a README and `learning_cycles_completed`
   * at 0. Anything unmet here is listed, and an empty list means the claim stands up.
   */
  gateGapsAtPhase6: string[];
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
 * The job record, plus whether its own phase claim survives contact with the artifacts.
 *
 * (The comment that used to sit here said the file has "two stray `}` at EOF" and throws
 * `JSON.parse`. It does not, and has not for as long as git remembers.)
 */
export async function readActiveProject(): Promise<ActiveProject | null> {
  const path = join(WORKSPACE_ROOT, 'memory', 'active_project.json');
  const parsed = await readMemoized(path, parseJsonFile);
  if (!parsed) return null;

  const str = (value: unknown) => (typeof value === 'string' ? value : null);
  const num = (value: unknown) => (typeof value === 'number' ? value : 0);
  const list = (value: unknown) =>
    Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];

  const schedules = (parsed.extracted_schedules ?? {}) as Record<string, unknown>;
  const frp = (schedules.frp_takeoff ?? {}) as Record<string, unknown>;
  const summary = parsed.pricing_summary as Record<string, unknown> | undefined;

  const phase = num(parsed.phase_completed);
  const gateGapsAtPhase6: string[] = [];
  if (phase >= 6) {
    // Each of these is a Phase 6 exit-gate artifact, and each is a file on disk or a
    // counter in the graph. A number in a JSON file is not evidence that work happened.
    if (!summary) gateGapsAtPhase6.push('no pricing_summary — subtotals were never synced');
    const archived = await readdir(join(WORKSPACE_ROOT, 'memory', 'prior_quotes'))
      .then((names) => names.some((n) => n.endsWith('.json')))
      .catch(() => false);
    if (!archived) {
      gateGapsAtPhase6.push(
        'memory/prior_quotes/ holds no archived quote — the Phase 6 archive step did not run',
      );
    }
    const graph = await readKnowledgeGraph();
    if (graph && graph.learningCycles === 0) {
      gateGapsAtPhase6.push(
        'the OKF graph records 0 learning cycles — okf_learn_from_quote did not run',
      );
    }
  }

  return {
    projectName: str(parsed.project_name) ?? 'Untitled project',
    phaseCompleted: phase,
    gateGapsAtPhase6,
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
