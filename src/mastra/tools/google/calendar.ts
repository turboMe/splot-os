import { google, type calendar_v3 } from 'googleapis'
import type { OAuth2Client } from 'google-auth-library'
import { getGoogleAuth, type MailboxAccount } from './auth.js'

export class CalendarService {
  private calendar: calendar_v3.Calendar

  constructor(authClient: OAuth2Client) {
    this.calendar = google.calendar({ version: 'v3', auth: authClient })
  }

  static async create(account: MailboxAccount = 'gastrobridge'): Promise<CalendarService> {
    const auth = await getGoogleAuth(account)
    return new CalendarService(auth)
  }

  /**
   * Create a publishing reminder event.
   */
  async createPublishingReminder(opts: {
    title: string
    description: string
    scheduledFor: Date
    durationMinutes?: number
    draftId: string
    dashboardUrl: string
  }): Promise<string> {
    const event = {
      summary: opts.title,
      description: `${opts.description}\n\n📋 Draft: ${opts.dashboardUrl}/drafts/${opts.draftId}`,
      start: { dateTime: opts.scheduledFor.toISOString() },
      end: {
        dateTime: new Date(
          opts.scheduledFor.getTime() + (opts.durationMinutes ?? 15) * 60_000
        ).toISOString()
      },
      reminders: {
        useDefault: false,
        overrides: [
          { method: 'popup' as const, minutes: 30 },
          { method: 'popup' as const, minutes: 5 }
        ]
      },
      colorId: '6',  // tangerine
      extendedProperties: {
        private: {
          agentforge: 'true',
          draftId: opts.draftId
        }
      }
    }

    const result = await this.calendar.events.insert({
      calendarId: 'primary',
      requestBody: event
    })

    return result.data.id!
  }

  async deleteEvent(eventId: string): Promise<void> {
    await this.calendar.events.delete({
      calendarId: 'primary',
      eventId
    })
  }

  async listAgentForgeEvents(opts: {
    timeMin: Date
    timeMax: Date
  }): Promise<calendar_v3.Schema$Event[]> {
    const result = await this.calendar.events.list({
      calendarId: 'primary',
      timeMin: opts.timeMin.toISOString(),
      timeMax: opts.timeMax.toISOString(),
      privateExtendedProperty: ['agentforge=true']
    })
    return result.data.items ?? []
  }

  // --- GENERIC META-AGENT TOOLS --- //

  /**
   * Generic event creator
   */
  async createEvent(opts: {
    title: string
    description?: string
    start: Date
    end?: Date
    attendees?: string[]
  }): Promise<string> {
    const event: calendar_v3.Schema$Event = {
      summary: opts.title,
      description: opts.description,
      start: { dateTime: opts.start.toISOString() },
      end: { 
        dateTime: opts.end?.toISOString() ?? new Date(opts.start.getTime() + 60 * 60_000).toISOString() 
      },
      attendees: opts.attendees?.map(email => ({ email })),
      extendedProperties: {
        private: { agentforge: 'true' }
      }
    }

    const result = await this.calendar.events.insert({
      calendarId: 'primary',
      requestBody: event,
      sendUpdates: 'all'
    })
    return result.data.id!
  }

  /**
   * Generic event updater
   */
  async updateEvent(eventId: string, opts: {
    title?: string
    description?: string
    start?: Date
    end?: Date
  }): Promise<void> {
    const existing = await this.calendar.events.get({ calendarId: 'primary', eventId })
    const ev = existing.data

    if (opts.title) ev.summary = opts.title
    if (opts.description) ev.description = opts.description
    if (opts.start) ev.start = { dateTime: opts.start.toISOString() }
    if (opts.end) ev.end = { dateTime: opts.end.toISOString() }

    await this.calendar.events.update({
      calendarId: 'primary',
      eventId,
      requestBody: ev,
      sendUpdates: 'all'
    })
  }

  /**
   * Find an event by text query
   */
  async findEventByQuery(query: string, timeMin?: Date): Promise<calendar_v3.Schema$Event[]> {
    const result = await this.calendar.events.list({
      calendarId: 'primary',
      q: query,
      timeMin: (timeMin ?? new Date()).toISOString(),
      maxResults: 10,
      singleEvents: true,
      orderBy: 'startTime'
    })
    return result.data.items ?? []
  }
}
