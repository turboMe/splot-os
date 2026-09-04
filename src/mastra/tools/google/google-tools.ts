import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { GmailService } from './gmail.js';
import { CalendarService } from './calendar.js';
import { SheetsService } from './sheets.js';
import { SlidesService } from './slides.js';
import { DriveService } from './drive.js';
import { withIdempotency } from '../../services/idempotency.js';

// --- GMAIL TOOLS ---

export const gmailSearchTool = createTool({
  id: 'gmail_search',
  description: `Search threads in Gmail by keywords or email address.
useWhen:
- When you want to find emails from a specific client or on a given topic.
- When you want to check for unread messages.
avoidWhen:
- When you want to manage drafts (use gmail_manage_draft instead).`,
  inputSchema: z.object({
    query: z.string().describe('The search query (e.g. "is:unread", "from:client@email.com").'),
    account: z.enum(['gastrobridge', 'personal']).optional().default('gastrobridge').describe("Mailbox account: 'gastrobridge' or 'personal'."),
    maxResults: z.number().optional().default(10).describe('Maximum number of threads to return.'),
  }),
  execute: async (context) => {
    try {
      const gmail = await GmailService.create(context.account ?? 'gastrobridge');
      const threads = await gmail.searchThreads(context.query, context.maxResults);
      return { success: true, count: threads.length, threads };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  },
});

export const gmailManageDraftTool = createTool({
  id: 'gmail_manage_draft',
  description: `Manages draft emails in Gmail. Allows for:
- create: Create a new draft – optionally as a reply in an existing thread (if threadId is provided).
- update: Update an existing draft (recipients, subject, body) by its ID.
- get: Retrieve the details and content of a specific draft by its ID.
- list: Retrieve the list of current drafts in Gmail.
- send: Send an existing draft by its ID.
- delete: Delete a draft from Gmail by its ID.

useWhen:
- When you want to save a draft email or a reply to a thread, but do not want to send it yet without human approval.
- When you want to update/correct the content of an existing draft before sending it.
- When you want to retrieve draft details, list drafts, or delete an unnecessary draft.
- When you want to send a ready draft.

avoidWhen:
- When you want to search threads or read emails (use gmail_search_emails / gmail_read_email from MCP instead).
- When you want to send an email directly without creating a draft first (use gmail_send_email from MCP instead).`,
  inputSchema: z.object({
    action: z.enum(['create', 'update', 'get', 'list', 'send', 'delete']).describe('The draft operation to perform.'),
    account: z.enum(['gastrobridge', 'personal']).optional().default('gastrobridge').describe("Which mailbox account to use: 'gastrobridge' (for GastroBridge & Gastro Consulting) or 'personal' (for Career, Automation, Web Dev)."),
    draftId: z.string().optional().describe('Gmail draft ID. Required for update, get, send, delete operations.'),
    to: z.string().optional().describe('Recipient email address. Required for create, optional for update.'),
    subject: z.string().optional().describe('Subject of the email. Required for create, optional for update.'),
    body: z.string().optional().describe('Plain text body of the email. Required for create, optional for update.'),
    html: z.string().optional().describe('Optional styled HTML body of the email (for rich-text formatting, branded signatures, CTA buttons, and cards).'),
    threadId: z.string().optional().describe('Gmail thread ID. Optional for create (to reply) and update.'),
    attachments: z.array(z.object({
      filename: z.string().describe('File name for the attachment (e.g. Candidate_CV.pdf).'),
      path: z.string().optional().describe('Absolute file system path to the attachment file.'),
      content: z.string().optional().describe('Base64 encoded content string (if path not provided).'),
      mimeType: z.string().optional().describe('MIME type of the attachment (optional, detected from filename if omitted).'),
    })).optional().describe('Optional list of file attachments (e.g. CV or references from disk).'),
    maxResults: z.number().optional().default(20).describe('Maximum number of drafts to return. Used only for list operation.'),
  }),
  execute: async (context) => {
    const { action, account, draftId, to, subject, body, html, threadId, attachments, maxResults } = context;
    try {
      const gmail = await GmailService.create(account ?? 'gastrobridge');
      switch (action) {
        case 'create': {
          if (!to) return { success: false, error: "Missing recipient ('to') for the create action." };
          if (!subject) return { success: false, error: "Missing subject ('subject') for the create action." };
          if (!body) return { success: false, error: "Missing body ('body') for the create action." };

          // Etap 5: a retried draft-create must not produce a duplicate draft.
          // Dedup on (to + subject + body + html + threadId).
          const { result } = await withIdempotency(
            { toolId: 'gmail_manage_draft:create', input: { to, subject, body, html, threadId, attachments } },
            async () => {
              const newDraftId = threadId
                ? await gmail.createDraftReply({ threadId, to, subject, body, html, attachments })
                : await gmail.createDraft({ to, subject, body, html, attachments });

              // Auto-register draft in Splot OS Draft Registry / MongoDB
              try {
                const { upsertDraftFromGmail } = await import('../../services/draft-registry.js');
                await upsertDraftFromGmail({
                  gmailDraftId: newDraftId,
                  account,
                  to,
                  subject,
                  body,
                  html,
                  threadId: threadId ?? undefined,
                  attachments,
                });
              } catch (regErr) {
                console.warn('[gmail_manage_draft] Auto-register draft error:', regErr);
              }

              return { success: true as const, action, draftId: newDraftId, account };
            },
          );
          return result;
        }
        case 'update': {
          if (!draftId) return { success: false, error: "Missing 'draftId' for the update action." };
          const current = await gmail.getDraft(draftId);
          const finalTo = to ?? current.to;
          const finalSubject = subject ?? current.subject;
          const finalBody = body ?? current.body ?? '';

          if (!finalTo) return { success: false, error: "Draft has an empty 'to' field." };
          if (!finalSubject) return { success: false, error: "Draft has an empty 'subject' field." };

          const updatedDraftId = await gmail.updateDraft({
            draftId,
            to: finalTo,
            subject: finalSubject,
            body: finalBody,
            html,
            threadId: threadId ?? current.threadId ?? undefined,
            attachments,
          });

          // Auto-sync update in Splot OS Draft Registry / MongoDB
          try {
            const { upsertDraftFromGmail } = await import('../../services/draft-registry.js');
            await upsertDraftFromGmail({
              gmailDraftId: updatedDraftId,
              account,
              to: finalTo,
              subject: finalSubject,
              body: finalBody,
              html,
              threadId: threadId ?? current.threadId ?? undefined,
              attachments,
            });
          } catch {}

          return { success: true, action, draftId: updatedDraftId, previousDraftId: draftId, to: finalTo, subject: finalSubject, account };
        }
        case 'get': {
          if (!draftId) return { success: false, error: "Missing 'draftId' for the get action." };
          const draft = await gmail.getDraft(draftId);
          return { success: true, action, draft };
        }
        case 'list': {
          const drafts = await gmail.listDrafts(maxResults);
          return { success: true, action, count: drafts.length, drafts };
        }
        case 'send': {
          if (!draftId) return { success: false, error: "Missing 'draftId' for the send action." };
          // Etap 5: a retried send of the same draft must not send twice.
          const { result } = await withIdempotency(
            { toolId: 'gmail_manage_draft:send', input: { draftId } },
            async () => {
              await gmail.sendDraft(draftId);
              try {
                const { setDraftStatus } = await import('../../services/draft-registry.js');
                await setDraftStatus(`gmail-${draftId}`, 'sent');
                await setDraftStatus(draftId, 'sent');
              } catch {}
              return { success: true as const, action, draftId };
            },
          );
          return result;
        }
        case 'delete': {
          if (!draftId) return { success: false, error: "Missing 'draftId' for the delete action." };
          await gmail.deleteDraft(draftId);
          try {
            const { deleteDraftById } = await import('../../services/draft-registry.js');
            await deleteDraftById(draftId);
          } catch {}
          return { success: true, action, draftId };
        }
        default:
          return { success: false, error: `Unsupported action: ${action}` };
      }
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  },
});

// --- CALENDAR TOOLS ---

export const calendarCreateEventTool = createTool({
  id: 'calendar_create_event',
  description: `Creates a new event in Google Calendar.
useWhen:
- When you want to schedule a meeting, task, or reminder in the calendar.
avoidWhen:
- When you want to move or reschedule an existing event (use calendar_update_event instead).`,
  inputSchema: z.object({
    title: z.string().describe('The title of the event.'),
    description: z.string().describe('The description of the event.'),
    // NO concrete example date here. The previous one ("e.g., 2026-05-10T12:00:00Z")
    // was copied as an anchor: a run asked for "next week" booked 2026-05-28 while
    // the real date was 2026-08-11, because nothing in a background job says what
    // day it is and the only date in sight was this description.
    scheduledFor: z.string().describe(
      'Event start, full ISO 8601 with timezone (YYYY-MM-DDTHH:mm:ssZ). Must be in the FUTURE. '
      + 'Compute it from the current date given in your run instructions, never from an example.',
    ),
    durationMinutes: z.number().optional().default(60).describe('The duration of the event in minutes.'),
    account: z.enum(['gastrobridge', 'personal']).optional().default('gastrobridge').describe('Google account/mailbox to use (gastrobridge or personal).'),
  }),
  execute: async (context) => {
    try {
      const start = new Date(context.scheduledFor);
      // A booking in the past is never what anyone asked for, and it lands in a
      // real calendar where a human has to find and delete it. Measured: a
      // "next week" follow-up booked three months in the past, and the run
      // reported it as next week. The prompt asks; the tool refuses.
      if (Number.isNaN(start.getTime())) {
        return { success: false, error: `scheduledFor is not a valid date: ${context.scheduledFor}` };
      }
      if (start.getTime() < Date.now()) {
        return {
          success: false,
          error:
            `Refused: ${start.toISOString()} is in the PAST (now is ${new Date().toISOString()}). `
            + 'Recompute the date from today and call again.',
        };
      }
      const calendar = await CalendarService.create(context.account);
      const eventId = await calendar.createEvent({
        title: context.title,
        description: context.description,
        start,
      });
      return { success: true, eventId, account: context.account };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  },
});

export const calendarFindEventTool = createTool({
  id: 'calendar_find_event',
  description: `Searches for events in Google Calendar using keywords (e.g., company name, contact).
useWhen:
- When you are searching for existing appointments or meetings with a specific person or company.
avoidWhen:
- When you want to retrieve all events in a time range without filtering by keywords.`,
  inputSchema: z.object({
    query: z.string().describe('The keywords to search for (e.g., "Acme meeting", "Patryk").'),
    timeMin: z.string().optional().describe('Search for events starting from this date/time (ISO string). Defaults to now.'),
    account: z.enum(['gastrobridge', 'personal']).optional().default('gastrobridge').describe('Google account/mailbox to use (gastrobridge or personal).'),
  }),
  execute: async (context) => {
    try {
      const calendar = await CalendarService.create(context.account);
      const events = await calendar.findEventByQuery(
        context.query,
        context.timeMin ? new Date(context.timeMin) : new Date(),
      );
      return {
        success: true,
        account: context.account,
        count: events.length,
        events: events.map(e => ({
          id: e.id,
          summary: e.summary,
          start: e.start?.dateTime ?? e.start?.date,
          end: e.end?.dateTime ?? e.end?.date,
          description: e.description,
        })),
      };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  },
});

export const calendarUpdateEventTool = createTool({
  id: 'calendar_update_event',
  description: `Updates an existing event in Google Calendar (title, description, start/end time).
useWhen:
- When you want to reschedule a planned meeting or publication to a different date/time.
- When you want to update the description or subject of an existing event in the calendar.
avoidWhen:
- When you want to create a new event (use calendar_create_event instead).
- When you want to delete an event (use calendar_delete_event instead).`,
  inputSchema: z.object({
    eventId: z.string().describe('The ID of the Google Calendar event to update.'),
    title: z.string().optional().describe('New title for the event (optional).'),
    description: z.string().optional().describe('New description for the event (optional).'),
    start: z.string().optional().describe('New start time in ISO format (optional).'),
    end: z.string().optional().describe('New end time in ISO format (optional).'),
    account: z.enum(['gastrobridge', 'personal']).optional().default('gastrobridge').describe('Google account/mailbox to use (gastrobridge or personal).'),
  }),
  execute: async (context) => {
    try {
      const calendar = await CalendarService.create(context.account);
      await calendar.updateEvent(context.eventId, {
        title: context.title,
        description: context.description,
        start: context.start ? new Date(context.start) : undefined,
        end: context.end ? new Date(context.end) : undefined,
      });
      return { success: true, eventId: context.eventId, account: context.account };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  },
});

export const calendarDeleteEventTool = createTool({
  id: 'calendar_delete_event',
  description: `Deletes an event from Google Calendar by its ID.
useWhen:
- When a meeting or event has been cancelled and needs to be removed from the calendar.
avoidWhen:
- When you want to reschedule or change details of an event without deleting it (use calendar_update_event instead).`,
  inputSchema: z.object({
    eventId: z.string().describe('The ID of the Google Calendar event to delete.'),
    account: z.enum(['gastrobridge', 'personal']).optional().default('gastrobridge').describe('Google account/mailbox to use (gastrobridge or personal).'),
  }),
  execute: async (context) => {
    try {
      const calendar = await CalendarService.create(context.account);
      await calendar.deleteEvent(context.eventId);
      return { success: true, eventId: context.eventId, account: context.account };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  },
});

// --- GOOGLE SHEETS TOOLS ---

export const sheetsCreateSpreadsheetTool = createTool({
  id: 'sheets_create_spreadsheet',
  description: `Creates a new Google Sheets spreadsheet. Returns spreadsheetId and URL.
useWhen:
- When you want to create a new spreadsheet to store data, e.g., reports, CRM exports, distribution lists.
avoidWhen:
- When you want to write to an existing spreadsheet (use sheets_write_range or sheets_append_rows instead).
- When you just want to get information about a spreadsheet (use sheets_get_metadata instead).`,
  inputSchema: z.object({
    title: z.string().describe('The title of the new spreadsheet.'),
    sheetTitles: z.array(z.string()).optional().describe('Optional list of titles for sheets in the spreadsheet (defaults to ["Sheet1"]).'),
  }),
  outputSchema: z.object({
    success: z.boolean(),
    spreadsheetId: z.string().optional(),
    url: z.string().optional(),
    sheets: z.array(z.object({ sheetId: z.number(), title: z.string() })).optional(),
    error: z.string().optional(),
  }),
  execute: async (context) => {
    try {
      const sheets = await SheetsService.create();
      const result = await sheets.createSpreadsheet(context.title, context.sheetTitles);
      return { success: true, ...result };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  },
});

export const sheetsReadRangeTool = createTool({
  id: 'sheets_read_range',
  description: `Reads a range of cells from a Google Sheets spreadsheet in A1 format (e.g., "Sheet1!A1:C10").
useWhen:
- When you want to retrieve data from a specific table or cell range in a spreadsheet.
avoidWhen:
- When you want to get structural information about the spreadsheet rather than cell values (use sheets_get_metadata instead).
- When you want to read a non-spreadsheet file from Google Drive (use drive_read_file from MCP instead).`,
  inputSchema: z.object({
    spreadsheetId: z.string().describe('The ID of the spreadsheet (the part of the URL between /d/ and /edit).'),
    range: z.string().describe('The A1 range to read, e.g., "Sheet1!A1:D100".'),
  }),
  outputSchema: z.object({
    success: z.boolean(),
    range: z.string().optional(),
    values: z.array(z.array(z.union([z.string(), z.number(), z.boolean(), z.null()]))).optional(),
    rowCount: z.number().optional(),
    error: z.string().optional(),
  }),
  execute: async (context) => {
    try {
      const sheets = await SheetsService.create();
      const result = await sheets.readRange(context.spreadsheetId, context.range);
      return { success: true, ...result };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  },
});

export const sheetsWriteRangeTool = createTool({
  id: 'sheets_write_range',
  description: `OVERWRITES a range in a Google Sheets spreadsheet with the provided values. Requires the confirm parameter set to true.
useWhen:
- When you want to update a specific range of cells or overwrite old data with new data.
avoidWhen:
- When you want to add new data to the end of a sheet without overwriting existing data (use sheets_append_rows instead).
- When you do not have user confirmation to overwrite data (requires confirm: true).`,
  inputSchema: z.object({
    spreadsheetId: z.string().describe('The ID of the spreadsheet.'),
    range: z.string().describe('The A1 range to overwrite, e.g., "Sheet1!A1:C5".'),
    values: z.array(z.array(z.union([z.string(), z.number(), z.boolean(), z.null()]))).describe('A two-dimensional array of values to insert.'),
    confirm: z.boolean().describe('Confirmation of the overwrite operation. Must be true.'),
  }),
  outputSchema: z.object({
    success: z.boolean(),
    blocked: z.boolean().optional(),
    updatedRange: z.string().optional(),
    updatedRows: z.number().optional(),
    updatedCells: z.number().optional(),
    error: z.string().optional(),
  }),
  execute: async (context) => {
    if (!context.confirm) {
      return {
        success: false,
        blocked: true,
        error: 'BLOCKED: confirm must be true. Inform the user what will be overwritten and where, obtain consent, and call again with confirm: true.',
      };
    }
    try {
      const sheets = await SheetsService.create();
      const result = await sheets.writeRange(context.spreadsheetId, context.range, context.values);
      return { success: true, ...result };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  },
});

export const sheetsAppendRowsTool = createTool({
  id: 'sheets_append_rows',
  description: `Appends rows of data to the end of a table in a Google Sheets spreadsheet. Safe for existing data (does not overwrite).
useWhen:
- When you want to save new logs, leads, CRM entries, or transaction rows to the end of a sheet.
avoidWhen:
- When you want to update or modify existing rows (use sheets_write_range instead).`,
  inputSchema: z.object({
    spreadsheetId: z.string().describe('The ID of the spreadsheet.'),
    range: z.string().describe('The range specifying the table to append data to, e.g., "Sheet1!A1". Google Sheets will automatically find the first empty row.'),
    values: z.array(z.array(z.union([z.string(), z.number(), z.boolean(), z.null()]))).describe('A two-dimensional array of rows to add.'),
  }),
  outputSchema: z.object({
    success: z.boolean(),
    updatedRange: z.string().optional(),
    appendedRows: z.number().optional(),
    error: z.string().optional(),
  }),
  execute: async (context) => {
    try {
      const sheets = await SheetsService.create();
      const result = await sheets.appendRows(context.spreadsheetId, context.range, context.values);
      return { success: true, ...result };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  },
});

export const sheetsGetMetadataTool = createTool({
  id: 'sheets_get_metadata',
  description: `Retrieves metadata of a Google Sheets spreadsheet (title, list of sheets, their names and dimensions).
useWhen:
- When you want to inspect the structure of a spreadsheet before reading or writing cells.
avoidWhen:
- When you want to read the cell values themselves (use sheets_read_range instead).`,
  inputSchema: z.object({
    spreadsheetId: z.string().describe('The ID of the spreadsheet to retrieve metadata for.'),
  }),
  outputSchema: z.object({
    success: z.boolean(),
    spreadsheetId: z.string().optional(),
    title: z.string().optional(),
    url: z.string().optional(),
    sheets: z.array(z.object({
      sheetId: z.number(),
      title: z.string(),
      rowCount: z.number(),
      columnCount: z.number(),
    })).optional(),
    error: z.string().optional(),
  }),
  execute: async (context) => {
    try {
      const sheets = await SheetsService.create();
      const result = await sheets.getMetadata(context.spreadsheetId);
      return { success: true, ...result };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  },
});

// --- GOOGLE SLIDES TOOLS ---

export const slidesCreatePresentationTool = createTool({
  id: 'slides_create_presentation',
  description: `Creates a new Google Slides presentation with a single blank title slide.
useWhen:
- When you want to generate a new presentation, business report, client proposal, or summary deck.
avoidWhen:
- When you want to add a slide or edit an existing presentation (use slides_add_slide or slides_replace_text instead).`,
  inputSchema: z.object({
    title: z.string().describe('The title of the new Google Slides presentation.'),
  }),
  outputSchema: z.object({
    success: z.boolean(),
    presentationId: z.string().optional(),
    url: z.string().optional(),
    slideIds: z.array(z.string()).optional(),
    error: z.string().optional(),
  }),
  execute: async (context) => {
    try {
      const slides = await SlidesService.create();
      const result = await slides.createPresentation(context.title);
      return { success: true, ...result };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  },
});

export const slidesGetMetadataTool = createTool({
  id: 'slides_get_metadata',
  description: `Retrieves metadata of a Google Slides presentation (title, slide count, slide IDs, and indexes).
useWhen:
- When you want to inspect the structure of a presentation or discover specific slide IDs before adding elements.
avoidWhen:
- When you want to edit slide values or add slides (use the respective modifying tools instead).`,
  inputSchema: z.object({
    presentationId: z.string().describe('The ID of the Google Slides presentation.'),
  }),
  outputSchema: z.object({
    success: z.boolean(),
    presentationId: z.string().optional(),
    title: z.string().optional(),
    url: z.string().optional(),
    slideCount: z.number().optional(),
    slides: z.array(z.object({
      slideId: z.string(),
      index: z.number(),
      layoutType: z.string().optional(),
    })).optional(),
    error: z.string().optional(),
  }),
  execute: async (context) => {
    try {
      const slides = await SlidesService.create();
      const result = await slides.getMetadata(context.presentationId);
      return { success: true, ...result };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  },
});

export const slidesAddSlideTool = createTool({
  id: 'slides_add_slide',
  description: `Adds a new slide to a presentation with the selected layout.
useWhen:
- When you are extending a presentation with an additional slide of a specific layout.
avoidWhen:
- When you just want to change text on an existing slide (use slides_replace_text instead).`,
  inputSchema: z.object({
    presentationId: z.string().describe('The ID of the Google Slides presentation.'),
    layout: z.enum(['TITLE', 'TITLE_AND_BODY', 'TITLE_AND_TWO_COLUMNS', 'BLANK', 'SECTION_HEADER']).optional().default('TITLE_AND_BODY').describe('The layout of the new slide.'),
  }),
  outputSchema: z.object({
    success: z.boolean(),
    slideId: z.string().optional(),
    error: z.string().optional(),
  }),
  execute: async (context) => {
    try {
      const slides = await SlidesService.create();
      const result = await slides.addSlide(context.presentationId, { layout: context.layout });
      return { success: true, ...result };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  },
});

export const slidesReplaceTextTool = createTool({
  id: 'slides_replace_text',
  description: `Replaces defined text placeholders (e.g., {{KEY}}) with new values across the entire presentation.
useWhen:
- When you want to personalize a presentation template for a client or populate it with analytical data.
avoidWhen:
- When you want to add an entirely new text box at specific coordinates (use slides_add_text_box instead).`,
  inputSchema: z.object({
    presentationId: z.string().describe('The ID of the Google Slides presentation.'),
    replacements: z.record(z.string(), z.string()).describe('A map of keys and their replacements, e.g., {"{{NAME}}": "GastroBridge"}.'),
  }),
  outputSchema: z.object({
    success: z.boolean(),
    replacementsCount: z.number().optional(),
    error: z.string().optional(),
  }),
  execute: async (context) => {
    try {
      const slides = await SlidesService.create();
      const result = await slides.replaceAllText(context.presentationId, context.replacements);
      return { success: true, ...result };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  },
});

export const slidesAddTextBoxTool = createTool({
  id: 'slides_add_text_box',
  description: `Adds a text box at a specified location on a slide. Coordinates are in EMUs (1 inch = 914,400 EMU).
useWhen:
- When you want to insert a custom annotation, label, or custom text block on a selected slide.
avoidWhen:
- When you just want to fill existing templates/placeholders (use slides_replace_text instead).`,
  inputSchema: z.object({
    presentationId: z.string().describe('The ID of the Google Slides presentation.'),
    slideId: z.string().describe('The ID of the slide where you want to place the text box.'),
    text: z.string().describe('The text content of the text box.'),
    fontSize: z.number().optional().describe('The font size in points (e.g., 14, 18).'),
    bold: z.boolean().optional().default(false).describe('Whether the text should be bold.'),
    x: z.number().optional().describe('X coordinate in EMUs (defaults to 100,000).'),
    y: z.number().optional().describe('Y coordinate in EMUs (defaults to 100,000).'),
    width: z.number().optional().describe('Width of the text box in EMUs.'),
    height: z.number().optional().describe('Height of the text box in EMUs.'),
  }),
  outputSchema: z.object({
    success: z.boolean(),
    textBoxId: z.string().optional(),
    error: z.string().optional(),
  }),
  execute: async (context) => {
    try {
      const slides = await SlidesService.create();
      const result = await slides.addTextBox(
        context.presentationId,
        context.slideId,
        context.text,
        {
          fontSize: context.fontSize,
          bold: context.bold,
          x: context.x,
          y: context.y,
          width: context.width,
          height: context.height,
        },
      );
      return { success: true, ...result };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  },
});

export const slidesDeleteSlideTool = createTool({
  id: 'slides_delete_slide',
  description: `Deletes a slide from a presentation. This is an irreversible operation and requires confirm set to true.
useWhen:
- When you want to delete an unnecessary or draft slide from a presentation.
avoidWhen:
- When you do not have user confirmation to delete the slide (requires confirm: true).`,
  inputSchema: z.object({
    presentationId: z.string().describe('The ID of the Google Slides presentation.'),
    slideId: z.string().describe('The ID of the slide to delete.'),
    confirm: z.boolean().describe('Confirmation to delete the slide. Must be true.'),
  }),
  outputSchema: z.object({
    success: z.boolean(),
    blocked: z.boolean().optional(),
    error: z.string().optional(),
  }),
  execute: async (context) => {
    if (!context.confirm) {
      return {
        success: false,
        blocked: true,
        error: 'BLOCKED: confirm must be true. The slide will be permanently deleted with no undo option.',
      };
    }
    try {
      const slides = await SlidesService.create();
      await slides.deleteSlide(context.presentationId, context.slideId);
      return { success: true };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  },
});

// --- GOOGLE DRIVE TOOLS ---

export const driveUploadFileTool = createTool({
  id: 'drive_upload_file',
  description: `Uploads a local file from disk to Google Drive and returns a shareable link.
useWhen:
- When a file attachment is too large for email (>15-20MB).
- When you want to share a portfolio, presentation, or large asset via a Google Drive link.
avoidWhen:
- When a small PDF/document can be attached directly to an email draft (use attachments in gmail_manage_draft).`,
  inputSchema: z.object({
    filePath: z.string().describe('Absolute file path on the local disk to upload.'),
    customFilename: z.string().optional().describe('Optional custom filename to give the file in Google Drive.'),
    account: z.enum(['gastrobridge', 'personal']).optional().default('gastrobridge').describe('Google account to use for Google Drive upload.'),
    makePublic: z.boolean().optional().default(true).describe('Whether to grant public view access (anyone with link can view).'),
  }),
  outputSchema: z.object({
    success: z.boolean(),
    fileId: z.string().optional(),
    name: z.string().optional(),
    webViewLink: z.string().optional(),
    webContentLink: z.string().optional(),
    error: z.string().optional(),
  }),
  execute: async (context) => {
    try {
      const drive = await DriveService.create(context.account);
      const res = await drive.uploadFile({
        filePath: context.filePath,
        customFilename: context.customFilename,
        makePublic: context.makePublic,
      });
      return { success: true, ...res };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  },
});
