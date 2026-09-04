import { BaseAgent as Agent } from '../../../core/base-agent.js'
import { GmailService, CalendarService } from '@af/google'
import { format } from 'date-fns'
import { CRM_STATUSES, repairJSON } from '@af/shared'

function isKnownCrmStatus(value: unknown): value is typeof CRM_STATUSES[number] {
  return typeof value === 'string' && (CRM_STATUSES as readonly string[]).includes(value)
}

export class EmailCheckStep {
  constructor(private agent: Agent) {}
  async run(params: { taskId: string }): Promise<any> {
    const { taskId } = params
    
    await this.agent.log('info', 'Połączenie z Gmail API...', {}, taskId)
    const gmail = await GmailService.create()
    
    // Szukamy nieprzeczytanych maili (tylko w INBOX, bez spamu)
    // Pobieramy do 20 najnowszych nieprzeczytanych wątków
    const threads = await gmail.searchThreads('is:unread in:inbox', 20)
    
    await this.agent.log('info', `Znaleziono ${threads.length} nowych, nieprzeczytanych wątków.`, {}, taskId)
    
    const results = []
    const crm = await this.agent.getCRM()
    const memoryService = await this.agent.getMemory()

    for (const threadInfo of threads) {
      if (!threadInfo.id) continue
      
      try {
        const thread = await gmail.getThreadAsContext(threadInfo.id)
        await this.agent.log('info', `Analizuję wątek: "${thread.subject}"`, {}, taskId)

        // Pobieramy nadawcę ostatniej wiadomości, aby sprawdzić go w CRM
        const lastMessage = thread.messages[thread.messages.length - 1]
        const senderEmail = lastMessage.from.match(/<(.+)>|(\S+@\S+)/)?.[0]?.replace(/[<>]/g, '') || lastMessage.from
        
        const lead = await crm.getByEmail(senderEmail)
        const leadContext = lead 
          ? `HISTORIA CRM DLA ${senderEmail}:\nStatus: ${lead.status}\nOstatnia interakcja: ${lead.lastInteractionAt.toISOString()}\nHistoria:\n${lead.history.slice(-3).map(h => `- ${h.timestamp.toISOString()}: ${h.action} - ${h.description}`).join('\n')}`
          : `HISTORIA CRM DLA ${senderEmail}: Brak danych w CRM (nowy kontakt).`

        // Spłaszczamy wiadomości do promptu
        const conversation = thread.messages.map(m => `OD: ${m.from}\nDO: ${m.to}\nDATA: ${m.date.toISOString()}\nTREŚĆ:\n${m.body}`).join('\n---\n')
        
        const systemPrompt = `
Jesteś asystentem AI ds. komunikacji dla firmy GastroBridge (B2B food marketplace).
Twoim celem jest analiza emaili i aktualizacja bazy CRM oraz Pamięci Agenta.

Oto Twoje zadania:
1. Zdecyduj o akcji: "ignore", "draft_reply" lub "notify".
2. Zaktualizuj CRM: Zdecyduj, czy status leada powinien się zmienić (np. z "draft_gotowy" na "odpowiedział" lub "opt-out").
3. Wyciągnij wnioski (Memory): Jeśli w mailu jest ważna informacja biznesowa (np. "rolnicy wolą X", "ceny w regionie Y spadły"), zapisz to jako "memoryEntry".
4. Wykryj intencję kalendarzową: Jeśli nadawca proponuje spotkanie, chce przełożyć termin lub odwołać rozmowę.

**Statusy CRM:**
- "odpowiedział" - ogólna odpowiedź
- "zainteresowany" - wyraźne zainteresowanie ofertą
- "opt-out" - prośba o zaprzestanie kontaktu
- "aktywny_klient" - chce założyć konto lub już używa

**Wykrywanie spotkań (Calendar Intent):**
Jeśli wykryjesz propozycję spotkania, zwróć obiekt "calendarIntent" z operacją "create". 
Jeśli nadawca rezygnuje ze spotkania, użyj operacji "cancel".

Przygotuj odpowiedź po Polsku, uprzejmą i profesjonalną.
`

        const userPrompt = `
KONTEKST CZASOWY:
- Twój aktualny czas (Islandia/UTC): ${new Date().toLocaleString('pl-PL', { timeZone: 'Atlantic/Reykjavik' })}
- Czas biznesowy (Warszawa): ${new Date().toLocaleString('pl-PL', { timeZone: 'Europe/Warsaw' })}

UWAGA: Jeśli email jest od polskiego producenta/kontrahenta, załóż że podany przez niego termin (np. "środa o 10:00") dotyczy czasu w Warszawie.

KONTEKST CRM:
${leadContext}

WĄTEK EMAIL:
Temat: ${thread.subject}
${conversation}

Jaka jest Twoja decyzja? Zwróć JEDYNIE obiekt JSON:
{
  "action": "ignore" | "draft_reply" | "notify",
  "reason": "dlaczego taka decyzja",
  "draftBody": "treść odpowiedzi (jeśli draft_reply)",
  "crmAction": {
    "newStatus": "opcjonalny nowy status",
    "note": "krótka notatka do historii"
  },
  "memoryEntry": {
    "type": "learning" | "decision" | "rule",
    "topic": "temat wniosku",
    "content": "treść wniosku biznesowego"
  },
  "calendarIntent": {
    "operation": "create" | "cancel" | "update" | "none",
    "suggestedDate": "ISO date string z odpowiednim offsetem (np. +02:00 dla czasu Warszawskiego)",
    "summary": "cel spotkania",
    "company": "nazwa firmy",
    "contactName": "imię i nazwisko",
    "email": "email kontaktowy",
    "phone": "telefon (jeśli podano)"
  }
}`

        const response = await this.agent.callLLM(
          'email-check',
          { systemPrompt, userPrompt, jsonMode: true, temperature: 0.2 },
          taskId
        )
        
        const parsed = repairJSON(response.text)
        
        await this.agent.log('info', `Decyzja LLM: ${parsed.action} - ${parsed.reason}`, {}, taskId)
        
        if (parsed.action === 'draft_reply' && parsed.draftBody) {
          // Dodajemy draft do Gmaila
          const lastMessage = thread.messages[thread.messages.length - 1]
          // Odpowiadamy do nadawcy ostatniej wiadomości
          const to = lastMessage.from
          
          const draftId = await gmail.createDraftReply({
            threadId: threadInfo.id,
            to,
            subject: thread.subject.startsWith('Re:') ? thread.subject : `Re: ${thread.subject}`,
            body: parsed.draftBody
          })
          
          await this.agent.log('info', `Stworzono draft odpowiedzi w Gmailu! Draft ID: ${draftId}`, {}, taskId)
          
          results.push({
            threadId: threadInfo.id,
            subject: thread.subject,
            action: parsed.action,
            reason: parsed.reason,
            draftId
          })
        } else {
          results.push({
            threadId: threadInfo.id,
            subject: thread.subject,
            action: parsed.action,
            reason: parsed.reason
          })
        }

        // 1. Obsługa aktualizacji CRM
        if (parsed.crmAction) {
          const { newStatus, note } = parsed.crmAction;
          if (newStatus || note) {
            const safeStatus = isKnownCrmStatus(newStatus) ? newStatus : undefined
            if (newStatus && !safeStatus) {
              await this.agent.log('warn', `LLM zwrócił nieznany status CRM: ${newStatus}`, {
                allowedFallback: lead?.status || 'odpowiedział'
              }, taskId)
            }
            await crm.upsertLead({ 
              email: senderEmail, 
              status: safeStatus || lead?.status || 'odpowiedział' 
            });
            await crm.addInteraction(senderEmail, {
              action: safeStatus ? 'status_updated' : 'email_received',
              description: note || `Przetworzono wiadomość: ${thread.subject}`,
              agentId: this.agent.config.agentId
            });
            await this.agent.log('info', `CRM update for ${senderEmail}: status=${safeStatus || 'unchanged'}`, {}, taskId);
          }
        }

        // 2. Obsługa nowej wiedzy (Memory)
        if (parsed.memoryEntry && parsed.memoryEntry.content) {
          const m = parsed.memoryEntry;
          const mId = await memoryService.addEntry({
            type: m.type || 'learning',
            topic: m.topic || 'Analiza email',
            content: m.content,
            sourceTaskId: taskId
          });
          await this.agent.log('info', `New memory entry saved: ${m.topic} (ID: ${mId})`, {}, taskId);
        }

        // Obsługa intencji kalendarzowej
        if (parsed.calendarIntent && parsed.calendarIntent.operation && parsed.calendarIntent.operation !== 'none') {
          await this.agent.log('info', `Wykryto intencję kalendarzową: ${parsed.calendarIntent.operation}`, parsed.calendarIntent, taskId)
          try {
            const calendar = await CalendarService.create()
            const intent = parsed.calendarIntent

            const eventTitle = `[AgentForge] Wstępna propozycja spotkania - ${intent.company || intent.contactName || 'Klient'}`
            const eventDesc = `Cel spotkania:\n${intent.summary || 'Brak opisu'}\n\nOsoba: ${intent.contactName || 'Nieznana'}\nEmail: ${intent.email || 'Brak'}\nTelefon: ${intent.phone || 'Brak'}\nFirma: ${intent.company || 'Brak'}`

            if (intent.operation === 'create') {
              const dateStr = intent.suggestedDate
              if (dateStr && !isNaN(new Date(dateStr).getTime())) {
                const eventId = await calendar.createEvent({
                  title: eventTitle,
                  description: eventDesc,
                  start: new Date(dateStr)
                })
                await this.agent.log('info', `Utworzono wydarzenie w kalendarzu! ID: ${eventId}`, {}, taskId)
              } else {
                await this.agent.log('warn', `Wykryto intencję spotkania, ale data jest nieprawidłowa: ${dateStr}`, {}, taskId)
              }
            } else if (intent.operation === 'cancel') {
              const events = await calendar.findEventByQuery(intent.email || intent.company)
              if (events.length > 0) {
                await calendar.deleteEvent(events[0].id!)
                await this.agent.log('info', `Anulowano wydarzenie z: ${intent.email}`, {}, taskId)
              }
            } else if (intent.operation === 'update') {
              // 1. Znajdź i usuń stary termin
              const events = await calendar.findEventByQuery(intent.email || intent.company)
              if (events.length > 0) {
                await calendar.deleteEvent(events[0].id!)
                await this.agent.log('info', `Usunięto stary termin dla: ${intent.email}`, {}, taskId)
              }
              // 2. Utwórz nowy termin
              const dateStr = intent.suggestedDate
              if (dateStr && !isNaN(new Date(dateStr).getTime())) {
                const eventId = await calendar.createEvent({
                  title: eventTitle,
                  description: eventDesc,
                  start: new Date(dateStr)
                })
                await this.agent.log('info', `Utworzono NOWY (przełożony) termin w kalendarzu! ID: ${eventId}`, {}, taskId)
              }
            }
          } catch (calErr) {
            await this.agent.log('error', `Błąd operacji kalendarzowej: ${(calErr as Error).message}`, {}, taskId)
          }
        }

        // Oznaczamy wątek jako przeczytany
        await gmail.removeLabel(threadInfo.id, ['UNREAD'])
        await this.agent.log('info', `Wątek oznaczony jako przeczytany.`, {}, taskId)
      } catch (err) {
        await this.agent.log('error', `Błąd podczas przetwarzania wątku ${threadInfo.id}: ${(err as Error).message}`, {}, taskId)
      }
    }




    return results
  }
}
