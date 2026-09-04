import { BaseAgent as Agent } from '../../../core/base-agent.js'
import { SearchService, CompanyInfo } from '@af/search'
import { NotebookLMClient } from '@af/notebooklm'

export interface EnrichedLeadData extends CompanyInfo {
  website?: string;
  linkedIn?: string;
  products: string;
  usp: string;
  personalizationHook: string;
  rawAnalysis: string;
}

export class EnrichmentStep {
  private search: SearchService
  private notebooklm: NotebookLMClient

  constructor(private agent: Agent) {
    this.search = new SearchService()
    this.notebooklm = new NotebookLMClient()
  }

  async run(params: { 
    companyName: string, 
    region: string, 
    taskId: string 
  }): Promise<EnrichedLeadData> {
    const { companyName, region, taskId } = params
    
    await this.agent.log('info', `🔍 Rozpoczynam research dla firmy: ${companyName}...`, {}, taskId)
    
    // 1. Search Phase
    const links = await this.search.findCompanyLinks(companyName, region)
    await this.agent.log('info', `Znalezione linki: ${JSON.stringify(links)}`, {}, taskId)
    
    if (!links.website) {
      await this.agent.log('warn', `Nie znaleziono oficjalnej strony dla ${companyName}. Użyję danych z wyszukiwania ogólnego.`, {}, taskId)
    }

    // 2. Deep Enrichment Phase (Isolated Notebook + Research)
    let analysis = { answer: 'Brak danych do analizy głębokiej.' }
    let tempNotebookId = ''

    try {
      const supportsDeepResearch =
        typeof this.notebooklm.createNotebook === 'function' &&
        typeof this.notebooklm.addSource === 'function' &&
        typeof this.notebooklm.researchStart === 'function' &&
        typeof this.notebooklm.query === 'function'

      if (!supportsDeepResearch) {
        await this.agent.log('warn', 'NotebookLM deep enrichment unavailable; using search fallback', {
          companyName
        }, taskId)
        throw new Error('NotebookLM client does not expose deep enrichment methods')
      }

      // Create isolated environment for this lead
      tempNotebookId = await this.notebooklm.createNotebook(`Research: ${companyName}`)
      await this.agent.log('info', `Stworzono tymczasowy notatnik: ${tempNotebookId}`, {}, taskId)

      // A. Add primary source if found
      if (links.website) {
        await this.agent.log('info', `Dodaję oficjalną stronę: ${links.website}...`, {}, taskId)
        await this.notebooklm.addSource({
          notebook: tempNotebookId,
          sourceType: 'url',
          url: links.website,
          title: `${companyName} (Official)`
        })
      }

      // B. Native NotebookLM Research (Discovery of more sources)
      const searchQuery = `${companyName} ${region} produkty spożywcze opinie nagrody`
      await this.agent.log('info', `Uruchamiam Deep Research dla: "${companyName}"...`, {}, taskId)
      
      await this.notebooklm.researchStart({
        query: searchQuery,
        notebookId: tempNotebookId,
        mode: 'fast',
        autoImport: true
      })

      // C. Comprehensive Query
      const question = `Na podstawie wszystkich zebranych źródeł o firmie ${companyName}, przygotuj szczegółową analizę:
      1. Jakie konkretnie produkty spożywcze produkują/sprzedają?
      2. Jaka jest ich misja, wartości lub unikalna cecha (USP)?
      3. Znajdź 2-3 konkretne, unikalne fakty, które można wykorzystać do spersonalizowania e-maila (np. nagrody, historia rodziny, udział w targach, konkretne opinie klientów).
      Odpowiedz konkretnie i rzeczowo, po polsku.`
      
      analysis = await this.notebooklm.query({
        notebook: tempNotebookId,
        question
      })

      await this.agent.log('info', `Analiza zakończona sukcesem.`, {}, taskId)

    } catch (error) {
      await this.agent.log('warn', `Deep Enrichment fallback: ${(error as Error).message}`, {}, taskId)
    } finally {
      // Cleanup
      if (tempNotebookId) {
        try {
          await this.notebooklm.deleteNotebook(tempNotebookId)
          await this.agent.log('info', `Usunięto notatnik tymczasowy.`, {}, taskId)
        } catch (e) {
          // ignore cleanup errors
        }
      }
    }

    return {
      ...links,
      products: 'Zanalizowane przez Deep Research',
      usp: 'Zanalizowane przez Deep Research',
      personalizationHook: analysis.answer,
      rawAnalysis: analysis.answer
    }
  }
}
