/**
 * Watches an inbox and turns a mailed bid set into a running estimate.
 *
 * Modelled on `startWorker()` - idempotent, unref'd, first tick immediate, every await
 * wrapped so a bad cycle logs and the loop survives - with one deliberate difference. The
 * worker can tolerate `setInterval` re-entering `tick` mid-await because its claim is a
 * single atomic `FOR UPDATE SKIP LOCKED`. An IMAP fetch has no such protection, so this
 * reschedules itself with `setTimeout` after each cycle finishes instead.
 *
 * The mailbox is READ-ONLY to this poller. Progress is a UID high-water mark in
 * `mail_cursor`, not a `\Seen` flag: flagging works fine on a mailbox that exists only for
 * this, and silently marks a person's real mail as read anywhere else. The first run seeds
 * the cursor at the current end of the mailbox, so switching the feature on never reaches
 * backwards into mail that was already there.
 *
 * Ordering is chosen so that a crash loses nothing: the cursor advances only after the
 * project, the file and the run row have committed. A crash before that re-reads the same
 * uid, and the `email_intake` claim makes the retry a no-op rather than a second project.
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { attachFile, createProjectDeduped } from '../lib/intake.ts';
import { query } from '../lib/db.ts';
import {
  checkAttachment,
  checkPlanSet,
  parseAddress,
  screenMessage,
  type IntakeRejection,
} from './mail-intake-gate.ts';

const POLL_MS = Number(process.env.INTAKE_POLL_MS || 60_000);
const MAILBOX = process.env.IMAP_MAILBOX || 'INBOX';
const MAX_PER_CYCLE = Number(process.env.INTAKE_MAX_PER_CYCLE || 5);

/** Off unless explicitly switched on, so pulling the branch does not start polling. */
export function intakeEnabled(): boolean {
  const flag = (process.env.INTAKE_ENABLED || '').toLowerCase();
  return flag === '1' || flag === 'true' || flag === 'yes';
}

/**
 * A subject is a display label and nothing more. It is attacker-controlled text, so it is
 * stripped to printable characters and length-capped before it is allowed to be a project
 * name - and it never goes anywhere near a prompt.
 */
export function projectNameFromSubject(subject: string | null | undefined, fallback: string): string {
  const cleaned = (subject ?? '')
    // Control characters, including the newlines that would let a subject forge extra
    // lines wherever the name is later logged or displayed.
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/^\s*(re|fwd?)\s*:\s*/gi, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 100);
  return cleaned || fallback;
}

async function record(
  messageId: string,
  outcome: IntakeRejection | 'accepted' | 'error',
  detail: string,
  projectId?: string,
): Promise<void> {
  // Upsert, not update. The IMAP loop claims the row before calling in here, but a caller
  // that has not - a fixture replay, a future re-ingest path - must still leave a record.
  // An UPDATE matching nothing is exactly the kind of silent gap this table exists to close.
  await query(
    `INSERT INTO email_intake (message_id, sender, subject, outcome, detail, project_id)
     VALUES ($1, '', NULL, $2, $3, $4)
     ON CONFLICT (message_id) DO UPDATE
        SET outcome = EXCLUDED.outcome,
            detail = EXCLUDED.detail,
            project_id = COALESCE(EXCLUDED.project_id, email_intake.project_id),
            updated_at = now()`,
    [messageId, outcome, detail.slice(0, 2000), projectId ?? null],
  ).catch((err: unknown) => {
    console.error('[mail] could not record outcome:', err instanceof Error ? err.message : err);
  });
}

/**
 * Take ownership of a message, or discover somebody already has.
 *
 * `ON CONFLICT DO NOTHING` is the whole multi-replica story: exactly one poller inserts
 * the row and processes the mail, and a redelivery of an already-handled message inserts
 * nothing and is skipped.
 */
async function claimMessage(
  messageId: string,
  sender: string,
  subject: string | null,
  receivedAt: Date | null,
): Promise<boolean> {
  const rows = await query<{ message_id: string }>(
    `INSERT INTO email_intake (message_id, sender, subject, received_at, outcome)
     VALUES ($1, $2, $3, $4, 'claimed')
     ON CONFLICT (message_id) DO NOTHING
     RETURNING message_id`,
    [messageId, sender, subject, receivedAt],
  );
  return rows.length > 0;
}

/**
 * The high-water mark for this mailbox, seeding it on first sight.
 *
 * A fresh cursor starts at `uidNext - 1`, i.e. the current end of the mailbox, so turning
 * the feature on never reaches backwards into mail that was already there. Same on a
 * uid_validity change, which is the server telling us the old numbering is meaningless.
 */
async function readCursor(uidValidity: number, uidNext: number): Promise<number> {
  const rows = await query<{ last_uid: string; uid_validity: string }>(
    'SELECT last_uid, uid_validity FROM mail_cursor WHERE mailbox = $1',
    [MAILBOX],
  );
  const row = rows[0];
  if (row && Number(row.uid_validity) === uidValidity) return Number(row.last_uid);

  const start = Math.max(0, uidNext - 1);
  await query(
    `INSERT INTO mail_cursor (mailbox, uid_validity, last_uid) VALUES ($1, $2, $3)
     ON CONFLICT (mailbox) DO UPDATE
        SET uid_validity = EXCLUDED.uid_validity,
            last_uid = EXCLUDED.last_uid,
            updated_at = now()`,
    [MAILBOX, uidValidity, start],
  );
  console.log(`[mail] cursor for ${MAILBOX} set to uid ${start}; only later mail is considered`);
  return start;
}

/** Never moves backwards, so an out-of-order failure cannot re-open old mail. */
async function advanceCursor(uidValidity: number, uid: number): Promise<void> {
  await query(
    `UPDATE mail_cursor SET last_uid = GREATEST(last_uid, $3), updated_at = now()
      WHERE mailbox = $1 AND uid_validity = $2`,
    [MAILBOX, uidValidity, uid],
  ).catch((err: unknown) => {
    console.error('[mail] cursor update failed:', err instanceof Error ? err.message : err);
  });
}

type Attachment = { filename: string; content: Uint8Array; contentType?: string };

/**
 * Everything after the mail has been fetched and claimed. Split out from the IMAP plumbing
 * so it can be exercised from a captured `.eml` fixture without a network.
 */
export async function ingestMessage(msg: {
  messageId: string;
  from: string | null;
  subject: string | null;
  date: Date | null;
  authenticationResults: string | string[] | null;
  attachments: Attachment[];
}): Promise<{ accepted: boolean; detail: string; projectId?: string }> {
  const sender = parseAddress(msg.from);

  const screened = await screenMessage({
    from: msg.from,
    authenticationResults: msg.authenticationResults,
  });
  if (!screened.ok) {
    await record(msg.messageId, screened.outcome, screened.detail);
    return { accepted: false, detail: screened.detail };
  }

  // Validate every attachment BEFORE creating anything. A project whose only PDF turns out
  // to be an invoice is worse than no project: it sits in the list looking like work.
  const staging = await mkdtemp(join(tmpdir(), 'cbc-intake-'));
  const accepted: Attachment[] = [];
  const rejected: string[] = [];
  try {
    for (const att of msg.attachments) {
      const shape = checkAttachment(att.filename, att.content);
      if (!shape.ok) {
        rejected.push(shape.detail);
        continue;
      }
      const probe = join(staging, `probe-${accepted.length}.pdf`);
      await writeFile(probe, att.content);
      const plan = await checkPlanSet(probe);
      if (!plan.ok) {
        rejected.push(`${att.filename}: ${plan.detail}`);
        continue;
      }
      accepted.push(att);
    }
  } finally {
    await rm(staging, { recursive: true, force: true }).catch(() => {});
  }

  if (accepted.length === 0) {
    const detail = rejected.length
      ? `no usable plan set: ${rejected.join('; ')}`
      : 'no PDF attachments';
    await record(msg.messageId, 'rejected_file', detail);
    return { accepted: false, detail };
  }

  const name = projectNameFromSubject(msg.subject, `Bid set from ${sender}`);
  const created = await createProjectDeduped(name);
  if (!created.ok) {
    const detail = `could not create project: ${created.reason} ${created.detail ?? ''}`.trim();
    await record(msg.messageId, 'error', detail);
    return { accepted: false, detail };
  }

  const project = created.project;
  const queued: string[] = [];
  for (const att of accepted) {
    const { run } = await attachFile(project, att.filename, att.content, {
      size: att.content.byteLength,
      mime: att.contentType ?? 'application/pdf',
    });
    queued.push(`${att.filename} -> run ${run.id}`);
  }

  const detail = [`queued ${queued.length}: ${queued.join(', ')}`, ...rejected].join(' | ');
  await record(msg.messageId, 'accepted', detail, project.id);
  return { accepted: true, detail, projectId: project.id };
}

let timer: NodeJS.Timeout | undefined;
let polling = false;

async function cycle(): Promise<void> {
  // `imapflow` is imported here rather than at module scope so the gateway starts, and the
  // rest of the app works, on an install that has never configured mail.
  const { ImapFlow } = await import('imapflow');
  const { simpleParser } = await import('mailparser');

  const client = new ImapFlow({
    host: process.env.IMAP_HOST || 'imap.gmail.com',
    port: Number(process.env.IMAP_PORT || 993),
    secure: true,
    auth: {
      user: process.env.IMAP_USER || '',
      pass: process.env.IMAP_PASSWORD || '',
    },
    logger: false,
  });

  await client.connect();
  try {
    const lock = await client.getMailboxLock(MAILBOX);
    try {
      const box = client.mailbox;
      if (!box || typeof box === 'boolean') return;
      const uidValidity = Number(box.uidValidity ?? 0);

      // Where we got to last time. On a first run - or after the server renumbers UIDs -
      // start from the CURRENT end of the mailbox rather than the beginning: this feature
      // is for mail that arrives from now on, and an inbox with years of history is not
      // something to march through.
      const cursor = await readCursor(uidValidity, Number(box.uidNext ?? 1));
      const range = `${cursor + 1}:*`;
      const found = (await client.search({ uid: range }, { uid: true })) || [];
      // `uid:"n:*"` always returns at least the highest message, even when it is <= n.
      const fresh = found.filter((u) => u > cursor).sort((a, b) => a - b);
      if (fresh.length === 0) return;

      const batch = fresh.slice(0, MAX_PER_CYCLE);
      console.log(`[mail] ${fresh.length} new message(s) since uid ${cursor}, taking ${batch.length}`);

      for (const uid of batch) {
        const fetched = await client.fetchOne(String(uid), { source: true }, { uid: true });
        if (!fetched || !fetched.source) continue;
        const parsed = await simpleParser(fetched.source);

        const messageId = parsed.messageId || `uid:${MAILBOX}:${uid}`;
        const from = parsed.from?.value?.[0]?.address
          ? `${parsed.from.value[0].name ?? ''} <${parsed.from.value[0].address}>`
          : (parsed.from?.text ?? null);
        const sender = parseAddress(from);

        if (!(await claimMessage(messageId, sender || 'unknown', parsed.subject ?? null, parsed.date ?? null))) {
          // Another replica owns it, or we have handled it before.
          await advanceCursor(uidValidity, uid);
          continue;
        }

        let result: { accepted: boolean; detail: string };
        try {
          result = await ingestMessage({
            messageId,
            from,
            subject: parsed.subject ?? null,
            date: parsed.date ?? null,
            authenticationResults: parsed.headers.get('authentication-results') as
              | string
              | string[]
              | null,
            attachments: (parsed.attachments ?? []).map((a) => ({
              filename: a.filename ?? 'attachment.pdf',
              content: a.content as unknown as Uint8Array,
              contentType: a.contentType,
            })),
          });
        } catch (err) {
          const detail = err instanceof Error ? err.message : String(err);
          await record(messageId, 'error', detail);
          console.error(`[mail] ${messageId} failed:`, detail);
          // Advance anyway: the claim row is already written, so retrying this uid would
          // skip it regardless, and not advancing would wedge the cursor on one message.
          await advanceCursor(uidValidity, uid);
          continue;
        }

        // Only now is the cursor safe to move - the run is committed.
        await advanceCursor(uidValidity, uid);
        console.log(`[mail] ${result.accepted ? 'accepted' : 'refused'} ${messageId}: ${result.detail}`);
      }
    } finally {
      lock.release();
    }
  } finally {
    await client.logout().catch(() => {});
  }
}

async function tick(): Promise<void> {
  if (polling) return;
  polling = true;
  try {
    await cycle();
  } catch (err) {
    console.error('[mail] poll failed:', err instanceof Error ? err.message : err);
  } finally {
    polling = false;
    schedule();
  }
}

function schedule(): void {
  timer = setTimeout(() => void tick(), POLL_MS);
  timer.unref();
}

export function startMailIntake(): void {
  if (timer) return;
  if (!intakeEnabled()) {
    console.log('[mail] intake disabled (set INTAKE_ENABLED=1 to poll)');
    return;
  }
  if (!process.env.IMAP_USER || !process.env.IMAP_PASSWORD) {
    console.error('[mail] INTAKE_ENABLED is set but IMAP_USER/IMAP_PASSWORD are not; not polling');
    return;
  }
  console.log(`[mail] polling ${process.env.IMAP_USER} every ${POLL_MS}ms`);
  void tick();
}
