/**
 * Deterministic email extraction helper for producer-hunt extract-emails step.
 * Plan: ideas/producer-hunt-fix-v2.md krok 5.
 */

const EMAIL_REGEX = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;

const PLACEHOLDER_LOCAL_PARTS = new Set([
  'name',
  'imie',
  'imię',
  'example',
  'test',
  'user',
  'noreply',
  'no-reply',
  'admin',
  'webmaster',
]);

const PLACEHOLDER_DOMAINS = new Set([
  'example.com',
  'example.org',
  'example.net',
  'domain.com',
  'domain.pl',
  'firma.pl',
  'company.pl',
  'mail.com',
  'test.com',
]);

function getDomain(value?: string | null): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  try {
    const url = new URL(trimmed.startsWith('http') ? trimmed : `https://${trimmed}`);
    return url.hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return null;
  }
}

function stripTrailingPunctuation(s: string): string {
  return s.replace(/[.,;:)\]\s]+$/g, '');
}

function isPlaceholder(email: string): boolean {
  const lower = email.toLowerCase();
  const [local, domain] = lower.split('@');
  if (!local || !domain) return true;
  if (PLACEHOLDER_LOCAL_PARTS.has(local)) return true;
  if (PLACEHOLDER_DOMAINS.has(domain)) return true;
  return false;
}

/**
 * Wyciąga unikalne, znormalizowane adresy email z dowolnego tekstu.
 * - usuwa trailing punctuation,
 * - lower-case domeny,
 * - odrzuca placeholdery (example.com, test@, name@domain).
 */
export function extractEmailsFromText(text: string): string[] {
  if (!text) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  const matches = text.match(EMAIL_REGEX) ?? [];
  for (const raw of matches) {
    const cleaned = stripTrailingPunctuation(raw);
    if (!cleaned.includes('@')) continue;
    const [local, domainPart] = cleaned.split('@');
    if (!local || !domainPart) continue;
    const normalized = `${local}@${domainPart.toLowerCase()}`;
    if (seen.has(normalized)) continue;
    if (isPlaceholder(normalized)) continue;
    seen.add(normalized);
    out.push(normalized);
  }
  return out;
}

export type EmailPickInput = {
  rawAnalysis?: string | null;
  emailSource?: string | null;
  website?: string | null;
  sourceUrls?: string[] | string | null;
  leadContext?: string | null;
};

/**
 * Wybiera najlepszy email z kontekstu lead'a, preferując domenę zgodną z website.
 * Kolejność źródeł: emailSource → rawAnalysis → website tekst → sourceUrls → leadContext.
 *
 * Zwraca null jeśli nic sensownego nie znalazł.
 */
export function pickBestEmail(input: EmailPickInput): string | null {
  const sources: string[] = [];
  if (input.emailSource) sources.push(String(input.emailSource));
  if (input.rawAnalysis) sources.push(String(input.rawAnalysis));
  if (input.website) sources.push(String(input.website));
  if (Array.isArray(input.sourceUrls)) sources.push(input.sourceUrls.join(' '));
  else if (input.sourceUrls) sources.push(String(input.sourceUrls));
  if (input.leadContext) sources.push(String(input.leadContext));

  const aggregated = sources.join('\n');
  const candidates = extractEmailsFromText(aggregated);
  if (candidates.length === 0) return null;

  const websiteDomain = getDomain(input.website ?? null);
  if (websiteDomain) {
    const matchingDomain = candidates.find((email) => email.split('@')[1] === websiteDomain);
    if (matchingDomain) return matchingDomain;
  }

  return candidates[0];
}
