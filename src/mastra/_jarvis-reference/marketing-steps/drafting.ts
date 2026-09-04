import { BaseAgent as Agent } from '../../../core/base-agent.js'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { EnrichedLeadData } from './enrichment.js'
import { EmailDraftResponseSchema, repairJSON } from '@af/shared'

const __dirname = dirname(fileURLToPath(import.meta.url))

export class EmailDraftingStep {
  constructor(private agent: Agent) {}

  async run(params: {
    lead: { company: string, email: string, reason?: string },
    enriched: EnrichedLeadData,
    taskId: string
  }): Promise<{ subject: string, body: string, _metadata?: any }> {
    const { lead, enriched, taskId } = params
    const reason = lead.reason ?? 'Firma pasuje do segmentu lokalnych producentów żywności.'

    const promptPath = join(__dirname, '../prompts/cold-email-draft.md')
    const systemPrompt = readFileSync(promptPath, 'utf8')
    
    const userPrompt = `
Przygotuj spersonalizowany cold-email do firmy: ${lead.company}.

DANE O FIRMIE (Z RESEARCHU):
- Strona WWW: ${enriched.website || 'nieznana'}
- LinkedIn: ${enriched.linkedIn || 'nieznany'}
- Analiza produktów/USP: ${enriched.rawAnalysis}

POWÓD KONTAKTU:
${reason}

WYTYCZNE:
1. Użyj danych z researchu (np. wspomnij o konkretnym produkcie lub cechę USP firmy), aby pokazać, że znamy ich profil.
2. Zaproponuj współpracę z GastroBridge, podkreślając korzyści płynące z RHD (Rolniczy Handel Detaliczny).
3. Styl: Profesjonalny, ale bezpośredni i budujący relację.
4. Język: polski.

Zwróć JSON: { "subject": "...", "body": "..." }
`

    const response = await this.agent.callLLM('email-drafting', {
      systemPrompt,
      userPrompt,
      jsonMode: true,
      temperature: 0.3
    }, taskId)

    const parsed = await this.parseDraftResponse({
      leadCompany: lead.company,
      responseText: response.text,
      taskId,
      originalPrompt: { userPrompt }
    })

    return {
      ...parsed,
      _metadata: {
        provider: response.provider,
        model: response.model,
        costUsd: response.costUsd,
        tokensIn: response.tokensIn,
        tokensOut: response.tokensOut
      }
    }
  }

  private async parseDraftResponse(params: {
    leadCompany: string
    responseText: string
    taskId: string
    originalPrompt: { userPrompt: string }
  }): Promise<{ subject: string; body: string }> {
    const parsed = await this.tryParseDraft(params.responseText, params)
    if (parsed) return parsed

    try {
      const repair = await this.agent.callLLM('email-drafting-repair', {
        systemPrompt: 'Napraw odpowiedz do poprawnego JSON. Zwroc wylacznie: { "subject": "...", "body": "..." }. Nie dodawaj markdown.',
        userPrompt: [
          'Kontekst oryginalnego zadania:',
          params.originalPrompt.userPrompt,
          '',
          'Niepoprawna odpowiedz do naprawy:',
          params.responseText
        ].join('\n'),
        jsonMode: true,
        temperature: 0,
        maxTokens: 2500
      }, params.taskId)

      const repaired = await this.tryParseDraft(repair.text, {
        leadCompany: params.leadCompany,
        taskId: params.taskId,
        repairAttempt: true
      })
      if (repaired) return repaired
    } catch (error) {
      await this.agent.log('warn', 'Email draft JSON repair call failed', {
        company: params.leadCompany,
        error: (error as Error).message
      }, params.taskId)
    }

    const fallback = this.createFallbackDraft(params.leadCompany)
    await this.agent.log('error', 'Email draft JSON parsing failed; using fallback draft', {
      company: params.leadCompany,
      excerpt: params.responseText.slice(0, 2000)
    }, params.taskId)
    return fallback
  }

  private async tryParseDraft(paramsText: string, params: {
    leadCompany: string
    taskId: string
    repairAttempt?: boolean
  }): Promise<{ subject: string; body: string } | null> {
    let parsedJson: unknown
    try {
      parsedJson = repairJSON(paramsText)
    } catch (error) {
      await this.agent.log(params.repairAttempt ? 'error' : 'warn', 'Email draft JSON parsing failed', {
        company: params.leadCompany,
        error: (error as Error).message,
        responseLength: paramsText.length,
        excerpt: paramsText.slice(0, 2000)
      }, params.taskId)
      return null
    }

    const validation = EmailDraftResponseSchema.safeParse(parsedJson)
    if (!validation.success) {
      await this.agent.log(params.repairAttempt ? 'error' : 'warn', 'Email draft response validation failed', {
        company: params.leadCompany,
        issues: validation.error.issues,
        parsed: parsedJson,
        excerpt: paramsText.slice(0, 2000)
      }, params.taskId)
      return null
    }

    return validation.data
  }

  private createFallbackDraft(company: string): { subject: string; body: string } {
    return {
      subject: `Propozycja wspolpracy - GastroBridge x ${company}`,
      body: [
        'Dzien dobry,',
        '',
        `kontaktuje sie w sprawie potencjalnej wspolpracy z firma ${company}. GastroBridge pomaga lokalnym producentom zywnosci docierac do restauracji i punktow HoReCa, laczac uporzadkowana obsluge zamowien z praktycznym wsparciem sprzedazy.`,
        '',
        'Chetnie krotko sprawdze, czy taki model moglby pasowac do Panstwa oferty i aktualnych kanalow sprzedazy.',
        '',
        'Czy mozemy umowic krotka rozmowe w najblizszych dniach?',
        '',
        'Pozdrawiam,',
        'GastroBridge'
      ].join('\n')
    }
  }
}
