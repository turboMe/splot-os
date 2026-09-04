import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { BaseAgent as Agent } from '../../../core/base-agent.js'
import { repairJSON } from '@af/shared'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const PROMPT_PATH = path.join(__dirname, '..', 'prompts', 'copy-en.md')

export class CopyEnStep {
  constructor(private agent: Agent) {}

  async run(opts: {
    posts: Array<{ topic: string; post: string; hashtags: string[] }>
    taskId: string
  }): Promise<{
    translations: Array<{
      originalTopic: string; post: string; hashtags: string[];
      char_count: number; adaptationNotes: string
    }>;
    _metadata?: any;
  }> {
    await this.agent.log('info', 'CopyEnStep starting', { postCount: opts.posts.length }, opts.taskId)

    const systemPrompt = await fs.readFile(PROMPT_PATH, 'utf-8')

    const result = await this.agent.callLLM('copy-en', {
      systemPrompt,
      userPrompt: `Translate and adapt these Polish LinkedIn posts to English:

${opts.posts.map((p, i) => `### Post ${i + 1}: ${p.topic}
${p.post}

Hashtags: ${p.hashtags.join(' ')}`).join('\n\n---\n\n')}

Return JSON with "translations" array.`,
      jsonMode: true,
      temperature: 0.5
    }, opts.taskId)

    try {
      const parsed = repairJSON(result.text)
      return {
        translations: parsed.translations ?? [],
        _metadata: {
          provider: result.provider,
          model: result.model,
          costUsd: result.costUsd
        }
      } as any
    } catch {
      return { translations: [], _metadata: {} } as any
    }
  }
}
