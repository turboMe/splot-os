import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { BaseAgent as Agent } from '../../../core/base-agent.js'
import { NotebookLMClient } from '@af/notebooklm'
import { repairJSON } from '@af/shared'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const PROMPT_PATH = path.join(__dirname, '..', 'prompts', 'research.md')

export class ResearchStep {
  private nlm: NotebookLMClient

  constructor(
    private agent: Agent,
    nlmClient?: NotebookLMClient
  ) {
    this.nlm = nlmClient ?? new NotebookLMClient()
  }

  async run(opts: {
    weekDate: string
    taskId: string
  }): Promise<{
    newsHooks: Array<{ topic: string; hook: string; data: string; source: string; bestFor: string }>
    competitorMoves: Array<{ competitor: string; move: string; ourAngle: string }>
    sourceCitations: string[]
  }> {
    await this.agent.log('info', 'ResearchStep starting', opts, opts.taskId)

    let marketAnswer = ''
    let marketCitations: string[] = []
    let compAnswer = ''
    let compCitations: string[] = []

    // Try NotebookLM queries (may fail if nlm not configured)
    try {
      const marketResult = await this.nlm.query({
        notebook: 'rynek',
        question: `Jakie są 3 najważniejsze newsy z polskiej branży HoReCa lub rolnictwa w tygodniu ${opts.weekDate}? Skup się na cenach, regulacjach, RHD, lokalnych producentach.`
      })
      marketAnswer = marketResult.answer
      marketCitations = marketResult.citations
    } catch (e) {
      await this.agent.log('warn', 'NotebookLM market query failed, using LLM fallback', { error: (e as Error).message }, opts.taskId)
      marketAnswer = 'Brak danych z NotebookLM - wygeneruj hooks na podstawie ogólnej wiedzy o polskim rynku HoReCa.'
    }

    try {
      const compResult = await this.nlm.query({
        notebook: 'konkurencja',
        question: 'Co Choco, Proky lub inne platformy dostawcze zrobiły w ostatnim tygodniu?'
      })
      compAnswer = compResult.answer
      compCitations = compResult.citations
    } catch (e) {
      await this.agent.log('warn', 'NotebookLM competitor query failed', { error: (e as Error).message }, opts.taskId)
      compAnswer = 'Brak danych o konkurencji z NotebookLM.'
    }

    // LLM synthesis
    const systemPrompt = await fs.readFile(PROMPT_PATH, 'utf-8')

    const synthesis = await this.agent.callLLM('research', {
      systemPrompt,
      userPrompt: `Dane z NotebookLM do analizy:

# PL-Market-Intelligence:
${marketAnswer}

Cytaty: ${marketCitations.join('\n')}

# Competitor-Tracking:
${compAnswer}

Cytaty: ${compCitations.join('\n')}

Tydzień: ${opts.weekDate}

Wybierz 3 najlepsze news hooks i ruchy konkurencji. Zwróć JSON.`,
      jsonMode: true,
      temperature: 0.5
    }, opts.taskId)

    await this.agent.log('info', 'ResearchStep complete', { tokensUsed: synthesis.tokensIn + synthesis.tokensOut }, opts.taskId)

    try {
      return repairJSON(synthesis.text)
    } catch {
      // If JSON parse + repair fails, return structured fallback
      return {
        newsHooks: [{ topic: 'research-fallback', hook: synthesis.text.slice(0, 200), data: '', source: 'LLM', bestFor: 'linkedin-company' }],
        competitorMoves: [],
        sourceCitations: [...marketCitations, ...compCitations]
      }
    }
  }
}
