'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { toast } from 'sonner';
import { ScopedChat } from '@/components/chat/scoped-chat';
import { ChromeSetter } from '@/components/shell/chrome-setter';
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

type Filter = 'all' | 'pending' | 'low' | 'manual' | 'rfq';

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

/**
 * Where a number was read. Read-only: it is a record of what happened, not a field to fill
 * in — editing the quantity re-stamps it as `estimator_confirmed` on the server.
 *
 * An unsourced quantity is called out rather than left blank, because blank is what a
 * guess looks like. A quote once carried three invented grab-bar sizes at qty 1 each
 * against a schedule that stated neither, and nothing on the screen said so.
 */
function Provenance({
  label,
  value,
  optional = false,
}: {
  label: string;
  value: string | null;
  optional?: boolean;
}) {
  if (!value && optional) {
    return (
      <span className="text-ink-muted">
        {label}: <span className="italic">n/a</span>
      </span>
    );
  }
  if (!value) {
    return (
      <span className="text-alert font-medium" title="This number has no recorded source.">
        {label}: not sourced
      </span>
    );
  }
  const [kind, ...rest] = value.split(':');
  const detail = rest.join(':');
  return (
    <span className="text-ink-muted">
      {label}: <span className="text-ink font-mono">{kind}</span>
      {detail ? <span className="font-mono"> {detail}</span> : null}
    </span>
  );
}

/** Parsed number, or the value already on the row when the field is empty or garbage. */
function numberOr(text: string, fallback: number): number {
  const parsed = Number(text.replace(/[$,\s]/g, ''));
  return text.trim() !== '' && Number.isFinite(parsed) ? parsed : fallback;
}

const field =
  'border-rule bg-panel w-full rounded-md border px-2 py-1.5 text-[12px] outline-none focus:border-signal disabled:opacity-50';

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

  const [freshBusy, setFreshBusy] = useState(false);
  const [freshness, setFreshness] = useState<{
    status: string;
    usable: boolean;
    guidance: string;
    costDate: string | null;
  } | null>(null);

  const [shownId, setShownId] = useState(line.id);
  if (shownId !== line.id) {
    setShownId(line.id);
    setLocal(toLocal(line));
    setFreshness(null);
  }

  /** NR-2. Asks the engine how old this cost is; never changes the cost itself. */
  const recheckFreshness = async () => {
    if (freshBusy) return;
    setFreshBusy(true);
    try {
      const response = await fetch(`/api/quote-lines/${line.id}/freshness`, { method: 'POST' });
      const body = (await response.json()) as {
        status?: string;
        usable?: boolean;
        guidance?: string;
        costDate?: string | null;
        error?: string;
      };
      setFreshness({
        status: body.status ?? 'unknown',
        usable: body.usable === true,
        guidance: body.error ?? body.guidance ?? '',
        costDate: body.costDate ?? null,
      });
    } catch (err) {
      setFreshness({
        status: 'unknown',
        usable: false,
        guidance: err instanceof Error ? err.message : String(err),
        costDate: null,
      });
    } finally {
      setFreshBusy(false);
    }
  };

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

  const actions = (
    <div className="flex flex-wrap items-center gap-1">
      <button
        type="button"
        disabled={disabled || busy}
        onClick={() => void setAcceptance('accepted')}
        className={cn(
          'status-fade rounded-md px-2.5 py-1 text-[11px] font-medium transition-colors',
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
          'status-fade rounded-md px-2.5 py-1 text-[11px] font-medium transition-colors',
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
  );

  const markers = (
    <div className="flex flex-wrap gap-1">
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
      {line.acceptance === 'pending' ? <Marker tone="muted">Pending</Marker> : null}
    </div>
  );

  return (
    <div
      className={cn(
        'border-rule status-fade border-b last:border-0',
        line.acceptance === 'rejected' && 'bg-alert-wash/40 opacity-75',
        line.acceptance === 'accepted' && 'bg-signal-wash/30',
      )}
    >
      {/* Desktop: multi-column row */}
      <div className="hidden items-start gap-3 px-3 py-3 lg:grid lg:grid-cols-[7rem_1fr_4.5rem_3.5rem_5.5rem_auto_auto]">
        <div>
          <input
            disabled={disabled}
            value={local.tag}
            onChange={(e) => setLocal((s) => ({ ...s, tag: e.target.value }))}
            onBlur={() => void save()}
            className={cn(field, 'font-mono')}
            aria-label="Tag"
          />
          <p className="text-ink-muted mt-1 truncate text-[11px]">{local.room || '—'}</p>
        </div>
        <textarea
          disabled={disabled}
          value={local.description}
          onChange={(e) => setLocal((s) => ({ ...s, description: e.target.value }))}
          onBlur={() => void save()}
          rows={2}
          className={cn(field, 'resize-y')}
          aria-label="Description"
        />
        <input
          disabled={disabled}
          type="text"
          inputMode="decimal"
          value={local.qty}
          onChange={(e) => setLocal((s) => ({ ...s, qty: e.target.value }))}
          onBlur={() => void save()}
          className={cn(field, 'text-right font-mono')}
          aria-label="Qty"
        />
        <input
          disabled={disabled}
          value={local.unit}
          onChange={(e) => setLocal((s) => ({ ...s, unit: e.target.value }))}
          onBlur={() => void save()}
          className={cn(field, 'font-mono')}
          aria-label="Unit"
        />
        <input
          disabled={disabled}
          type="text"
          inputMode="decimal"
          value={local.unit_sale}
          onChange={(e) => setLocal((s) => ({ ...s, unit_sale: e.target.value }))}
          onBlur={() => void save()}
          className={cn(field, 'text-right font-mono')}
          aria-label="Unit sale"
        />
        {markers}
        <div className="justify-self-end">{actions}</div>
      </div>

      {/* Mobile / tablet: stacked fields with sticky action bar */}
      <div className="space-y-3 px-3 py-3 lg:hidden">
        <div className="flex flex-wrap items-start justify-between gap-2">
          {markers}
          <p className="text-ink-muted font-mono text-[11px]">
            Ext {money(numberOr(local.qty, line.qty) * numberOr(local.unit_sale, line.unit_sale))}
          </p>
        </div>
        <label className="block">
          <span className="t-label mb-1 block">Tag</span>
          <input
            disabled={disabled}
            value={local.tag}
            onChange={(e) => setLocal((s) => ({ ...s, tag: e.target.value }))}
            onBlur={() => void save()}
            className={cn(field, 'font-mono')}
          />
        </label>
        <label className="block">
          <span className="t-label mb-1 block">Description</span>
          <textarea
            disabled={disabled}
            value={local.description}
            onChange={(e) => setLocal((s) => ({ ...s, description: e.target.value }))}
            onBlur={() => void save()}
            rows={2}
            className={cn(field, 'resize-y')}
          />
        </label>
        <div className="grid grid-cols-3 gap-2">
          <label className="block">
            <span className="t-label mb-1 block">Qty</span>
            <input
              disabled={disabled}
              type="text"
              inputMode="decimal"
              value={local.qty}
              onChange={(e) => setLocal((s) => ({ ...s, qty: e.target.value }))}
              onBlur={() => void save()}
              className={cn(field, 'text-right font-mono')}
            />
          </label>
          <label className="block">
            <span className="t-label mb-1 block">Unit</span>
            <input
              disabled={disabled}
              value={local.unit}
              onChange={(e) => setLocal((s) => ({ ...s, unit: e.target.value }))}
              onBlur={() => void save()}
              className={cn(field, 'font-mono')}
            />
          </label>
          <label className="block">
            <span className="t-label mb-1 block">Sale</span>
            <input
              disabled={disabled}
              type="text"
              inputMode="decimal"
              value={local.unit_sale}
              onChange={(e) => setLocal((s) => ({ ...s, unit_sale: e.target.value }))}
              onBlur={() => void save()}
              className={cn(field, 'text-right font-mono')}
            />
          </label>
        </div>
        <div className="border-rule bg-panel sticky bottom-0 -mx-3 border-t px-3 py-2">
          {actions}
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
              className={field}
            />
          </label>
          <label className="block text-[11px]">
            <span className="t-label mb-1 block">Cost basis</span>
            <input
              disabled={disabled}
              value={local.cost_basis}
              onChange={(e) => setLocal((s) => ({ ...s, cost_basis: e.target.value }))}
              onBlur={() => void save()}
              className={cn(field, 'font-mono')}
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
              className={field}
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
              className={field}
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
          <div className="sm:col-span-2">
            <span className="t-label mb-1 block">Provenance</span>
            <div className="flex flex-wrap gap-x-6 gap-y-1 text-[11px]">
              <Provenance label="Quantity" value={line.quantity_source} />
              <Provenance label="Size" value={line.size_source} optional />
            </div>
          </div>
          {/* NR-2: "price may be out of date - refresh". The freshness column used to be
              whatever the model asserted; this asks the engine, which is the only thing
              that knows CBC's rule (under a year good, 1-2 review, 2-3 stale, 3+ discard). */}
          <div className="sm:col-span-2">
            <span className="t-label mb-1 block">Cost age</span>
            <div className="flex flex-wrap items-center gap-2 text-[11px]">
              <button
                type="button"
                className="border-line hover:bg-surface-2 rounded border px-2 py-1 disabled:opacity-50"
                disabled={disabled || freshBusy}
                onClick={() => void recheckFreshness()}
              >
                {freshBusy ? 'Checking…' : 'Re-check cost age'}
              </button>
              {freshness ? (
                <span className={freshness.usable ? 'text-ink-muted' : 'text-alert'}>
                  {freshness.costDate ? `${freshness.costDate} · ` : ''}
                  <span className="font-medium">{freshness.status}</span>
                  {' — '}
                  {freshness.guidance}
                </span>
              ) : (
                <span className="text-ink-muted italic">
                  Reads the date out of the cost basis and asks the engine.
                </span>
              )}
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}

export function ReviewWorkspace({
  projectId,
  runId,
  projectName,
  vendorFolders = [],
}: {
  projectId: string;
  runId: string;
  projectName: string;
  vendorFolders?: string[];
}) {
  const [draft, setDraft] = useState<QuoteDraftRow | null>(null);
  const [lines, setLines] = useState<QuoteLineRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [section, setSection] = useState<QuoteSection>('door');
  const [filter, setFilter] = useState<Filter>('all');
  const [approving, setApproving] = useState(false);
  const [addBusy, setAddBusy] = useState(false);

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

  /**
   * `rfq` exists because the shelf genuinely does not carry toilet partitions (10 21 13),
   * lockers (10 51 00) or extinguisher cabinets (10 44 00), while requirements Open Item 7
   * puts them squarely in CBC's scope. Those lines used to reach the estimator as a gap
   * tag with nowhere to put the outside quote when it came back.
   *
   * The defaults matter: cost_source `not_carried` is what the engine's audit recognises
   * for a line that carries no money and says why, and it must stay at 0.00 until a real
   * quote replaces it. Pre-filling `manual_wholesaler_net` would claim a sourcing path
   * that was never taken.
   */
  const addLine = async (kind: 'blank' | 'rfq' = 'blank') => {
    setAddBusy(true);
    try {
      const response = await fetch(`/api/runs/${runId}/quote/lines`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(
          kind === 'rfq'
            ? {
                section,
                description: 'Outside RFQ - not carried on this shelf',
                qty: 1,
                unit_sale: 0,
                cost_basis: 'not_carried',
                citations: '[not carried on shelf - outside RFQ required]',
                pricing_status: 'awaiting_vendor_rfq',
              }
            : { section, description: 'New line', qty: 1, unit_sale: 0 },
        ),
      });
      const body = (await response.json()) as { line?: QuoteLineRow; error?: string };
      if (!response.ok || !body.line) throw new Error(body.error || 'Add failed');
      setLines((prev) => [...prev, body.line!]);
      toast.success(kind === 'rfq' ? 'RFQ line added' : 'Line added');
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
        description: 'Workbook and PDF regenerated from the accepted lines.',
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
      if (filter === 'rfq' && line.pricing_status !== 'awaiting_vendor_rfq') return false;
      return true;
    });
  }, [lines, section, filter]);

  const approved = draft?.status === 'approved';
  const status = (draft?.status ?? 'draft') as DraftStatus;
  const canApprove = !approved && stats.pending === 0;
  const progress =
    stats.total === 0 ? 0 : Math.round(((stats.accepted + stats.rejected) / stats.total) * 100);

  if (loading) {
    return (
      <Page>
        <ChromeSetter title={projectName} status="Loading review…" />
        <PageHeader eyebrow="Quote review" title="Loading…" />
        <p className="text-ink-muted text-[13px]">Loading draft lines…</p>
      </Page>
    );
  }

  if (error || !draft) {
    return (
      <Page>
        <ChromeSetter title={projectName} status="Review unavailable" />
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
      <ChromeSetter
        title={projectName}
        status={approved ? 'Approved' : `${stats.pending} pending · ${progress}% reviewed`}
      />
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
            {/* FR-10: the customer-facing format. Only exists once approved, so it is
                offered only then rather than linking to a 404. */}
            {approved ? (
              <a
                href={`/api/runs/${runId}/download?format=pdf`}
                download
                className="border-rule hover:bg-sunken rounded-md border px-3 py-1.5 text-[12px] font-medium no-underline"
              >
                Download .pdf
              </a>
            ) : null}
            <button
              type="button"
              disabled={!canApprove || approving}
              onClick={() => void approve()}
              title={
                stats.pending > 0
                  ? `Accept or reject ${stats.pending} pending line${stats.pending === 1 ? '' : 's'} first`
                  : undefined
              }
              className="bg-signal text-primary-foreground hover:bg-signal/90 rounded-md px-3 py-1.5 text-[12px] font-medium disabled:opacity-40"
            >
              {approving ? 'Approving…' : approved ? 'Approved' : 'Approve & export'}
            </button>
          </div>
        }
      />

      <p className="text-ink-muted max-w-prose pb-4 text-[13px] leading-relaxed">
        Accept, edit, or reject every line. Nothing is sent externally — approve regenerates the
        CBC workbook and the customer-facing PDF from the accepted lines.
      </p>

      {!approved && stats.pending > 0 ? (
        <div className="border-rule bg-signal-wash/50 mb-4 flex flex-wrap items-center justify-between gap-3 rounded-md border px-4 py-3">
          <div>
            <p className="text-[13px] font-medium text-signal">
              {stats.pending} line{stats.pending === 1 ? '' : 's'} still pending
            </p>
            <p className="text-ink-muted mt-0.5 text-[12px]">
              Review them (or filter to Pending), then Approve unlocks.
            </p>
          </div>
          <button
            type="button"
            onClick={() => setFilter('pending')}
            className="border-signal/40 text-signal hover:bg-panel rounded-md border px-3 py-1.5 text-[12px] font-medium"
          >
            Show pending
          </button>
        </div>
      ) : null}

      {!approved && stats.pending === 0 && stats.total > 0 ? (
        <div className="border-rule bg-panel mb-4 rounded-md border px-4 py-3 text-[13px]">
          All lines decided. Ready to <span className="font-medium">Approve & export</span>.
        </div>
      ) : null}

      <FigureRow>
        <Figure label="Lines" value={count(stats.total)} />
        <Figure label="Accepted" value={count(stats.accepted)} tone="signal" />
        <Figure
          label="Need review"
          value={count(stats.pending + stats.low + stats.manual)}
          tone="alert"
        />
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
              ['rfq', 'Awaiting RFQ'],
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
            onClick={() => void addLine('blank')}
            className="border-rule hover:bg-sunken ml-auto rounded-md border px-3 py-1.5 text-[12px] font-medium disabled:opacity-40"
          >
            {addBusy ? 'Adding…' : 'Add line'}
          </button>
          <button
            type="button"
            disabled={approved || addBusy}
            onClick={() => void addLine('rfq')}
            title="Partitions, lockers and extinguisher cabinets are not on this shelf. This starts a line shaped for the outside quote."
            className="border-rule hover:bg-sunken rounded-md border px-3 py-1.5 text-[12px] font-medium disabled:opacity-40"
          >
            Add RFQ line
          </button>
        </div>

        <div className="panel overflow-hidden">
          {visible.length === 0 ? (
            <div className="p-6">
              <Empty title="No lines in this view." />
            </div>
          ) : (
            <>
              <div className="border-rule text-ink-muted hidden border-b bg-sunken/50 px-3 py-2 text-[11px] font-medium tracking-[0.02em] lg:grid lg:grid-cols-[7rem_1fr_4.5rem_3.5rem_5.5rem_auto_auto] lg:gap-3">
                <span>Tag</span>
                <span>Description</span>
                <span className="text-right">Qty</span>
                <span>Unit</span>
                <span className="text-right">Sale</span>
                <span>Flags</span>
                <span className="text-right">Actions</span>
              </div>
              {visible.map((line) => (
                <LineEditor
                  key={line.id}
                  line={line}
                  disabled={approved}
                  onChange={(patch) => patchLine(line.id, patch)}
                />
              ))}
            </>
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

      <ScopedChat
        scope="project"
        vendorFolders={vendorFolders}
        context={{ projectId, projectName }}
      />
    </Page>
  );
}
