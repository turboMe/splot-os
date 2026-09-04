import { BaseAgent as Agent } from '../../../core/base-agent.js'
import { GmailService } from '@af/google'
import { FollowUpResponseSchema, repairJSON } from '@af/shared'

type FollowUpStepResult =
  | { action: 'skip'; reason: string }
  | {
      action: 'draft_created'
      subject: string
      body: string
      _metadata: {
        provider: string
        model: string
        costUsd: number
      }
    }

export class FollowUpStep {
  constructor(private agent: Agent) {}

  async run(params: { 
    lead: { email: string, companyName: string },
    taskId: string 
  }): Promise<FollowUpStepResult> {
    const { lead, taskId } = params
    
    await this.agent.log('info', `Checking for replies from ${lead.email}...`, {}, taskId)
    
    const gmail = await GmailService.create()
    
    // 1. Double check Gmail for ANY replies in the thread
    const threads = await gmail.searchThreads(`to:${lead.email} OR from:${lead.email}`, 1)
    
    if (threads.length > 0 && threads[0].id) {
      const thread = await gmail.getThreadAsContext(threads[0].id)
      const lastMessage = thread.messages[thread.messages.length - 1]
      
      // If the last message is FROM the lead, we shouldn't follow up automatically
      if (lastMessage.from.toLowerCase().includes(lead.email.toLowerCase())) {
        await this.agent.log('info', `Found reply from ${lead.email}. Skipping follow-up.`, {}, taskId)
        return { action: 'skip', reason: 'already_replied' }
      }
    }

    // 2. Generate Follow-up Content
    await this.agent.log('info', `Generating follow-up draft for ${lead.companyName}...`, {}, taskId)
    
    const systemPrompt = `Jesteś asystentem GastroBridge. Twoim zadaniem jest napisanie krótkiego, uprzejmego przypomnienia (follow-up) do producenta żywności.
Pierwszy e-mail został wysłany kilka dni temu. Chcemy tylko zapytać, czy udało się go przeczytać i czy są zainteresowani współpracą w ramach RHD.
Styl: Bardzo krótki, pomocny, nie-sprzedażowy.
Język: polski.`

    const userPrompt = `Firma: ${lead.companyName}
E-mail: ${lead.email}

Napisz tylko temat i treść przypomnienia.
Zwróć JSON: { "subject": "Re: ...", "body": "..." }`

    const response = await this.agent.callLLM('follow-up', {
      systemPrompt,
      userPrompt,
      jsonMode: true,
      temperature: 0.3
    }, taskId)

    let parsedJson: unknown
    try {
      parsedJson = repairJSON(response.text)
    } catch (error) {
      await this.agent.log('warn', 'Follow-up JSON parsing failed; using fallback draft', {
        lead: lead.email,
        error: (error as Error).message,
        excerpt: response.text.slice(0, 2000)
      }, taskId)
      const fallback = this.createFallbackFollowUp(lead.companyName)
      return {
        action: 'draft_created',
        ...fallback,
        _metadata: {
          provider: response.provider,
          model: response.model,
          costUsd: response.costUsd
        }
      }
    }

    const validation = FollowUpResponseSchema.safeParse(parsedJson)
    if (!validation.success) {
      await this.agent.log('warn', 'Follow-up response validation failed; using fallback draft', {
        lead: lead.email,
        issues: validation.error.issues,
        excerpt: response.text.slice(0, 2000)
      }, taskId)
      const fallback = this.createFallbackFollowUp(lead.companyName)
      return {
        action: 'draft_created',
        ...fallback,
        _metadata: {
          provider: response.provider,
          model: response.model,
          costUsd: response.costUsd
        }
      }
    }

    const parsed = validation.data
    return {
      action: 'draft_created',
      subject: parsed.subject,
      body: parsed.body,
      _metadata: {
        provider: response.provider,
        model: response.model,
        costUsd: response.costUsd
      }
    }
  }

  private createFallbackFollowUp(companyName: string): { subject: string; body: string } {
    return {
      subject: `Re: GastroBridge x ${companyName}`,
      body: [
        'Dzien dobry,',
        '',
        'chcialem krotko wrocic do poprzedniej wiadomosci i zapytac, czy temat wspolpracy z GastroBridge jest dla Panstwa aktualny.',
        '',
        'Jesli tak, chetnie umowie krotka rozmowe i sprawdze, czy mozemy realnie pomoc w dotarciu do restauracji oraz punktow HoReCa.',
        '',
        'Pozdrawiam,',
        'GastroBridge'
      ].join('\n')
    }
  }
}
