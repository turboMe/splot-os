export type WriterDeliverableLanguage = 'pl' | 'en' | string;

export interface SlopIssue {
  line: number;
  phrase: string;
  category: 'stock_phrase' | 'weak_opener' | 'business_jargon' | 'structure' | 'passive_voice' | 'repetition' | 'forbidden_punctuation';
  severity: 'low' | 'medium' | 'high';
  suggestion: string;
}

export interface SlopAuditResult {
  score: number;
  issues: SlopIssue[];
  passiveVoiceRatio: number;
  avgSentenceLength: number;
  sentenceLengthVariance: number;
  repeatedOpeners: string[];
  clichePhrases: string[];
  language: WriterDeliverableLanguage;
}

interface PhraseRule {
  phrase: string;
  category: SlopIssue['category'];
  severity: SlopIssue['severity'];
  suggestion: string;
}

const ENGLISH_RULES: PhraseRule[] = [
  { phrase: 'it is important to note', category: 'weak_opener', severity: 'medium', suggestion: 'State the point directly.' },
  { phrase: 'it is worth noting', category: 'weak_opener', severity: 'medium', suggestion: 'Remove the throat-clearing phrase.' },
  { phrase: 'in today\'s fast-paced world', category: 'stock_phrase', severity: 'high', suggestion: 'Replace with concrete context.' },
  { phrase: 'ever-evolving landscape', category: 'stock_phrase', severity: 'high', suggestion: 'Name the actual change.' },
  { phrase: 'at the end of the day', category: 'stock_phrase', severity: 'medium', suggestion: 'Use a precise conclusion.' },
  { phrase: 'game-changer', category: 'business_jargon', severity: 'medium', suggestion: 'Explain the actual effect.' },
  { phrase: 'seamlessly', category: 'business_jargon', severity: 'low', suggestion: 'Show what becomes easier.' },
  { phrase: 'robust solution', category: 'business_jargon', severity: 'medium', suggestion: 'Describe the specific capability.' },
  { phrase: 'unlock the potential', category: 'business_jargon', severity: 'high', suggestion: 'Specify the potential and mechanism.' },
  { phrase: 'delve into', category: 'stock_phrase', severity: 'medium', suggestion: 'Use a direct verb.' },
  { phrase: 'tapestry', category: 'stock_phrase', severity: 'medium', suggestion: 'Use concrete imagery or remove.' },
  { phrase: 'realm of', category: 'stock_phrase', severity: 'medium', suggestion: 'Name the field directly.' },
  { phrase: 'this article explores', category: 'weak_opener', severity: 'medium', suggestion: 'Open with the claim or scene.' },
  { phrase: 'in conclusion', category: 'structure', severity: 'low', suggestion: 'Use a stronger closing move.' },
  { phrase: 'not only', category: 'structure', severity: 'low', suggestion: 'Check whether the contrast is necessary.' },
];

const POLISH_RULES: PhraseRule[] = [
  { phrase: 'warto zauwazyc', category: 'weak_opener', severity: 'medium', suggestion: 'Powiedz teze bez wstepnego asekurowania.' },
  { phrase: 'nalezy podkreslic', category: 'weak_opener', severity: 'medium', suggestion: 'Zastap konkretna obserwacja.' },
  { phrase: 'w dzisiejszym dynamicznym swiecie', category: 'stock_phrase', severity: 'high', suggestion: 'Podaj konkretny kontekst zamiast kliszy.' },
  { phrase: 'w erze cyfrowej', category: 'stock_phrase', severity: 'medium', suggestion: 'Nazwij realna zmiane albo pomin.' },
  { phrase: 'na koniec dnia', category: 'stock_phrase', severity: 'medium', suggestion: 'Uzyj precyzyjnego wniosku.' },
  { phrase: 'kluczowe znaczenie', category: 'business_jargon', severity: 'medium', suggestion: 'Wyjasnij, co dokladnie jest wazne i dlaczego.' },
  { phrase: 'szerokie spektrum', category: 'stock_phrase', severity: 'low', suggestion: 'Podaj zakres lub konkretne przyklady.' },
  { phrase: 'niniejszy artykul', category: 'weak_opener', severity: 'medium', suggestion: 'Zacznij od tezy, nie od metakomentarza.' },
  { phrase: 'podsumowujac', category: 'structure', severity: 'low', suggestion: 'Zamknij tekst mocniejszym ruchem.' },
  { phrase: 'nie tylko', category: 'structure', severity: 'low', suggestion: 'Sprawdz, czy konstrukcja kontrastu wnosi napiecie.' },
];

const PASSIVE_EN = /\b(?:is|are|was|were|be|been|being)\s+\w+(?:ed|en)\b/gi;
const PASSIVE_PL = /\b(?:jest|sa|byl|byla|bylo|byly|zostal|zostala|zostalo|zostaly)\s+\w+(?:ny|na|ne|ty|ta|te)\b/gi;

function normalize(text: string): string {
  return text
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
}

function sentenceSplit(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+/)
    .map((sentence) => sentence.trim())
    .filter(Boolean);
}

function wordCount(text: string): number {
  return (text.match(/[\p{L}\p{N}'-]+/gu) ?? []).length;
}

function variance(values: number[]): number {
  if (values.length <= 1) return 0;
  const avg = values.reduce((sum, value) => sum + value, 0) / values.length;
  return values.reduce((sum, value) => sum + (value - avg) ** 2, 0) / values.length;
}

function lineForIndex(text: string, index: number): number {
  return text.slice(0, Math.max(0, index)).split('\n').length;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function detectPhraseIssues(text: string, language: WriterDeliverableLanguage): SlopIssue[] {
  const normalized = normalize(text);
  const rules = language === 'pl' ? POLISH_RULES : [...ENGLISH_RULES, ...POLISH_RULES];
  const issues: SlopIssue[] = [];

  for (const rule of rules) {
    const pattern = new RegExp(`\\b${escapeRegExp(normalize(rule.phrase))}\\b`, 'g');
    for (const match of normalized.matchAll(pattern)) {
      issues.push({
        line: lineForIndex(normalized, match.index ?? 0),
        phrase: rule.phrase,
        category: rule.category,
        severity: rule.severity,
        suggestion: rule.suggestion,
      });
    }
  }

  return issues;
}

function detectRepeatedOpeners(sentences: string[]): string[] {
  const counts = new Map<string, number>();
  for (const sentence of sentences) {
    const opener = normalize(sentence)
      .split(/\s+/)
      .slice(0, 3)
      .join(' ')
      .replace(/[^a-z0-9 ]/g, '')
      .trim();
    if (opener.length >= 8) counts.set(opener, (counts.get(opener) ?? 0) + 1);
  }
  return [...counts.entries()]
    .filter(([, count]) => count >= 3)
    .map(([opener]) => opener);
}

function passiveVoiceRatio(text: string, language: WriterDeliverableLanguage, sentenceCount: number): number {
  const pattern = language === 'pl' ? PASSIVE_PL : PASSIVE_EN;
  const matches = text.match(pattern) ?? [];
  if (sentenceCount === 0) return 0;
  return Number((matches.length / sentenceCount).toFixed(3));
}

function structuralIssues(text: string, sentences: string[], repeatedOpeners: string[]): SlopIssue[] {
  const normalized = normalize(text);
  const issues: SlopIssue[] = [];

  const listMarkers = text.match(/(?:^|\n)\s*(?:[-*]|\d+\.)\s+/g) ?? [];
  if (listMarkers.length >= 8 && sentences.length < listMarkers.length * 2) {
    issues.push({
      line: 1,
      phrase: 'list-heavy structure',
      category: 'structure',
      severity: 'medium',
      suggestion: 'Break list-heavy material with argument, scene, or explanation.',
    });
  }

  const binaryContrastCount = (normalized.match(/\b(?:not only|nie tylko)\b/g) ?? []).length;
  if (binaryContrastCount >= 3) {
    issues.push({
      line: 1,
      phrase: 'repeated binary contrast',
      category: 'structure',
      severity: 'medium',
      suggestion: 'Vary contrast structures instead of repeating not-only framing.',
    });
  }

  for (const opener of repeatedOpeners) {
    issues.push({
      line: 1,
      phrase: opener,
      category: 'repetition',
      severity: 'medium',
      suggestion: 'Vary sentence openings and paragraph rhythm.',
    });
  }

  for (const match of text.matchAll(/(?:\u2014|&mdash;|&#8212;|&#x2014;)/gi)) {
    issues.push({
      line: lineForIndex(text, match.index ?? 0),
      phrase: 'U+2014 em dash',
      category: 'forbidden_punctuation',
      severity: 'high',
      suggestion: 'Replace the em dash with sentence punctuation, a comma, a colon, or parentheses.',
    });
  }

  return issues;
}

/** A hard project style rule, exposed for write/export boundaries and tests. */
export function countForbiddenWriterEmDashes(text: string): number {
  return (text.match(/(?:\u2014|&mdash;|&#8212;|&#x2014;)/gi) ?? []).length;
}

/**
 * The same rule, applied instead of counted \u2014 for text leaving the system.
 *
 * `writerAgent` FAILS its attempt on an em-dash, because there the punctuation is
 * the deliverable's own quality. An outbound email is different: the draft is
 * already written, a human is about to read it, and failing the run over
 * punctuation would throw away the work. So it is normalized on the way out.
 *
 * A hyphen with spaces, not a comma: it carries the same pause in both Polish and
 * English without inventing a clause boundary the author did not write. Any
 * whitespace around the dash is absorbed, so `x\u2014y`, `x \u2014 y` and `x \u2014y` all land
 * on one shape.
 *
 * Deliberately limited to the em-dash and its HTML entities \u2014 the same set the
 * counter matches. The en-dash (U+2013) is left alone: it is legitimate in
 * ranges ("10\u201312"), and silently rewriting those would be a different bug.
 */
export function normalizeOutboundDashes(text: string): string {
  return text.replace(/\s*(?:\u2014|&mdash;|&#8212;|&#x2014;)\s*/gi, ' - ');
}

function scoreIssues(issues: SlopIssue[], passiveRatio: number, sentenceVariance: number): number {
  if (issues.some((issue) => issue.category === 'forbidden_punctuation')) return 0;
  const penalty = issues.reduce((sum, issue) => {
    if (issue.severity === 'high') return sum + 12;
    if (issue.severity === 'medium') return sum + 7;
    return sum + 3;
  }, 0);
  const passivePenalty = passiveRatio > 0.3 ? 10 : passiveRatio > 0.2 ? 5 : 0;
  const rhythmPenalty = sentenceVariance < 8 && issues.length > 0 ? 5 : 0;
  return Math.max(0, Math.min(100, 100 - penalty - passivePenalty - rhythmPenalty));
}

export function auditSlop(text: string, language: WriterDeliverableLanguage = 'en'): SlopAuditResult {
  const sentences = sentenceSplit(text);
  const sentenceLengths = sentences.map(wordCount);
  const totalWords = sentenceLengths.reduce((sum, count) => sum + count, 0);
  const avgSentenceLength = sentences.length === 0 ? 0 : Number((totalWords / sentences.length).toFixed(2));
  const sentenceLengthVariance = Number(variance(sentenceLengths).toFixed(2));
  const repeatedOpeners = detectRepeatedOpeners(sentences);
  const passiveRatio = passiveVoiceRatio(text, language, sentences.length);

  const issues = [
    ...detectPhraseIssues(text, language),
    ...structuralIssues(text, sentences, repeatedOpeners),
  ];

  if (passiveRatio > 0.25) {
    issues.push({
      line: 1,
      phrase: 'passive voice cluster',
      category: 'passive_voice',
      severity: 'low',
      suggestion: 'Review whether passive constructions are intentional.',
    });
  }

  const clichePhrases = issues
    .filter((issue) => issue.category === 'stock_phrase' || issue.category === 'business_jargon')
    .map((issue) => issue.phrase);

  return {
    score: scoreIssues(issues, passiveRatio, sentenceLengthVariance),
    issues,
    passiveVoiceRatio: passiveRatio,
    avgSentenceLength,
    sentenceLengthVariance,
    repeatedOpeners,
    clichePhrases: [...new Set(clichePhrases)],
    language,
  };
}
