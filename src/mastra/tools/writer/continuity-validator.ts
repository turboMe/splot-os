export interface WriterContinuityCharacter {
  id?: string;
  name: string;
  aliases?: string[];
  status?: 'alive' | 'dead' | 'missing' | 'unknown' | string;
  lastSeenSectionId?: string;
  deathSectionId?: string;
  notes?: string;
}

export interface WriterContinuityPromise {
  id: string;
  text: string;
  status: 'open' | 'paid_off' | 'dropped' | string;
  setupSectionId?: string;
  payoffSectionId?: string;
  setupOrder?: number;
  payoffOrder?: number;
}

export interface WriterContinuityQuestion {
  id: string;
  text: string;
  status: 'open' | 'answered' | 'dropped' | string;
  openedSectionId?: string;
  answeredSectionId?: string;
  openedOrder?: number;
  answeredOrder?: number;
}

export interface WriterTimelineEvent {
  id?: string;
  label: string;
  order?: number;
  date?: string;
  sectionId?: string;
}

export interface WriterContinuityState {
  projectId?: string;
  characters?: WriterContinuityCharacter[];
  timeline?: WriterTimelineEvent[];
  promises?: WriterContinuityPromise[];
  questions?: WriterContinuityQuestion[];
  glossary?: Array<{ term: string; definition: string }>;
  updatedAt?: Date;
}

export interface ContinuitySection {
  id: string;
  order: number;
  title?: string;
  content?: string;
  summary?: string;
}

export interface ContinuityIssue {
  code:
    | 'dead_character_present'
    | 'payoff_before_setup'
    | 'stale_open_promise'
    | 'answer_before_question'
    | 'stale_open_question'
    | 'timeline_conflict'
    | 'glossary_conflict'
    | 'invalid_continuity_record';
  severity: 'low' | 'medium' | 'high' | 'critical';
  message: string;
  entityId?: string;
  sectionId?: string;
}

export interface ContinuityValidationResult {
  ok: boolean;
  issues: ContinuityIssue[];
  criticalCount: number;
  highCount: number;
}

export interface ContinuityValidationOptions {
  maxOpenPromiseLag?: number;
  maxOpenQuestionLag?: number;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function normalize(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim();
}

function safeArray<T>(value: T[] | undefined): T[] {
  return Array.isArray(value) ? value : [];
}

function invalidRecord(entity: string, index: number, message: string): ContinuityIssue {
  return {
    code: 'invalid_continuity_record',
    severity: 'high',
    message: `Invalid ${entity} continuity record at index ${index}: ${message}`,
    entityId: `${entity}-${index}`,
  };
}

function latestSectionOrder(sections: ContinuitySection[]): number {
  return sections.reduce((max, section) => Math.max(max, section.order), 0);
}

function findSection(sections: ContinuitySection[], sectionId?: string): ContinuitySection | undefined {
  if (!sectionId) return undefined;
  return sections.find((section) => section.id === sectionId);
}

function sectionMentionsName(section: ContinuitySection, names: string[]): boolean {
  const text = normalize(`${section.title ?? ''}\n${section.summary ?? ''}\n${section.content ?? ''}`);
  return names.some((name) => {
    const pattern = new RegExp(`\\b${escapeRegExp(name)}\\b`, 'i');
    return pattern.test(text);
  });
}

function sectionShowsActivePresence(section: ContinuitySection, names: string[]): boolean {
  const text = normalize(`${section.title ?? ''}\n${section.summary ?? ''}\n${section.content ?? ''}`);
  const activeVerbs = [
    'opens?', 'walks?', 'enters?', 'sits?', 'stands?', 'reaches?', 'arrives?', 'returns?',
    'otwiera', 'otworzyl', 'otworzyla', 'wchodzi', 'wszedl', 'weszla', 'idzie', 'poszedl',
    'poszla', 'stoi', 'stal', 'stala', 'siada', 'usiadl', 'usiadla', 'bierze', 'wzial',
    'wziela', 'podchodzi', 'podszedl', 'podeszla', 'wraca', 'wrocil', 'wrocila',
    'przychodzi', 'przyszedl', 'przyszla',
  ].join('|');
  return names.some((name) => {
    const escaped = escapeRegExp(name);
    return new RegExp(`\\b${escaped}\\b(?:\\s+\\p{L}+){0,2}\\s+(?:${activeVerbs})\\b`, 'iu').test(text);
  });
}

function validateCharacters(state: WriterContinuityState, sections: ContinuitySection[]): ContinuityIssue[] {
  const issues: ContinuityIssue[] = [];
  for (const [index, character] of safeArray(state.characters).entries()) {
    if (!character || typeof character.name !== 'string' || !character.name.trim()) {
      issues.push(invalidRecord('character', index, 'name is required.'));
      continue;
    }
    if (character.status !== 'dead') continue;
    // `status: dead` often describes a person who died before the story (the
    // live canary's father, whose letters and memories drive every chapter).
    // Without an in-story death section there is no temporal boundary after
    // which physical presence can be evaluated.
    if (!character.deathSectionId) continue;
    const deathSection = findSection(sections, character.deathSectionId);
    if (!deathSection) {
      issues.push(invalidRecord(
        'character',
        index,
        `deathSectionId "${character.deathSectionId}" does not match a writer section.`,
      ));
      continue;
    }
    const names = [character.name, ...(character.aliases ?? [])].map(normalize).filter(Boolean);
    if (names.length === 0) continue;

    for (const section of sections) {
      if (section.order <= deathSection.order) continue;
      if (!sectionMentionsName(section, names)) continue;
      const content = normalize(`${section.summary ?? ''}\n${section.content ?? ''}`);
      if (/\b(memory|dream|flashback|wspomnienie|sen)\b/.test(content)) continue;
      if (!sectionShowsActivePresence(section, names)) continue;
      issues.push({
        code: 'dead_character_present',
        severity: 'critical',
        message: `Dead character "${character.name}" appears after their death without an explicit memory/dream/flashback context.`,
        entityId: character.id ?? character.name,
        sectionId: section.id,
      });
    }
  }
  return issues;
}

function validatePromises(
  state: WriterContinuityState,
  sections: ContinuitySection[],
  options: ContinuityValidationOptions,
): ContinuityIssue[] {
  const issues: ContinuityIssue[] = [];
  const currentOrder = latestSectionOrder(sections);
  const maxLag = options.maxOpenPromiseLag ?? 4;

  for (const [index, promise] of safeArray(state.promises).entries()) {
    if (
      !promise ||
      typeof promise.id !== 'string' || !promise.id.trim() ||
      typeof promise.text !== 'string' || !promise.text.trim() ||
      !['open', 'paid_off', 'dropped'].includes(promise.status)
    ) {
      issues.push(invalidRecord('promise', index, 'id, text, and status=open|paid_off|dropped are required.'));
      continue;
    }
    const setupOrder = promise.setupOrder ?? findSection(sections, promise.setupSectionId)?.order;
    const payoffOrder = promise.payoffOrder ?? findSection(sections, promise.payoffSectionId)?.order;

    if (promise.status === 'paid_off' && setupOrder !== undefined && payoffOrder !== undefined && payoffOrder < setupOrder) {
      issues.push({
        code: 'payoff_before_setup',
        severity: 'high',
        message: `Promise "${promise.text}" is paid off before it is set up.`,
        entityId: promise.id,
        sectionId: promise.payoffSectionId,
      });
    }

    if (promise.status === 'open' && setupOrder !== undefined && currentOrder - setupOrder > maxLag) {
      issues.push({
        code: 'stale_open_promise',
        severity: 'medium',
        message: `Promise "${promise.text}" has stayed open for more than ${maxLag} sections.`,
        entityId: promise.id,
        sectionId: promise.setupSectionId,
      });
    }
  }

  return issues;
}

function validateQuestions(
  state: WriterContinuityState,
  sections: ContinuitySection[],
  options: ContinuityValidationOptions,
): ContinuityIssue[] {
  const issues: ContinuityIssue[] = [];
  const currentOrder = latestSectionOrder(sections);
  const maxLag = options.maxOpenQuestionLag ?? 4;

  for (const [index, question] of safeArray(state.questions).entries()) {
    if (
      !question ||
      typeof question.id !== 'string' || !question.id.trim() ||
      typeof question.text !== 'string' || !question.text.trim() ||
      !['open', 'answered', 'dropped'].includes(question.status)
    ) {
      issues.push(invalidRecord('question', index, 'id, text, and status=open|answered|dropped are required.'));
      continue;
    }
    const openedOrder = question.openedOrder ?? findSection(sections, question.openedSectionId)?.order;
    const answeredOrder = question.answeredOrder ?? findSection(sections, question.answeredSectionId)?.order;

    if (question.status === 'answered' && openedOrder !== undefined && answeredOrder !== undefined && answeredOrder < openedOrder) {
      issues.push({
        code: 'answer_before_question',
        severity: 'high',
        message: `Question "${question.text}" is answered before it is opened.`,
        entityId: question.id,
        sectionId: question.answeredSectionId,
      });
    }

    if (question.status === 'open' && openedOrder !== undefined && currentOrder - openedOrder > maxLag) {
      issues.push({
        code: 'stale_open_question',
        severity: 'medium',
        message: `Question "${question.text}" has stayed open for more than ${maxLag} sections.`,
        entityId: question.id,
        sectionId: question.openedSectionId,
      });
    }
  }

  return issues;
}

function validateTimeline(state: WriterContinuityState): ContinuityIssue[] {
  const issues: ContinuityIssue[] = [];
  const byId = new Map<string, WriterTimelineEvent>();
  const byLabel = new Map<string, WriterTimelineEvent>();

  for (const [index, event] of safeArray(state.timeline).entries()) {
    if (!event || typeof event.label !== 'string' || !event.label.trim()) {
      issues.push(invalidRecord('timeline', index, 'label is required.'));
      continue;
    }
    if (event.id) {
      const existing = byId.get(event.id);
      if (existing && (existing.date !== event.date || existing.order !== event.order)) {
        issues.push({
          code: 'timeline_conflict',
          severity: 'high',
          message: `Timeline event "${event.id}" has conflicting date/order values.`,
          entityId: event.id,
          sectionId: event.sectionId,
        });
      }
      byId.set(event.id, event);
    }

    const labelKey = normalize(event.label);
    const existingByLabel = byLabel.get(labelKey);
    if (existingByLabel && existingByLabel.date && event.date && existingByLabel.date !== event.date) {
      issues.push({
        code: 'timeline_conflict',
        severity: 'medium',
        message: `Timeline label "${event.label}" appears with multiple dates.`,
        entityId: event.id ?? event.label,
        sectionId: event.sectionId,
      });
    }
    byLabel.set(labelKey, event);
  }

  return issues;
}

function validateGlossary(state: WriterContinuityState): ContinuityIssue[] {
  const issues: ContinuityIssue[] = [];
  const definitions = new Map<string, string>();

  for (const [index, entry] of safeArray(state.glossary).entries()) {
    if (
      !entry ||
      typeof entry.term !== 'string' || !entry.term.trim() ||
      typeof entry.definition !== 'string' || !entry.definition.trim()
    ) {
      issues.push(invalidRecord('glossary', index, 'term and definition are required.'));
      continue;
    }
    const key = normalize(entry.term);
    const definition = normalize(entry.definition);
    const existing = definitions.get(key);
    if (existing && existing !== definition) {
      issues.push({
        code: 'glossary_conflict',
        severity: 'medium',
        message: `Glossary term "${entry.term}" has conflicting definitions.`,
        entityId: entry.term,
      });
    }
    definitions.set(key, definition);
  }

  return issues;
}

export function validateContinuity(
  state: WriterContinuityState,
  sections: ContinuitySection[] = [],
  options: ContinuityValidationOptions = {},
): ContinuityValidationResult {
  const fields: Array<keyof Pick<WriterContinuityState, 'characters' | 'timeline' | 'promises' | 'questions' | 'glossary'>> = [
    'characters',
    'timeline',
    'promises',
    'questions',
    'glossary',
  ];
  const shapeIssues = fields.flatMap((field) => {
    const value = state[field];
    if (value === undefined || Array.isArray(value)) return [];
    return [invalidRecord(field, 0, 'the field must be an array.')];
  });
  const issues = [
    ...shapeIssues,
    ...validateCharacters(state, sections),
    ...validatePromises(state, sections, options),
    ...validateQuestions(state, sections, options),
    ...validateTimeline(state),
    ...validateGlossary(state),
  ];

  const criticalCount = issues.filter((issue) => issue.severity === 'critical').length;
  const highCount = issues.filter((issue) => issue.severity === 'high').length;

  return {
    ok: criticalCount === 0 && highCount === 0,
    issues,
    criticalCount,
    highCount,
  };
}
