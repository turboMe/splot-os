import { BaseAgent as Agent } from '../../../core/base-agent.js'
import { NotebookLMClient } from '@af/notebooklm'
import { SearchService } from '@af/search'
import { DiscoveredLeadsResponseSchema, isValidEmail, repairJSON } from '@af/shared'

export interface OutreachLead {
  company: string
  email?: string
  website?: string
  reason?: string
}

export interface ValidOutreachLead extends OutreachLead {
  email: string
}

export interface ResearchOnlyLead extends OutreachLead {
  website: string
}

export interface OutreachResult {
  validLeads: ValidOutreachLead[]
  researchOnlyLeads: ResearchOnlyLead[]
  invalidLeads: OutreachLead[]
  totalDiscovered: number
}

export class OutreachStep {
  constructor(private agent: Agent) {}
  async run(params: {
    region: string
    count: number
    productType?: string
    taskId: string
  }): Promise<OutreachResult> {
    const { region, count, productType, taskId } = params

    // 1. Zbieranie informacji z NotebookLM (Zgodnie z prototypem)
    const nlm = new NotebookLMClient()
    let rhdContext = "Zasady RHD pozwalają na sprzedaż bezpośrednią do restauracji na terenie całego kraju (produkty roślinne) lub w województwie i przyległych (produkty zwierzęce)."
    let marketContext = "Ceny hurtowe spadają, a restauracje szukają dostawców bez pośredników."

    try {
      await this.agent.log('info', `Uruchamiam zapytania do NotebookLM dla ${region}...`, {}, taskId)
      
      const rhdRes = await nlm.query({
        notebook: 'rhd',
        question: `Jakie są zasady RHD (Rolniczy Handel Detaliczny) dla producentów w województwie ${region}? Jakie produkty mogą sprzedawać do restauracji?`
      })
      rhdContext = rhdRes.answer

      const marketRes = await nlm.query({
        notebook: 'rynek',
        question: `Jakie są aktualne ceny skupu i trendy dla produktów typu: ${productType ?? 'warzywa, sery, mięso'} w regionie ${region}?`
      })
      marketContext = marketRes.answer
      
      await this.agent.log('info', `Pobrano dane z NotebookLM: RHD i trendy rynkowe.`, {}, taskId)
    } catch (e) {
      await this.agent.log('warn', `Nie udało się połączyć z NotebookLM (używam fallback context): ${(e as Error).message}`, {}, taskId)
    }

    // 2. Pobieranie istniejących leadów z CRM (Blacklist)
    const crm = await this.agent.getCRM()
    const existingLeads = await crm.queryLeads({ region, segment: 'producer' })
    const blacklist = existingLeads.map(l => `${l.companyName} (${l.email})`).join(', ')
    
    await this.agent.log('info', `Pobrano ${existingLeads.length} istniejących leadów z CRM dla regionu ${region}.`, {}, taskId)

    // 3. Odkrywanie leadów przez realny Search (Discovery)
    const search = new SearchService()
    
    const categories = [
      'sery kozie i krowie nabiał rzemieślnicze',
      'mięso wędliny ekologiczne drób',
      'warzywa owoce gospodarstwo rolne',
      'piekarnia rzemieślnicza chleb na zakwasie',
      'tłocznia soków przetwory pasieka miód',
      'site:kujawskopomorskiebazarek.pl producent kontakt'
    ]
    
    let combinedSearchResults: any[] = [];
    
    await this.agent.log('info', `Szukam realnych firm w sieci (multi-search dla kategorii)...`, {}, taskId)
    
    for (const category of categories) {
      const q = `${category} producenci lokalni ${productType ?? ''} ${region} sprzedaż bezpośrednia kontakt email`
      const res = await search.search(q, 6)
      combinedSearchResults.push(...res)
    }

    // Deduplikacja po URL
    const uniqueResults = Array.from(new Map(combinedSearchResults.map(item => [item.url, item])).values());
    await this.agent.log('info', `Pobrano ${uniqueResults.length} unikalnych wyników z wyszukiwarki.`, { count: uniqueResults.length }, taskId)

    // 4. Analiza przez "Notatnik Odkrywcy" (Nowa Logika)
    let discoveredLeads: OutreachLead[] = [];
    let discoveryNotebookId = '';

    try {
      await this.agent.log('info', `Tworzę "Notatnik Odkrywcy" dla dogłębnej analizy wyników...`, {}, taskId)
      discoveryNotebookId = await nlm.createNotebook(`Discovery: Producers ${region}`)

      // Wybieramy top 12 najbardziej obiecujących linków (pominając znane agregatory i social media jeśli mamy lepsze)
      const topUrls = uniqueResults
        .filter(r => !r.url.includes('facebook.com') && !r.url.includes('linkedin.com') && !r.url.includes('instagram.com'))
        .slice(0, 12);

      for (const res of topUrls) {
        try {
          await this.agent.log('info', `Dodaję źródło do analizy: ${res.url.slice(0, 50)}...`, {}, taskId)
          await nlm.addSource({
            notebook: discoveryNotebookId,
            sourceType: 'url',
            url: res.url,
            title: res.title
          })
        } catch (e) {
          await this.agent.log('warn', `Nie udało się dodać źródła ${res.url}: ${(e as Error).message}`, {}, taskId)
        }
      }

      await this.agent.log('info', `NotebookLM przetwarza źródła... Czekam 10s na indeksowanie...`, {}, taskId)
      await new Promise(resolve => setTimeout(resolve, 10000));

      const discoveryQuestion = `Sporządź listę do ${count} lokalnych producentów żywności z województwa ${region} na podstawie załadowanych źródeł.
      
      Pomiń (Blacklist): ${blacklist || 'Brak'}

      Dla każdego producenta przygotuj:
      1. company: Nazwa firmy
      2. email: Adres e-mail (bardzo ważne!)
      3. website: Strona WWW lub profil social media
      4. reason: Krótki opis (1 zdanie) co produkują.

      Ważne: Zwróć odpowiedź wyłącznie w formacie JSON, bez żadnych przypisów, numerów cytowań czy dodatkowego tekstu.
      
      Format:
      { "leads": [{ "company": "...", "email": "...", "website": "...", "reason": "..." }] }`

      const discoveryRes = await nlm.query({
        notebook: discoveryNotebookId,
        question: discoveryQuestion
      })

      await this.agent.log('info', `Otrzymano odpowiedź z NotebookLM. Czyszczę i parsuję...`, { rawLength: discoveryRes.answer.length }, taskId)

      // Czyszczenie odpowiedzi z przypisów NotebookLM (np. [1], [2], dymki unicode)
      let cleanedAnswer = discoveryRes.answer
        .replace(/\[\d+\]/g, '') // Usuwa [1], [2]
        .replace(/\u200B/g, '')  // Usuwa zero-width space
        .replace(/[\u2460-\u2473]/g, '') // Usuwa dymki unicode ①, ②, ③...
        .replace(/\s+/g, ' ')
        .trim();

      try {
        const parsed = repairJSON(cleanedAnswer)
        const candidate = Array.isArray(parsed) ? { leads: parsed } : parsed
        const validation = DiscoveredLeadsResponseSchema.safeParse(candidate)

        if (!validation.success) {
          await this.agent.log('error', `Walidacja odkrytych leadów nie powiodła się.`, {
            issues: validation.error.issues,
            excerpt: discoveryRes.answer.slice(0, 500)
          }, taskId)
        } else {
          discoveredLeads = validation.data.leads
        }
      } catch (e) {
        await this.agent.log('error', `Błąd parsowania JSON z odkrytymi leadami.`, {
          error: (e as Error).message,
          excerpt: discoveryRes.answer.slice(0, 500)
        }, taskId)
      }

    } catch (error) {
      await this.agent.log('error', `Błąd w procesie "Notatnika Odkrywcy": ${(error as Error).message}`, {}, taskId)
    } finally {
      if (discoveryNotebookId) {
        // await nlm.deleteNotebook(discoveryNotebookId).catch(() => {});
        await this.agent.log('info', `DEBUG: Pozostawiono notatnik ${discoveryNotebookId} do analizy.`, {}, taskId)
      }
    }

    // 5. Ostateczne odfiltrowanie i logowanie
    const normalizedLeads = discoveredLeads.map(lead => ({
      company: lead.company.trim(),
      email: lead.email?.trim(),
      website: lead.website?.trim(),
      reason: lead.reason?.trim()
    }))
    const usableLeads = normalizedLeads.filter(lead => lead.company && (lead.email || lead.website))
    const validLeads: ValidOutreachLead[] = usableLeads
      .filter(lead => isValidEmail(lead.email))
      .map(lead => ({ ...lead, email: lead.email!.trim() }))
    const researchOnlyLeads: ResearchOnlyLead[] = usableLeads
      .filter(lead => !isValidEmail(lead.email) && Boolean(lead.website))
      .map(lead => ({ ...lead, website: lead.website!.trim() }))
    const invalidLeads = normalizedLeads.filter(lead => !lead.company || (!lead.email && !lead.website))
    
    await this.agent.log('info', `🎯 Zakończono odkrywanie. Valid email: ${validLeads.length}, missing email: ${researchOnlyLeads.length}.`, {
      validEmailCount: validLeads.length,
      missingEmailCount: researchOnlyLeads.length,
      invalidCount: invalidLeads.length,
      totalDiscovered: discoveredLeads.length
    }, taskId)

    return {
      validLeads,
      researchOnlyLeads,
      invalidLeads,
      totalDiscovered: discoveredLeads.length
    };
  }
}
