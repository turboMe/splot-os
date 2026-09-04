#!/usr/bin/env tsx
/**
 * What leaves this system as mail — two rules, both learned from an inbox.
 *
 * After the huntAgent canary the drafts were opened by a human, and two things
 * were wrong that no gate could have caught, because nothing here had ever
 * inspected a built message:
 *
 *  1. **The subject arrived as mojibake.** A mail header is ASCII by definition
 *     (RFC 5322); a Polish subject written straight into it is not a subject with
 *     an encoding problem, it is an invalid header. The BODY was fine the whole
 *     time — `Content-Type: charset=UTF-8` covers it — which is exactly why this
 *     looked like a mystery: two different layers, one of them missing.
 *  2. **Em-dashes.** A house style rule that `writerAgent` enforces by FAILING its
 *     attempt. An outbound draft cannot fail over punctuation — the work is done
 *     and a human is about to read it — so it is normalized on the way out.
 *
 * The subject assertions decode the header back and compare to the original,
 * rather than matching the encoded shape. Matching the shape would pass for an
 * encoding that is well-formed and wrong, which is the failure being fixed.
 *
 * Run: npx tsx src/mastra/scripts/check-outbound-mail.ts
 */
import assert from 'node:assert/strict';

import { buildOutboundMime } from '../tools/google/gmail.js';
import { countForbiddenWriterEmDashes, normalizeOutboundDashes } from '../tools/writer/anti-slop.js';

let failures = 0;
function check(name: string, fn: () => void): void {
  try {
    fn();
    console.log(`  ✓ ${name}`);
  } catch (error) {
    failures++;
    console.error(`  ✗ ${name}: ${(error as Error).stack ?? (error as Error).message}`);
  }
}

console.log('check:outbound-mail');

/** Decode a Subject header the way a mail client does. */
function decodeSubject(mime: string): string {
  const raw = /^Subject: (.*(?:\r\n .*)*)$/m.exec(mime)?.[1] ?? '';
  // Adjacent encoded-words are joined WITHOUT the folding whitespace between them.
  const unfolded = raw.replace(/\r\n /g, '');
  return unfolded.replace(
    /=\?UTF-8\?B\?([^?]*)\?=/gi,
    (_m, b64: string) => Buffer.from(b64, 'base64').toString('utf8'),
  );
}

function bodyOf(mime: string): string {
  return mime.split('\r\n\r\n').slice(1).join('\r\n\r\n');
}

check('an ASCII subject is left exactly as written', () => {
  const mime = buildOutboundMime({ to: 'a@b.pl', subject: 'Quick question', body: 'hi' });
  assert.match(mime, /^Subject: Quick question$/m,
    'encoding an ASCII header would be legal but would obscure every raw message');
});

check('a Polish subject survives the round trip', () => {
  // The reported bug, in one assertion.
  const subject = 'miód spadziowy iglasty z Sudetów, współpraca z restauracjami?';
  const mime = buildOutboundMime({ to: 'a@b.pl', subject, body: 'treść' });
  assert.ok(!new RegExp(`^Subject: ${subject}`, 'm').test(mime),
    'the raw non-ASCII header is the defect itself');
  assert.equal(decodeSubject(mime), subject, 'and it must decode back to what was written');
});

check('a LONG Polish subject splits without cutting a character in half', () => {
  // The trap in the fix: chunking by characters but budgeting by BYTES. Split in
  // the wrong place and well-formed encoding produces new mojibake.
  const subject = 'Zażółć gęślą jaźń — '.repeat(6) + 'ostatnie słowo';
  const mime = buildOutboundMime({ to: 'a@b.pl', subject, body: 'x' });
  assert.equal(decodeSubject(mime), normalizeOutboundDashes(subject));
  const encodedWords = mime.match(/=\?UTF-8\?B\?[^?]*\?=/gi) ?? [];
  assert.ok(encodedWords.length > 1, 'a subject this long must occupy more than one encoded-word');
  for (const word of encodedWords) {
    assert.ok(word.length <= 75, `encoded-word exceeds the RFC 2047 limit: ${word.length} chars`);
  }
});

check('em-dashes never leave the system, in the subject or the body', () => {
  const mime = buildOutboundMime({
    to: 'a@b.pl',
    subject: 'miód z Sudetów — współpraca?',
    body: 'Cześć,\n\nWasza pasieka — 600 uli — robi wrażenie.\nPozdrawiam',
  });
  assert.equal(countForbiddenWriterEmDashes(decodeSubject(mime)), 0, 'subject must be clean');
  assert.equal(countForbiddenWriterEmDashes(bodyOf(mime)), 0, 'body must be clean');
  assert.match(bodyOf(mime), /pasieka - 600 uli - robi/,
    'the pause is kept as a spaced hyphen, not deleted and not turned into a comma');
});

check('the en-dash is left alone', () => {
  // Legitimate in ranges. Rewriting it would be a different bug wearing this fix.
  const mime = buildOutboundMime({ to: 'a@b.pl', subject: 'godziny 10–12', body: 'ok' });
  assert.equal(decodeSubject(mime), 'godziny 10–12');
});

check('the body declares how it is encoded', () => {
  const mime = buildOutboundMime({ to: 'a@b.pl', subject: 'x', body: 'zażółć' });
  assert.match(mime, /^Content-Type: text\/plain; charset=UTF-8$/m);
  assert.match(mime, /^Content-Transfer-Encoding: 8bit$/m);
});

check('reply headers still travel', () => {
  const mime = buildOutboundMime({
    to: 'a@b.pl', subject: 'Re: x', body: 'y',
    inReplyTo: '<id-1@mail>', references: '<id-0@mail> <id-1@mail>',
  });
  assert.match(mime, /^In-Reply-To: <id-1@mail>$/m);
  assert.match(mime, /^References: <id-0@mail> <id-1@mail>$/m);
});

check('multipart attachments are properly formatted with base64', () => {
  const mime = buildOutboundMime({
    to: 'a@b.pl',
    subject: 'Aplikacja z CV',
    body: 'Dzień dobry, przesyłam CV.',
    attachments: [
      {
        filename: 'Candidate_CV.pdf',
        content: Buffer.from('test-pdf-content', 'utf8'),
      },
    ],
  });
  assert.match(mime, /^Content-Type: multipart\/mixed; boundary="mixed_/m);
  assert.match(mime, /Content-Disposition: attachment; filename="Candidate_CV\.pdf"/m);
  assert.match(mime, /Content-Transfer-Encoding: base64/m);
  assert.match(mime, new RegExp(Buffer.from('test-pdf-content').toString('base64')));
});

check('HTML email produces multipart/alternative with plain-text fallback', () => {
  const mime = buildOutboundMime({
    to: 'klient@gastro.pl',
    subject: 'Oferta GastroBridge',
    body: 'Wersja tekstowa oferty.',
    html: '<div style="color: #333;"><h1>Oferta GastroBridge</h1><p>Wersja HTML.</p></div>',
  });
  assert.match(mime, /^Content-Type: multipart\/alternative; boundary="alt_/m);
  assert.match(mime, /Content-Type: text\/plain; charset=UTF-8/);
  assert.match(mime, /Wersja tekstowa oferty\./);
  assert.match(mime, /Content-Type: text\/html; charset=UTF-8/);
  assert.match(mime, /<div style="color: #333;"><h1>Oferta GastroBridge<\/h1>/);
});

check('HTML email with attachments combines multipart/mixed and multipart/alternative', () => {
  const mime = buildOutboundMime({
    to: 'hr@techcompany.com',
    subject: 'Aplikacja Senior Fullstack',
    body: 'Tekst CV.',
    html: '<div><h1>Alex Doe</h1><p>Portfolio: https://flowmint-ai.web.app/</p></div>',
    attachments: [
      {
        filename: 'CV.pdf',
        content: Buffer.from('pdf-data', 'utf8'),
      },
    ],
  });
  assert.match(mime, /^Content-Type: multipart\/mixed; boundary="mixed_/m);
  assert.match(mime, /Content-Type: multipart\/alternative; boundary="alt_/m);
  assert.match(mime, /Content-Type: text\/html; charset=UTF-8/);
  assert.match(mime, /Content-Disposition: attachment; filename="CV\.pdf"/m);
});

console.log(failures === 0 ? '\nOK' : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
