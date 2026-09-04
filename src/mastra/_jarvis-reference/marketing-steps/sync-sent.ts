import { BaseAgent as Agent } from '../../../core/base-agent.js'
import { GmailService } from '@af/google'
import { isValidEmail } from '@af/shared'

export class SyncSentStep {
  constructor(private agent: Agent) {}

  async run(params: { taskId: string }): Promise<{ updatedCount: number }> {
    const { taskId } = params
    
    await this.agent.log('info', 'Rozpoczynam synchronizację statusów z folderem "Wysłane"...', {}, taskId)
    
    const gmail = await GmailService.create()
    const crm = await this.agent.getCRM()
    
    // 1. Pobieramy leady, które czekają na wysłanie
    const leadsWaiting = await crm.queryLeads({ status: 'draft_gotowy' })
    if (leadsWaiting.length === 0) {
      await this.agent.log('info', 'Brak leadów o statusie "draft_gotowy" do synchronizacji.', {}, taskId)
      return { updatedCount: 0 }
    }
    
    // 2. Pobieramy ostatnie wysłane wiadomości (np. z ostatnich 7 dni)
    // Gmail query: 'in:sent after:YYYY/MM/DD'
    const sevenDaysAgo = new Date()
    sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7)
    const afterDate = `${sevenDaysAgo.getFullYear()}/${(sevenDaysAgo.getMonth() + 1).toString().padStart(2, '0')}/${sevenDaysAgo.getDate().toString().padStart(2, '0')}`
    
    const sentThreads = await gmail.searchThreads(`in:sent after:${afterDate}`, 50)
    
    // 3. Wyciągamy adresy email, do których wysłaliśmy wiadomości
    const sentEmails = new Set<string>()
    for (const threadInfo of sentThreads) {
      if (!threadInfo.id) continue
      const thread = await gmail.getThreadAsContext(threadInfo.id)
      for (const msg of thread.messages) {
        // Interesują nas adresy do których wysłaliśmy
        if (msg.to) {
          const emailMatch = msg.to.match(/<(.+)>|(\S+@\S+)/)
          const email = (emailMatch?.[0] || msg.to).replace(/[<>]/g, '').trim()
          if (email) sentEmails.add(email)
        }
      }
    }
    
    // 4. Aktualizujemy CRM
    const matchedEmails = leadsWaiting
      .map(l => l.email)
      .filter((email): email is string => isValidEmail(email) && sentEmails.has(email))
      
    const updatedCount = await crm.markAsSent(matchedEmails, this.agent.config.agentId)
    
    await this.agent.log('info', `Synchronizacja zakończona. Zaktualizowano status ${updatedCount} leadów na "sent".`, {
      matchedEmails
    }, taskId)
    
    return { updatedCount }
  }
}
