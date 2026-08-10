'use client';

import { useMemo, useState } from 'react';
import { MemoryGraph } from '@/components/memory/graph';
import { CLASS_LABEL, nodeLabel, type GraphEdge, type GraphNode } from '@/lib/graph-types';
import { cn } from '@/lib/utils';

/** Searchable node list beside the OKF graph diagram. */
export function MemoryBrowser({ nodes, edges }: { nodes: GraphNode[]; edges: GraphEdge[] }) {
  const [q, setQ] = useState('');
  const [selected, setSelected] = useState<string | null>(null);

  const filtered = useMemo(() => {
    const term = q.trim().toLowerCase();
    const list = [...nodes].sort((a, b) => nodeLabel(a).localeCompare(nodeLabel(b)));
    if (!term) return list;
    return list.filter((node) => {
      const label = nodeLabel(node).toLowerCase();
      const cls = String(node.class).toLowerCase();
      return label.includes(term) || cls.includes(term) || node.id.toLowerCase().includes(term);
    });
  }, [nodes, q]);

  return (
    <div className="grid min-h-[20rem] lg:grid-cols-[16rem_1fr]">
      <div className="border-rule flex flex-col border-b lg:border-r lg:border-b-0">
        <div className="border-rule border-b p-3">
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search nodes"
            aria-label="Search graph nodes"
            className="border-rule focus:border-signal placeholder:text-ink-muted w-full rounded-md border bg-transparent px-2.5 py-1.5 font-mono text-[12px] outline-none"
          />
          <p className="text-ink-muted mt-2 font-mono text-[11px]">
            {filtered.length} / {nodes.length}
          </p>
        </div>
        <ul className="max-h-64 overflow-y-auto lg:max-h-[28rem]">
          {filtered.map((node) => {
            const active = selected === node.id;
            return (
              <li key={node.id}>
                <button
                  type="button"
                  onClick={() => setSelected(active ? null : node.id)}
                  className={cn(
                    'w-full cursor-pointer px-3 py-2 text-left transition-colors',
                    active ? 'bg-signal-wash' : 'hover:bg-sunken',
                  )}
                >
                  <span
                    className={cn(
                      'block truncate text-[12px] font-medium',
                      active && 'text-signal',
                    )}
                  >
                    {nodeLabel(node)}
                  </span>
                  <span className="text-ink-muted block truncate text-[10px]">
                    {CLASS_LABEL[String(node.class)] ?? String(node.class)}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      </div>
      <div className="min-w-0 p-3">
        <MemoryGraph
          nodes={nodes}
          edges={edges}
          selected={selected}
          onSelect={setSelected}
        />
      </div>
    </div>
  );
}
