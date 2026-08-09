'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { toast } from 'sonner';
import { Page, PageHeader, HeaderStat, Section } from '@/components/shell/page-header';
import { Figure, FigureRow, count, money } from '@/components/shell/figure';
import { Empty, Failure, Marker } from '@/components/shell/state';
import { cn } from '@/lib/utils';
import type {
  DraftStatus,
  LineAcceptance,
  QuoteDraftRow,
  QuoteLineRow,
  QuoteSection,
} from '@/lib/quote-draft';

type Filter = 'all' | 'pending' | 'low' | 'manual';

const SECTION_TABS: { id: QuoteSection; label: string }[] = [
  { id: 'door', label: 'Doors' },
  { id: 'accessory', label: 'Accessories' },
  { id: 'frp', label: 'FRP' },
  { id: 'custom', label: 'Custom / Other' },
];

function confidenceTone(c: string | null): 'signal' | 'alert' | 'muted' | 'ink' {
  if (c === 'HIGH') return 'signal';
  if (c === 'LOW') return 'alert';
  if (c === 'MEDIUM') return 'ink';
  return 'muted';
}

/**
 * Editable state for one line. `qty` and `unit_sale` are held as the raw strings the
 * estimator typed, not numbers: running every keystroke through `Number()` meant typing
 * "12." collapsed to "12" before the decimals could be entered, and clearing the field
 * showed 0. They are parsed once, on save.
 */
function toLocal(line: QuoteLineRow) {
  return {
    tag: line.tag,
    room: line.room,
    description: line.description,
    qty: String(line.qty),
    unit: line.unit,
    unit_sale: String(line.unit_sale),
    substitution_notes: line.substitution_notes ?? '',
    cost_basis: line.cost_basis,
    pricing_status: line.pricing_status,
  };
}

/** Parsed number, or the value already on the row when the field is empty or garbage. */
function numberOr(text: string, fallback: number): number {
  const parsed = Number(text.replace(/[$,\s]/g, ''));
  return text.trim() !== '' && Number.isFinite(parsed) ? parsed : fallback;
}

function LineEditor({
  line,
  disabled,
  onChange,
}: {
  line: QuoteLineRow;
  disabled: boolean;
  onChange: (patch: Record<string, unknown>) => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [local, setLocal] = useState(() => toLocal(line));

  // Reset only when this editor is showing a genuinely different row. Keying the reset
  // on the whole `line` object meant every save - which replaces the object - wiped
  // whatever the estimator had started typing in another field. Adjusting state during
  // render is React's documented alternative to a setState-in-effect.
  const [shownId, setShownId] = useState(line.id);
  if (shownId !== line.id) {
    setShownId(line.id);
    setLocal(toLocal(line));
  }

  const save = async (extra?: Record<string, unknown>) => {
    if (disabled || busy) return;
    setBusy(true);
    try {
      await onChange({
        tag: local.tag,
        room: local.room,
        description: local.description,
        qty: numberOr(local.qty, line.qty),
        unit: local.unit,
        unit_sale: numberOr(local.unit_sale, line.unit_sale),
        substitution_notes: local.substitution_notes || null,
        cost_basis: local.cost_basis,
        pricing_status: local.pricing_status,
        ...extra,
      });
    } finally {
      setBusy(false);
    }
  };

  const setAcceptance = async (acceptance: LineAcceptance) => {
    setBusy(true);
    try {
      await onChange({ acceptance });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      className={cn(
        'border-rule border-b last:border-0',
        line.acceptance === 'rejected' && 'bg-alert-wash/40 opacity-75',
        line.acceptance === 'accepted' && 'bg-signal-wash/30',
      )}
    >
      <div className="grid grid-cols-12 items-start gap-2 px-3 py-2.5 text-[13px]">
        <div className="col-span-12 sm:col-span-2">
          <input
            disabled={disabled}
            value={local.tag}
            onChange={(e) => setLocal((s) => ({ ...s, tag: e.target.value }))}
            onBlur={() => void save()}
            className="border-rule bg-panel w-full rounded-md border px-2 py-1 font-mono text-[12px]"
            aria-label="Tag"
          />
          <p className="text-ink-muted mt-1 truncate text-[11px]">{local.room || '—'}</p>
        </div>
        <div className="col-span-12 sm:col-span-4">
          <textarea
            disabled={disabled}
            value={local.description}
            onChange={(e) => setLocal((s) => ({ ...s, description: e.target.value }))}
            onBlur={() => void save()}
            rows={2}
            className="border-rule bg-panel w-full resize-y rounded-md border px-2 py-1 text-[12px]"
            aria-label="Description"
          />
        </div>
        <div className="col-span-4 sm:col-span-1">
          <input
            disabled={disabled}
            type="text"
            inputMode="decimal"
            value={local.qty}
            onChange={(e) => setLocal((s) => ({ ...s, qty: e.target.value }))}
            onBlur={() => void save()}
            className="border-rule bg-panel w-full rounded-md border px-2 py-1 text-right font-mono text-[12px]"
            aria-label="Qty"
          />
        </div>
        <div className="col-span-4 sm:col-span-1">
          <input
            disabled={disabled}
            value={local.unit}
            onChange={(e) => setLocal((s) => ({ ...s, unit: e.target.value }))}
            onBlur={() => void save()}
            className="border-rule bg-panel w-full rounded-md border px-2 py-1 font-mono text-[12px]"
            aria-label="Unit"
          />
        </div>
        <div className="col-span-4 sm:col-span-1">
          <input
            disabled={disabled}
            type="text"
            inputMode="decimal"
            value={local.unit_sale}
            onChange={(e) => setLocal((s) => ({ ...s, unit_sale: e.target.value }))}
            onBlur={() => void save()}
            className="border-rule bg-panel w-full rounded-md border px-2 py-1 text-right font-mono text-[12px]"
            aria-label="Unit sale"
          />
        </div>
        <div className="col-span-6 flex flex-wrap gap-1 sm:col-span-1">
          {line.confidence ? (
            <Marker tone={confidenceTone(line.confidence)}>{line.confidence}</Marker>
          ) : (
            <Marker>—</Marker>
          )}
          {line.pricing_status !== 'priced' ? (
            <Marker tone="alert">
              {line.pricing_status === 'manual_entry_required' ? 'Manual $' : 'RFQ'}
            </Marker>
          ) : null}
          {line.price_freshness === 'stale' || line.price_freshness === 'review' ? (
            <Marker tone="alert">{line.price_freshness}</Marker>
          ) : null}
        </div>
        <div className="col-span-6 flex flex-wrap items-center justify-end gap-1 sm:col-span-2">
          <button
            type="button"
            disabled={disabled || busy}
            onClick={() => void setAcceptance('accepted')}
            className={cn(
              'rounded-md px-2 py-1 text-[11px] font-medium',
              line.acceptance === 'accepted'
                ? 'bg-signal text-primary-foreground'
                : 'border-rule hover:bg-sunken border',
            )}
          >
            Accept
          </button>
          <button
            type="button"
            disabled={disabled || busy}
            onClick={() => void setAcceptance('rejected')}
            className={cn(
              'rounded-md px-2 py-1 text-[11px] font-medium',
              line.acceptance === 'rejected'
                ? 'bg-alert text-white'
                : 'border-rule hover:bg-sunken border',
            )}
          >
            Reject
          </button>
          <button
            type="button"
            disabled={disabled || busy}
            onClick={() => setOpen((o) => !o)}
            className="border-rule hover:bg-sunken rounded-md border px-2 py-1 text-[11px]"
          >
            {open ? 'Less' : 'More'}
          </button>
          <button
            type="button"
            disabled={disabled || busy}
            onClick={() => void onChange({ deleted: true })}
            className="text-alert hover:bg-alert-wash rounded-md px-2 py-1 text-[11px]"
          >
            Delete
          </button>
        </div>
      </div>

      {open ? (
        <div className="bg-sunken/50 grid gap-3 border-t border-rule px-3 py-3 sm:grid-cols-2">
          <label className="block text-[11px]">
            <span className="t-label mb-1 block">Room / section</span>
            <input
              disabled={disabled}
              value={local.room}
              onChange={(e) => setLocal((s) => ({ ...s, room: e.target.value }))}
              onBlur={() => void save()}
              className="border-rule bg-panel w-full rounded-md border px-2 py-1.5 text-[12px]"
            />
          </label>
          <label className="block text-[11px]">
            <span className="t-label mb-1 block">Cost basis</span>
            <input
              disabled={disabled}
              value={local.cost_basis}
              onChange={(e) => setLocal((s) => ({ ...s, cost_basis: e.target.value }))}
              onBlur={() => void save()}
              className="border-rule bg-panel w-full rounded-md border px-2 py-1.5 font-mono text-[12px]"
            />
          </label>
          <label className="block text-[11px] sm:col-span-2">
            <span className="t-label mb-1 block">Substitution notes</span>
            <textarea
              disabled={disabled}
              value={local.substitution_notes}
              onChange={(e) => setLocal((s) => ({ ...s, substitution_notes: e.target.value }))}
              onBlur={() => void save()}
              rows={2}
              className="border-rule bg-panel w-full rounded-md border px-2 py-1.5 text-[12px]"
            />
          </label>
          <label className="block text-[11px]">
            <span className="t-label mb-1 block">Pricing status</span>
            <select
              disabled={disabled}
              value={local.pricing_status}
              onChange={(e) => {
                const pricing_status = e.target.value as QuoteLineRow['pricing_status'];
                setLocal((s) => ({ ...s, pricing_status }));
                void onChange({ pricing_status });
              }}
              className="border-rule bg-panel w-full rounded-md border px-2 py-1.5 text-[12px]"
            >
              <option value="priced">Priced</option>
              <option value="manual_entry_required">Manual price entry</option>
              <option value="awaiting_vendor_rfq">Awaiting vendor RFQ</option>
            </select>
          </label>
          <p className="text-ink-muted self-end text-[11px] leading-snug">
            Citations: <span className="font-mono">{line.citations}</span>
            {line.unit_cost != null ? ` · Cost ${money(line.unit_cost)}` : ''}
            {line.margin_rate != null ? ` · Margin ${(line.margin_rate * 100).toFixed(1)}%` : ''}
          </p>
        </div>
      ) : null}
    </div>
  );
}

export function ReviewWorkspace({
  projectId,
  runId,
  projectName,
}: {
  projectId: string;
  runId: string;
  projectName: string;
}) {
  const [draft, setDraft] = useState<QuoteDraftRow | null>(null);
  const [lines, setLines] = useState<QuoteLineRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [section, setSection] = useState<QuoteSection>('door');
  const [filter, setFilter] = useState<Filter>('all');
  const [approving, setApproving] = useState(false);
  const [addBusy, setAddBusy] = useState(false);

  // No synchronous state update: `loading` starts true and everything else happens once
  // the response lands, so the effect below only starts work rather than cascading a
  // render out of it.
  const load = useCallback(async (signal?: AbortSignal) => {
    try {
      const response = await fetch(`/api/runs/${runId}/quote`, { signal });
      const body = (await response.json()) as {
        draft?: QuoteDraftRow;
        lines?: QuoteLineRow[];
        error?: string;
      };
      if (!response.ok) throw new Error(body.error || 'Could not load quote');
      setDraft(body.draft ?? null);
      setLines(body.lines ?? []);
    } catch (err) {
      if (signal?.aborted) return;
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      if (!signal?.aborted) setLoading(false);
    }
  }, [runId]);

  useEffect(() => {
    const controller = new AbortController();
    // `load` sets state only after awaiting the response - the "call setState from a
    // callback when the external system reports back" case the rule allows. The
    // analyzer cannot see past the await into the async function; the abort on cleanup
    // is what makes it safe.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load(controller.signal);
    return () => controller.abort();
  }, [load]);

  const patchLine = async (lineId: string, patch: Record<string, unknown>) => {
    const response = await fetch(`/api/quote-lines/${lineId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch),
    });
    const body = (await response.json()) as { line?: QuoteLineRow; error?: string };
    if (!response.ok || !body.line) {
      toast.error('Could not update line', { description: body.error });
      return;
    }
    if (patch.deleted) {
      setLines((prev) => prev.filter((l) => l.id !== lineId));
    } else {
      setLines((prev) => prev.map((l) => (l.id === lineId ? body.line! : l)));
    }
  };

  const addLine = async () => {
    setAddBusy(true);
    try {
      const response = await fetch(`/api/runs/${runId}/quote/lines`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          section,
          description: 'New line',
          qty: 1,
          unit_sale: 0,
        }),
      });
      const body = (await response.json()) as { line?: QuoteLineRow; error?: string };
      if (!response.ok || !body.line) throw new Error(body.error || 'Add failed');
      setLines((prev) => [...prev, body.line!]);
      toast.success('Line added');
    } catch (err) {
      toast.error('Could not add line', {
        description: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setAddBusy(false);
    }
  };

  const approve = async () => {
    setApproving(true);
    try {
      const response = await fetch(`/api/runs/${runId}/quote/approve`, { method: 'POST' });
      const body = (await response.json()) as {
        draft?: QuoteDraftRow;
        downloadUrl?: string;
        error?: string;
      };
      if (!response.ok) throw new Error(body.error || 'Approve failed');
      if (body.draft) setDraft(body.draft);
      toast.success('Draft approved', {
        description: 'Workbook regenerated. Download when ready.',
        action: body.downloadUrl
          ? {
              label: 'Download',
              onClick: () => {
                window.location.href = body.downloadUrl!;
              },
            }
          : undefined,
      });
    } catch (err) {
      toast.error('Could not approve', {
        description: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setApproving(false);
    }
  };

  const stats = useMemo(() => {
    const active = lines;
    return {
      total: active.length,
      pending: active.filter((l) => l.acceptance === 'pending').length,
      accepted: active.filter((l) => l.acceptance === 'accepted').length,
      rejected: active.filter((l) => l.acceptance === 'rejected').length,
      low: active.filter((l) => l.confidence === 'LOW').length,
      manual: active.filter((l) => l.pricing_status !== 'priced').length,
      ext: active
        .filter((l) => l.acceptance !== 'rejected')
        .reduce((sum, l) => sum + l.qty * l.unit_sale, 0),
    };
  }, [lines]);

  const visible = useMemo(() => {
    return lines.filter((line) => {
      if (line.section !== section) return false;
      if (filter === 'pending' && line.acceptance !== 'pending') return false;
      if (filter === 'low' && line.confidence !== 'LOW') return false;
      if (filter === 'manual' && line.pricing_status === 'priced') return false;
      return true;
    });
  }, [lines, section, filter]);

  const approved = draft?.status === 'approved';
  const status = (draft?.status ?? 'draft') as DraftStatus;

  if (loading) {
    return (
      <Page>
        <PageHeader eyebrow="Quote review" title="Loading…" />
        <p className="text-ink-muted text-[13px]">Loading draft lines…</p>
      </Page>
    );
  }

  if (error || !draft) {
    return (
      <Page>
        <PageHeader
          eyebrow={
            <Link href={`/projects/${projectId}`} className="hover:text-ink transition-colors">
              {projectName}
            </Link>
          }
          title="Quote review"
        />
        <Failure title="Could not open the draft." detail={error ?? 'Missing draft'} />
      </Page>
    );
  }

  return (
    <Page>
      <PageHeader
        eyebrow={
          <Link href={`/projects/${projectId}`} className="hover:text-ink transition-colors">
            {projectName}
          </Link>
        }
        title="Quote review"
        meta={
          <>
            <HeaderStat label="Status" value={status} />
            <HeaderStat label="Pending" value={count(stats.pending)} />
          </>
        }
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <a
              href={`/api/runs/${runId}/download`}
              download
              className="border-rule hover:bg-sunken rounded-md border px-3 py-1.5 text-[12px] font-medium no-underline"
            >
              Download .xlsx
            </a>
            <button
              type="button"
              disabled={approved || approving || stats.pending > 0}
              onClick={() => void approve()}
              className="bg-signal text-primary-foreground hover:bg-signal/90 rounded-md px-3 py-1.5 text-[12px] font-medium disabled:opacity-40"
            >
              {approving ? 'Approving…' : approved ? 'Approved' : 'Approve & export'}
            </button>
          </div>
        }
      />

      <p className="text-ink-muted max-w-prose pb-4 text-[13px] leading-relaxed">
        Accept, edit, or reject every line. Nothing is sent externally — approve regenerates the
        CBC workbook for download.
      </p>

      <FigureRow>
        <Figure label="Lines" value={count(stats.total)} />
        <Figure label="Accepted" value={count(stats.accepted)} tone="signal" />
        <Figure label="Need review" value={count(stats.pending + stats.low + stats.manual)} tone="alert" />
        <Figure label="Ext. sale (active)" value={money(stats.ext)} />
      </FigureRow>

      <Section label="Lines" className="pt-6">
        <div className="mb-3 flex flex-wrap items-center gap-2">
          {SECTION_TABS.map((tab) => {
            const n = lines.filter((l) => l.section === tab.id).length;
            return (
              <button
                key={tab.id}
                type="button"
                onClick={() => setSection(tab.id)}
                className={cn(
                  'rounded-md px-3 py-1.5 text-[12px] font-medium transition-colors',
                  section === tab.id
                    ? 'bg-signal-wash text-signal'
                    : 'border-rule text-ink-muted hover:bg-sunken border',
                )}
              >
                {tab.label}
                <span className="ml-1.5 font-mono text-[11px] opacity-70">{n}</span>
              </button>
            );
          })}
          <span className="bg-rule mx-1 hidden h-4 w-px sm:block" aria-hidden />
          {(
            [
              ['all', 'All'],
              ['pending', 'Pending'],
              ['low', 'Low confidence'],
              ['manual', 'Manual / RFQ'],
            ] as const
          ).map(([id, label]) => (
            <button
              key={id}
              type="button"
              onClick={() => setFilter(id)}
              className={cn(
                'rounded-md px-2.5 py-1 text-[11px]',
                filter === id ? 'bg-sunken text-ink font-medium' : 'text-ink-muted',
              )}
            >
              {label}
            </button>
          ))}
          <button
            type="button"
            disabled={approved || addBusy}
            onClick={() => void addLine()}
            className="border-rule hover:bg-sunken ml-auto rounded-md border px-3 py-1.5 text-[12px] font-medium disabled:opacity-40"
          >
            {addBusy ? 'Adding…' : 'Add line'}
          </button>
        </div>

        <div className="panel overflow-hidden">
          {visible.length === 0 ? (
            <div className="p-6">
              <Empty title="No lines in this view." />
            </div>
          ) : (
            visible.map((line) => (
              <LineEditor
                key={line.id}
                line={line}
                disabled={approved}
                onChange={(patch) => patchLine(line.id, patch)}
              />
            ))
          )}
        </div>
      </Section>

      {draft.header.rfis?.length ? (
        <Section label="RFI register" panel className="pt-6">
          <ul className="space-y-2 p-4">
            {draft.header.rfis.map((rfi) => (
              <li key={rfi} className="border-rule/70 border-b pb-2 text-[13px] last:border-0">
                {rfi}
              </li>
            ))}
          </ul>
        </Section>
      ) : null}
    </Page>
  );
}
