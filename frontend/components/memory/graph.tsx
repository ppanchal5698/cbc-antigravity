'use client';

import { useMemo, useState } from 'react';
import { CLASS_LABEL, nodeLabel, type GraphEdge, type GraphNode } from '@/lib/graph-types';
import { cn } from '@/lib/utils';

/**
 * The OKF graph as a typed diagram.
 *
 * Hand-rolled SVG, no library. Nodes sit in deterministic columns by entity
 * class rather than in a force simulation: roughly half of them are isolated,
 * and a simulation flings orphans into the corners while a column layout seats
 * them exactly where their class says they belong. Deterministic also means the
 * diagram looks the same every visit, which matters when people are learning it.
 */

const COLUMN_ORDER = [
  'BrandAccount',
  'WallTypeMapping',
  'HardwareSetTemplate',
  'CatalogProduct',
  'VendorEquivalence',
  'UncarriedDivisionPattern',
  'EstimatorCorrectionPattern',
];

const COLUMN_WIDTH = 232;
const ROW_HEIGHT = 30;
const NODE_WIDTH = 196;
const NODE_HEIGHT = 22;
const HEADER = 44;
const PADDING = 16;

type Placed = { node: GraphNode; x: number; y: number; column: number };

export function MemoryGraph({ nodes, edges }: { nodes: GraphNode[]; edges: GraphEdge[] }) {
  const [selected, setSelected] = useState<string | null>(null);

  const { placed, byId, width, height, columns } = useMemo(() => {
    const classes = COLUMN_ORDER.filter((cls) => nodes.some((node) => node.class === cls));
    for (const node of nodes) {
      if (!classes.includes(String(node.class))) classes.push(String(node.class));
    }

    const placed: Placed[] = [];
    const perColumn: number[] = [];

    classes.forEach((cls, column) => {
      const members = nodes
        .filter((node) => node.class === cls)
        .sort((a, b) => nodeLabel(a).localeCompare(nodeLabel(b)));
      perColumn[column] = members.length;
      members.forEach((node, row) => {
        placed.push({
          node,
          x: PADDING + column * COLUMN_WIDTH,
          y: HEADER + row * ROW_HEIGHT,
          column,
        });
      });
    });

    const byId = new Map(placed.map((entry) => [entry.node.id, entry]));
    const tallest = Math.max(...perColumn, 1);

    return {
      placed,
      byId,
      columns: classes,
      width: PADDING * 2 + classes.length * COLUMN_WIDTH,
      height: HEADER + tallest * ROW_HEIGHT + PADDING,
    };
  }, [nodes]);

  const connected = useMemo(() => {
    if (!selected) return null;
    const ids = new Set<string>([selected]);
    for (const edge of edges) {
      if (edge.source === selected) ids.add(edge.target);
      if (edge.target === selected) ids.add(edge.source);
    }
    return ids;
  }, [selected, edges]);

  const visibleEdges = edges.filter((edge) => byId.has(edge.source) && byId.has(edge.target));

  const selectedDegree = selected
    ? edges.filter((edge) => edge.source === selected || edge.target === selected).length
    : 0;

  return (
    <div className="scroll-x">
      {selected && selectedDegree === 0 ? (
        <p className="border-rule text-ink-muted mb-3 border-b pb-2 text-[12px]">
          No linked nodes yet — this node is isolated until quotes or corrections add relations.
        </p>
      ) : null}
      <svg
        viewBox={`0 0 ${width} ${height}`}
        width={width}
        height={height}
        role="img"
        aria-label={`Knowledge graph: ${nodes.length} nodes, ${edges.length} edges`}
        className="max-w-none"
      >
        {columns.map((cls, column) => (
          <text
            key={cls}
            x={PADDING + column * COLUMN_WIDTH}
            y={18}
            className="fill-ink-muted font-sans text-[10px] font-semibold tracking-[0.08em] uppercase"
          >
            {CLASS_LABEL[cls] ?? cls}
          </text>
        ))}

        {visibleEdges.map((edge, i) => {
          const from = byId.get(edge.source)!;
          const to = byId.get(edge.target)!;
          const x1 = from.x + NODE_WIDTH;
          const y1 = from.y + NODE_HEIGHT / 2;
          const x2 = to.x;
          const y2 = to.y + NODE_HEIGHT / 2;
          const mid = (x1 + x2) / 2;
          const related =
            !connected || connected.has(edge.source) || connected.has(edge.target);
          const highlighted =
            Boolean(selected) &&
            (edge.source === selected || edge.target === selected);
          return (
            <path
              key={`${edge.source}-${edge.target}-${i}`}
              d={`M ${x1} ${y1} C ${mid} ${y1}, ${mid} ${y2}, ${x2} ${y2}`}
              fill="none"
              className={cn(
                'stroke-signal',
                highlighted ? 'opacity-100' : related ? 'opacity-40' : 'opacity-5',
              )}
              strokeWidth={highlighted ? 2.5 : 1}
            />
          );
        })}

        {placed.map(({ node, x, y }) => {
          const active = !connected || connected.has(node.id);
          const isSelected = selected === node.id;
          return (
            <g
              key={node.id}
              transform={`translate(${x}, ${y})`}
              onClick={() => setSelected(isSelected ? null : node.id)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' || event.key === ' ') {
                  event.preventDefault();
                  setSelected(isSelected ? null : node.id);
                }
              }}
              tabIndex={0}
              role="button"
              aria-pressed={isSelected}
              aria-label={`${nodeLabel(node)}, ${node.class}`}
              className={cn('cursor-pointer outline-none', !active && 'opacity-25')}
            >
              <rect
                width={NODE_WIDTH}
                height={NODE_HEIGHT}
                className={cn(
                  'stroke-rule-strong',
                  isSelected ? 'fill-signal stroke-signal' : 'fill-paper',
                )}
                strokeWidth={1}
              />
              <text
                x={7}
                y={NODE_HEIGHT / 2 + 3.5}
                className={cn(
                  'pointer-events-none font-mono text-[10px]',
                  isSelected ? 'fill-paper' : 'fill-ink',
                )}
              >
                {truncate(nodeLabel(node), 30)}
              </text>
            </g>
          );
        })}
      </svg>

      {selected ? (
        <NodeDetail
          node={nodes.find((node) => node.id === selected)!}
          edges={edges.filter((edge) => edge.source === selected || edge.target === selected)}
          nodes={nodes}
          onClose={() => setSelected(null)}
        />
      ) : (
        <p className="text-ink-muted mt-4 text-[12px]">
          Select a node to see its fields and every relation it takes part in.
        </p>
      )}
    </div>
  );
}

function truncate(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

const HIDDEN_FIELDS = new Set(['id', 'class']);

function NodeDetail({
  node,
  edges,
  nodes,
  onClose,
}: {
  node: GraphNode;
  edges: GraphEdge[];
  nodes: GraphNode[];
  onClose: () => void;
}) {
  const label = (id: string) => {
    const match = nodes.find((candidate) => candidate.id === id);
    return match ? nodeLabel(match) : id;
  };

  return (
    <div className="border-signal mt-6 border-l-2 pl-4">
      <div className="mb-3 flex items-baseline justify-between gap-4">
        <div>
          <p className="t-label mb-1">{CLASS_LABEL[String(node.class)] ?? String(node.class)}</p>
          <p className="text-[15px] font-medium">{nodeLabel(node)}</p>
          <p className="text-ink-muted font-mono text-[11px]">{node.id}</p>
        </div>
        <button
          type="button"
          onClick={onClose}
          className="t-label hover:text-ink cursor-pointer transition-colors"
        >
          Close
        </button>
      </div>

      <div className="grid gap-6 md:grid-cols-2">
        <div>
          <p className="t-label border-rule mb-2 border-b pb-1">Fields</p>
          <dl className="space-y-1">
            {Object.entries(node)
              .filter(([key]) => !HIDDEN_FIELDS.has(key))
              .map(([key, value]) => (
                <div key={key} className="flex gap-3 text-[12px]">
                  <dt className="text-ink-muted w-40 shrink-0 font-mono">{key}</dt>
                  <dd className="min-w-0 break-words">
                    {value === null ? (
                      <span className="text-alert font-mono">null</span>
                    ) : typeof value === 'object' ? (
                      <span className="font-mono">{JSON.stringify(value)}</span>
                    ) : (
                      String(value)
                    )}
                  </dd>
                </div>
              ))}
          </dl>
          {/* An OKF invariant: a node never carries a price. */}
          <p className="text-ink-muted mt-3 text-[11px]">
            The graph records which product, never what it costs.
          </p>
        </div>

        <div>
          <p className="t-label border-rule mb-2 border-b pb-1">
            Relations
            <span className="text-rule-strong ml-2 font-mono normal-case">{edges.length}</span>
          </p>
          {edges.length ? (
            <ul className="space-y-1.5">
              {edges.map((edge, i) => (
                <li key={i} className="text-[12px]">
                  <span className="text-signal font-mono text-[11px]">{edge.type}</span>{' '}
                  {edge.source === node.id ? '→ ' : '← '}
                  {label(edge.source === node.id ? edge.target : edge.source)}
                  {typeof edge.quantity === 'number' ? (
                    <span className="text-ink-muted font-mono"> ×{edge.quantity}</span>
                  ) : null}
                  {edge.sizing_rule ? (
                    <span className="text-ink-muted"> · {String(edge.sizing_rule)}</span>
                  ) : null}
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-ink-muted text-[12px]">
              Isolated. Nothing points at this node yet — it earns edges as quotes and corrections
              are learned.
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
