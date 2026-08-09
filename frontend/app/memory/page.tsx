import { CLASS_LABEL, readKnowledgeGraph } from '@/lib/graph';
import { catalogIndexReady, listVendors } from '@/lib/catalog';
import { ScopedChat } from '@/components/chat/scoped-chat';
import { MemoryGraph } from '@/components/memory/graph';
import { Page, PageHeader, HeaderStat, Section } from '@/components/shell/page-header';
import { Figure, FigureRow, count } from '@/components/shell/figure';
import { Empty, Failure } from '@/components/shell/state';

export const dynamic = 'force-dynamic';

export default async function MemoryPage() {
  const graph = await readKnowledgeGraph();
  const vendorFolders = catalogIndexReady()
    ? listVendors().map((vendor) => vendor.folder)
    : [];

  if (!graph) {
    return (
      <Page>
        <PageHeader eyebrow="Institutional memory" title="Memory" />
        <Empty title="No knowledge graph found at memory/knowledge_graph/graph.json." />
      </Page>
    );
  }

  return (
    <Page>
      <PageHeader
        eyebrow="OKF knowledge graph"
        title="Memory"
        meta={
          <>
            <HeaderStat label="Version" value={graph.okfVersion} />
            <HeaderStat
              label="Updated"
              value={graph.lastUpdated ? graph.lastUpdated.slice(0, 10) : '—'}
            />
          </>
        }
      />

      {/* Counts come from the arrays: metadata.total_nodes in the file is stale. */}
      <FigureRow className="mt-2">
        <Figure label="Nodes" value={count(graph.nodes.length)} />
        <Figure label="Edges" value={count(graph.edges.length)} />
        <Figure
          label="Isolated"
          value={count(graph.orphans)}
          note="No relation yet. Earned as quotes and corrections are learned."
          tone="muted"
        />
        <Figure
          label="Learning cycles"
          value={count(graph.learningCycles)}
          tone={graph.learningCycles === 0 ? 'muted' : 'ink'}
        />
      </FigureRow>

      {graph.danglingEdges.length ? (
        <Failure
          className="mt-6"
          title={`${graph.danglingEdges.length} edges point at a node that does not exist.`}
          detail="Every edge must resolve to a node — an OKF invariant. Run okf_graph_status to see the validation errors."
        />
      ) : null}

      <Section label="Graph" panel aside="click a node">
        <div className="p-3">
          <MemoryGraph nodes={graph.nodes} edges={graph.edges} />
        </div>
      </Section>

      <div className="grid gap-4 pt-8 md:grid-cols-2">
        <div className="panel overflow-hidden">
          <h2 className="border-rule border-b px-4 py-2.5 text-[13px] font-semibold">Entity classes</h2>
          <table className="ledger">
            <tbody>
              {graph.byClass.map((entry) => (
                <tr key={entry.class}>
                  <td>{CLASS_LABEL[entry.class] ?? entry.class}</td>
                  <td className="text-ink-muted font-mono text-[11px]">{entry.class}</td>
                  <td className="num">{count(entry.count)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div className="panel overflow-hidden">
          <h2 className="border-rule border-b px-4 py-2.5 text-[13px] font-semibold">Relation types</h2>
          <table className="ledger">
            <tbody>
              {graph.edgeTypes.map((entry) => (
                <tr key={entry.type}>
                  <td className="code">{entry.type}</td>
                  <td className="num">{count(entry.count)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <Section label="Policy" panel className="pt-8">
        <dl className="max-w-prose space-y-3 p-4 text-[13px] leading-relaxed">
          <div>
            <dt className="t-label mb-1">Price</dt>
            <dd className="text-ink-muted">{graph.pricePolicy ?? '—'}</dd>
          </div>
          <div>
            <dt className="t-label mb-1">Margin</dt>
            <dd className="text-ink-muted">{graph.marginPolicy ?? '—'}</dd>
          </div>
        </dl>
      </Section>

      <ScopedChat scope="memory" vendorFolders={vendorFolders} />
    </Page>
  );
}
