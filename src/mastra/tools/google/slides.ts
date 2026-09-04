/**
 * Google Slides service (Faza 6.1).
 * SDK-based wrapper around googleapis.slides — used by slides.* tools.
 */
import { google, type slides_v1 } from 'googleapis'
import type { OAuth2Client } from 'google-auth-library'
import { randomUUID } from 'node:crypto'
import { getGoogleAuth } from './auth.js'

export class SlidesService {
  private slides: slides_v1.Slides

  constructor(authClient: OAuth2Client) {
    this.slides = google.slides({ version: 'v1', auth: authClient })
  }

  static async create(): Promise<SlidesService> {
    const auth = await getGoogleAuth()
    return new SlidesService(auth)
  }

  /**
   * Creates a new blank presentation. Returns presentationId + URL.
   */
  async createPresentation(title: string): Promise<{
    presentationId: string
    url: string
    slideIds: string[]
  }> {
    const result = await this.slides.presentations.create({
      requestBody: { title },
    })

    const data = result.data
    return {
      presentationId: data.presentationId ?? '',
      url: `https://docs.google.com/presentation/d/${data.presentationId}/edit`,
      slideIds: (data.slides ?? []).map(s => s.objectId ?? ''),
    }
  }

  /**
   * Returns presentation metadata: title, slides, URL.
   */
  async getMetadata(presentationId: string): Promise<{
    presentationId: string
    title: string
    url: string
    slideCount: number
    slides: Array<{ slideId: string; index: number; layoutType?: string }>
  }> {
    const result = await this.slides.presentations.get({ presentationId })
    const data = result.data

    return {
      presentationId: data.presentationId ?? '',
      title: data.title ?? '',
      url: `https://docs.google.com/presentation/d/${data.presentationId}/edit`,
      slideCount: (data.slides ?? []).length,
      slides: (data.slides ?? []).map((s, i) => ({
        slideId: s.objectId ?? '',
        index: i,
        layoutType: s.slideProperties?.layoutObjectId ?? undefined,
      })),
    }
  }

  /**
   * Adds a new slide. Optionally with a layout (TITLE, TITLE_AND_BODY, etc).
   * Returns the new slide's objectId.
   */
  async addSlide(
    presentationId: string,
    options: { layout?: string; insertAfterSlideId?: string } = {},
  ): Promise<{ slideId: string }> {
    const slideId = `slide_${randomUUID().replace(/-/g, '').slice(0, 16)}`
    const layout = options.layout ?? 'TITLE_AND_BODY'

    const requests: slides_v1.Schema$Request[] = [
      {
        createSlide: {
          objectId: slideId,
          slideLayoutReference: { predefinedLayout: layout },
          ...(options.insertAfterSlideId
            ? { insertionIndex: undefined } // ignored if not provided
            : {}),
        },
      },
    ]

    await this.slides.presentations.batchUpdate({
      presentationId,
      requestBody: { requests },
    })

    return { slideId }
  }

  /**
   * Replaces all instances of placeholder text across the entire presentation.
   * Use {{PLACEHOLDER}} convention in your template, then call this.
   */
  async replaceAllText(
    presentationId: string,
    replacements: Record<string, string>,
  ): Promise<{ replacementsCount: number }> {
    const requests: slides_v1.Schema$Request[] = Object.entries(replacements).map(
      ([find, replace]) => ({
        replaceAllText: {
          containsText: { text: find, matchCase: true },
          replaceText: replace,
        },
      }),
    )

    if (requests.length === 0) return { replacementsCount: 0 }

    const result = await this.slides.presentations.batchUpdate({
      presentationId,
      requestBody: { requests },
    })

    const total = (result.data.replies ?? [])
      .map(r => r.replaceAllText?.occurrencesChanged ?? 0)
      .reduce((a, b) => a + b, 0)

    return { replacementsCount: total }
  }

  /**
   * Adds a text box to a specific slide.
   * Position is in EMU (1 inch = 914400 EMU). Default: top-left area.
   */
  async addTextBox(
    presentationId: string,
    slideId: string,
    text: string,
    options: {
      x?: number; y?: number; width?: number; height?: number
      fontSize?: number; bold?: boolean
    } = {},
  ): Promise<{ textBoxId: string }> {
    const textBoxId = `txt_${randomUUID().replace(/-/g, '').slice(0, 16)}`
    const x = options.x ?? 100000
    const y = options.y ?? 100000
    const width = options.width ?? 6000000  // ~6.5 inches
    const height = options.height ?? 1000000 // ~1 inch

    const requests: slides_v1.Schema$Request[] = [
      {
        createShape: {
          objectId: textBoxId,
          shapeType: 'TEXT_BOX',
          elementProperties: {
            pageObjectId: slideId,
            size: {
              width: { magnitude: width, unit: 'EMU' },
              height: { magnitude: height, unit: 'EMU' },
            },
            transform: {
              scaleX: 1, scaleY: 1,
              translateX: x, translateY: y,
              unit: 'EMU',
            },
          },
        },
      },
      {
        insertText: {
          objectId: textBoxId,
          text,
          insertionIndex: 0,
        },
      },
    ]

    if (options.fontSize || options.bold) {
      requests.push({
        updateTextStyle: {
          objectId: textBoxId,
          textRange: { type: 'ALL' },
          style: {
            ...(options.fontSize && {
              fontSize: { magnitude: options.fontSize, unit: 'PT' },
            }),
            ...(options.bold && { bold: true }),
          },
          fields: [
            options.fontSize ? 'fontSize' : '',
            options.bold ? 'bold' : '',
          ].filter(Boolean).join(','),
        },
      })
    }

    await this.slides.presentations.batchUpdate({
      presentationId,
      requestBody: { requests },
    })

    return { textBoxId }
  }

  /**
   * Deletes a slide by objectId.
   */
  async deleteSlide(presentationId: string, slideId: string): Promise<void> {
    await this.slides.presentations.batchUpdate({
      presentationId,
      requestBody: {
        requests: [{ deleteObject: { objectId: slideId } }],
      },
    })
  }
}
