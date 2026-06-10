/**
 * Import Fintual confirmation emails from Gmail and update the paper ledger.
 *
 * Reads your Gmail over IMAP (same app password as SMTP), finds emails from
 * Fintual, parses each purchase/sale, maps the company to a universe ticker, and
 * records a fill. Idempotent: re-running won't double-count (deduped by email id).
 *
 * Usage: npm run import-fintual
 * Requires: SMTP_USER + SMTP_PASS (Gmail + app password), in .env.
 */
import 'dotenv/config';
import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';
import { StaticUniverse } from '../src/universe';
import { PaperLedger } from '../src/ledger';
import { parseFintualEmail, matchTicker, toManualFill } from '../src/ledger/fintual-import';

const FINTUAL_FROM = 'fintual.com';
const SINCE_DAYS = parseInt(process.env['IMPORT_SINCE_DAYS'] ?? '120', 10);

async function main(): Promise<void> {
  const user = process.env['SMTP_USER'];
  const pass = process.env['SMTP_PASS'];
  if (!user || !pass) {
    console.error('Falta SMTP_USER / SMTP_PASS en .env (Gmail + app password).');
    process.exit(1);
  }

  const universe = await new StaticUniverse().list();
  const ledger = new PaperLedger();
  const alreadyImported = new Set(ledger.getFills().map((f) => f.recommendationId));

  const client = new ImapFlow({ host: 'imap.gmail.com', port: 993, secure: true, auth: { user, pass }, logger: false });
  await client.connect();

  let imported = 0, skipped = 0, unmatched = 0, nonInvestment = 0;
  const lock = await client.getMailboxLock('INBOX');
  try {
    const since = new Date(Date.now() - SINCE_DAYS * 86_400_000);
    const uids = await client.search({ from: FINTUAL_FROM, since }, { uid: true });
    const list = Array.isArray(uids) ? uids : [];
    console.log(`Encontrados ${list.length} correo(s) de Fintual (últimos ${SINCE_DAYS} días).\n`);

    if (list.length > 0) {
      for await (const msg of client.fetch(list.join(','), { uid: true, source: true }, { uid: true })) {
        const parsedMail = await simpleParser(msg.source as Buffer);
        const emailId = parsedMail.messageId ?? `uid-${msg.uid}`;
        const recId = `fintual-${emailId}`;
        if (alreadyImported.has(recId)) { skipped++; continue; }

        const text = `${parsedMail.subject ?? ''}\n${parsedMail.text ?? ''}`;
        const parsed = parseFintualEmail(text);
        if (!parsed) { nonInvestment++; continue; }

        const ticker = matchTicker(parsed.company, universe);
        if (!ticker) {
          unmatched++;
          console.log(`  ⚠️  No pude mapear "${parsed.company}" a un ticker — sáltala o agrégala al universo.`);
          continue;
        }

        const fill = toManualFill(parsed, ticker, emailId, parsedMail.date ?? new Date());
        ledger.recordFill(fill);
        alreadyImported.add(recId);
        imported++;
        const verb = parsed.action === 'sell' ? '🔴 venta' : '🟢 compra';
        console.log(`  ${verb} ${ticker.padEnd(5)} ${Math.abs(fill.shares)} acc @ US$${fill.filledPrice.toFixed(2)} (US$${parsed.amountUsd.toFixed(2)})`);
      }
    }
  } finally {
    lock.release();
    await client.logout();
  }

  console.log(`\nListo. Importados ${imported}, ya estaban ${skipped}, sin mapear ${unmatched}, no-inversión ${nonInvestment}.`);
  process.exit(0);
}

main().catch((err) => {
  console.error('import-fintual falló:', err.message ?? err);
  process.exit(1);
});
