import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { BaseAgent as Agent } from '../../../core/base-agent.js'
import { repairJSON } from '@af/shared'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const PROMPT_PATH = path.join(__dirname, '..', 'prompts', 'copy-pl.md')

export class CopyPlStep {
  constructor(private agent: Agent) {}

  async run(opts: {
    research: {
      newsHooks: Array<{ topic: string; hook: string; data: string; source: string; bestFor: string }>
      competitorMoves: Array<{ competitor: string; move: string; ourAngle: string }>
    }
    linkedinCount: number
    instagramCount: number
    taskId: string
  }): Promise<{
    linkedin: Array<{
      account: string; topic: string; post: string; hashtags: string[];
      char_count: number; rationale: string; suggestedDay: string;
      suggestedTime: string; needsImage: boolean; imagePrompt: string
    }>
    instagram: Array<{
      type: string; topic: string; caption: string; hashtags: string[];
      char_count: number; rationale: string; suggestedDay: string;
      suggestedTime: string; imagePrompt: string; slideCount: number
    }>
  } & { _metadata?: any }> {
    await this.agent.log('info', 'CopyPlStep starting', {
      linkedinCount: opts.linkedinCount,
      instagramCount: opts.instagramCount
    }, opts.taskId)

    const systemPrompt = await fs.readFile(PROMPT_PATH, 'utf-8')

    const result = await this.agent.callLLM('copy-pl', {
      systemPrompt,
      userPrompt: `Na podstawie researchu, wygeneruj:
- ${opts.linkedinCount} postów LinkedIn (mix konto osobiste i firmowe)
- ${opts.instagramCount} treści Instagram (mix: post, karuzela, story)

## Research data:
### News hooks:
${opts.research.newsHooks.map((h, i) => `${i + 1}. [${h.bestFor}] ${h.topic}: ${h.hook} (dane: ${h.data}, źródło: ${h.source})`).join('\n')}

### Ruchy konkurencji:
${opts.research.competitorMoves.map(c => `- ${c.competitor}: ${c.move} → nasz angle: ${c.ourAngle}`).join('\n') || 'Brak danych o konkurencji'}

## Ważne:
- Rotuj formaty: data insight, story from kitchen, building in public, customer spotlight
- LinkedIn osobiste: Wtorek/Czwartek 10:00
- LinkedIn firmowe: Poniedziałek/Środa/Piątek 10:00
- Instagram feed: 12:00-13:00 lub 18:00-20:00
- Każdy post MUSI mieć unikalny temat (nie powtarzaj)

Zwróć JSON z kluczami "linkedin" i "instagram".`,
      jsonMode: true,
      temperature: 0.4,
      maxTokens: 8192
    }, opts.taskId)

    await this.agent.log('info', 'CopyPlStep complete', {
      tokens: result.tokensIn + result.tokensOut,
      cost: result.costUsd
    }, opts.taskId)

    try {
      const parsed = repairJSON(result.text)
      return {
        ...parsed,
        _metadata: {
          provider: result.provider,
          model: result.model,
          costUsd: result.costUsd
        }
      }
    } catch (e) {
      await this.agent.log('error', 'CopyPlStep JSON parse failed', { text: result.text.slice(0, 500), error: (e as Error).message }, opts.taskId)
      return { linkedin: [], instagram: [] }
    }
  }
}
