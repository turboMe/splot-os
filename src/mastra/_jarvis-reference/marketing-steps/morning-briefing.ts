import { BaseAgent as Agent } from '../../../core/base-agent.js'
import { subDays } from 'date-fns'

export class MorningBriefingStep {
  constructor(private agent: Agent) {}

  async run(params: { taskId: string }): Promise<string> {
    const { taskId } = params
    const crm = await this.agent.getCRM()
    
    // 1. Statystyki z ostatnich 24h
    const yesterday = subDays(new Date(), 1)
    const activeLeads = await crm.queryLeads({ lastInteractionAt: { $gte: yesterday } })
    const newLeads = activeLeads.filter(l => l.createdAt >= yesterday).length
    const sentCount = activeLeads.filter(l => l.status === 'sent' || l.status === 'wysłany_email_2').length
    
    // 2. Ostatnie wnioski z pamięci
    const memory = await this.agent.getMemory()
    const recentMemory = await memory.findEntries({}) // Pobierzemy kilka najnowszych
    const memorySummary = recentMemory.slice(0, 5).map(m => `- [${m.topic}]: ${m.content}`).join('\n')
    
    // 3. Shared Working Memory (Signals & Context)
    const sharedMemoryPrompt = await this.agent.getSharedMemoryPrompt()

    // 4. Generowanie raportu przez LLM
    const systemPrompt = `Jesteś "Chief Marketing Officer" (CMO) w GastroBridge. Twoim zadaniem jest przygotowanie porannego briefingu dla właściciela.
Raport powinien być profesjonalny, konkretny i motywujący. Skoncentruj się na twardych danych i nowych wnioskach.
Język: polski.`

    const userPrompt = `
PODSUMOWANIE OSTATNICH 24h:
- Nowe leady w CRM: ${newLeads}
- Wysłane e-maile: ${sentCount}
- Aktywne wątki (ostatnie zmiany): ${activeLeads.length}

OSTATNIA WIEDZA AGENTA (WNIOSKI):
${memorySummary || 'Brak nowych wniosków w ostatnim czasie.'}

DODATKOWY KONTEKST SYSTEMOWY (SHARED MEMORY):
${sharedMemoryPrompt || 'Brak aktywnych sygnałów operacyjnych.'}

Przygotuj krótki, punktowany raport Markdown (Morning Briefing). Uwzględnij sekcje: "Działania", "Wnioski", "Sygnały Systemowe" (jeśli są) oraz "Rekomendacja na dziś".
`

    const response = await this.agent.callLLM('morning-briefing', {
      systemPrompt,
      userPrompt,
      temperature: 0.6
    }, taskId)

    return response.text
  }
}
