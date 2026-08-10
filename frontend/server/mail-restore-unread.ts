/**
 * One-off repair: put back the unread flags the first version of the poller removed.
 *
 * That version tracked progress by flagging messages `\Seen`, which is fine on a mailbox
 * that exists only for intake and wrong on a person's real inbox. The poller now keeps a
 * UID high-water mark and never writes to the mailbox at all - this undoes the damage the
 * old behaviour already did.
 *
 * Only messages this system refused are touched, identified by the Message-IDs it recorded
 * in `email_intake`. Anything it accepted is left alone, and so is every message it never
 * saw. Run with `npm run mail:restore-unread`; add `--apply` to actually write.
 *
 * This is disposable. Delete it once the inbox is tidy.
 */
import { query } from '../lib/db.ts';

const APPLY = process.argv.includes('--apply');
const MAILBOX = process.env.IMAP_MAILBOX || 'INBOX';

const rows = await query<{ message_id: string; sender: string; outcome: string }>(
  `SELECT message_id, sender, outcome FROM email_intake
    WHERE outcome LIKE 'rejected%' ORDER BY created_at`,
);
if (rows.length === 0) {
  console.log('nothing to restore');
  process.exit(0);
}
console.log(`${rows.length} refused message(s) recorded; ${APPLY ? 'restoring' : 'DRY RUN'}`);

const { ImapFlow } = await import('imapflow');
const client = new ImapFlow({
  host: process.env.IMAP_HOST || 'imap.gmail.com',
  port: Number(process.env.IMAP_PORT || 993),
  secure: true,
  auth: { user: process.env.IMAP_USER || '', pass: process.env.IMAP_PASSWORD || '' },
  logger: false,
});

await client.connect();
let restored = 0;
let missing = 0;
try {
  const lock = await client.getMailboxLock(MAILBOX);
  try {
    for (const row of rows) {
      // Search by header rather than uid: the uid was never stored, and Message-ID is the
      // stable identifier the intake table already keeps.
      const hits = await client.search({ header: { 'message-id': row.message_id } }, { uid: true });
      if (!hits || hits.length === 0) {
        missing += 1;
        continue;
      }
      if (APPLY) await client.messageFlagsRemove(hits, ['\\Seen'], { uid: true });
      restored += 1;
      console.log(`  ${APPLY ? 'unread' : 'would unread'}  ${row.sender}  ${row.message_id}`);
    }
  } finally {
    lock.release();
  }
} finally {
  await client.logout().catch(() => {});
}

console.log(
  `${APPLY ? 'restored' : 'would restore'} ${restored}` +
    (missing ? `, ${missing} no longer found in ${MAILBOX}` : ''),
);
if (!APPLY) console.log('re-run with --apply to write the change');
process.exit(0);
