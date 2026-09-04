import { BaseAgent as Agent } from '../../../core/base-agent.js'

/**
 * Collects image prompts for telemetry. Actual generation happens when each
 * draft folder exists, so images can be written beside draft.md.
 */
export class ImagePlaceholderStep {
  constructor(private agent: Agent) {}

  async run(opts: {
    drafts: Array<{ topic: string; imagePrompt?: string; needsImage?: boolean }>
    taskId: string
  }): Promise<Array<{
    draftTopic: string
    status: 'manual'
    imagePrompt: string
    note: string
  }>> {
    const enabled = process.env.IMAGE_GENERATION_ENABLED === 'true'

    if (enabled) {
      await this.agent.log('info', 'Image generation enabled; images will be generated into draft folders.', {}, opts.taskId)
    }

    return opts.drafts
      .filter(d => d.needsImage || d.imagePrompt)
      .map(d => ({
        draftTopic: d.topic,
        status: 'manual' as const,
        imagePrompt: d.imagePrompt ?? `Wygeneruj obraz dla: ${d.topic}`,
        note: enabled
          ? 'Image will be generated into the draft folder if an image provider is configured.'
          : 'Image generation disabled. Use prompt manually or set IMAGE_GENERATION_ENABLED=true.'
      }))
  }
}
