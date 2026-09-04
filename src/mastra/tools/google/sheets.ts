/**
 * Google Sheets service (Faza 6.1).
 * SDK-based wrapper around googleapis.sheets — used by sheets.* tools.
 */
import { google, type sheets_v4 } from 'googleapis'
import type { OAuth2Client } from 'google-auth-library'
import { getGoogleAuth } from './auth.js'

export type CellValue = string | number | boolean | null
export type Row = CellValue[]

export class SheetsService {
  private sheets: sheets_v4.Sheets

  constructor(authClient: OAuth2Client) {
    this.sheets = google.sheets({ version: 'v4', auth: authClient })
  }

  static async create(): Promise<SheetsService> {
    const auth = await getGoogleAuth()
    return new SheetsService(auth)
  }

  /**
   * Creates a new spreadsheet. Returns spreadsheetId + URL.
   */
  async createSpreadsheet(title: string, sheetTitles?: string[]): Promise<{
    spreadsheetId: string
    url: string
    sheets: Array<{ sheetId: number; title: string }>
  }> {
    const sheetsList = (sheetTitles && sheetTitles.length > 0
      ? sheetTitles
      : ['Sheet1']
    ).map(t => ({ properties: { title: t } }))

    const result = await this.sheets.spreadsheets.create({
      requestBody: {
        properties: { title },
        sheets: sheetsList,
      },
    })

    const data = result.data
    return {
      spreadsheetId: data.spreadsheetId ?? '',
      url: data.spreadsheetUrl ?? '',
      sheets: (data.sheets ?? []).map(s => ({
        sheetId: s.properties?.sheetId ?? 0,
        title: s.properties?.title ?? '',
      })),
    }
  }

  /**
   * Reads a range. Range format: "Sheet1!A1:C10" or just "A1:C10" for first sheet.
   */
  async readRange(spreadsheetId: string, range: string): Promise<{
    range: string
    values: Row[]
    rowCount: number
  }> {
    const result = await this.sheets.spreadsheets.values.get({
      spreadsheetId,
      range,
    })

    const values = (result.data.values ?? []) as Row[]
    return {
      range: result.data.range ?? range,
      values,
      rowCount: values.length,
    }
  }

  /**
   * Writes values to a range, OVERWRITING existing content.
   * For appending without overwrite use appendRows().
   */
  async writeRange(spreadsheetId: string, range: string, values: Row[]): Promise<{
    updatedRange: string
    updatedRows: number
    updatedCells: number
  }> {
    const result = await this.sheets.spreadsheets.values.update({
      spreadsheetId,
      range,
      valueInputOption: 'USER_ENTERED',
      requestBody: { values: values as any[][] },
    })

    return {
      updatedRange: result.data.updatedRange ?? range,
      updatedRows: result.data.updatedRows ?? 0,
      updatedCells: result.data.updatedCells ?? 0,
    }
  }

  /**
   * Appends rows to the end of an existing table-like range.
   * Sheets auto-detects the next empty row.
   */
  async appendRows(spreadsheetId: string, range: string, values: Row[]): Promise<{
    updatedRange: string
    appendedRows: number
  }> {
    const result = await this.sheets.spreadsheets.values.append({
      spreadsheetId,
      range,
      valueInputOption: 'USER_ENTERED',
      insertDataOption: 'INSERT_ROWS',
      requestBody: { values: values as any[][] },
    })

    return {
      updatedRange: result.data.updates?.updatedRange ?? range,
      appendedRows: result.data.updates?.updatedRows ?? 0,
    }
  }

  /**
   * Returns spreadsheet metadata: title, sheets, URL.
   */
  async getMetadata(spreadsheetId: string): Promise<{
    spreadsheetId: string
    title: string
    url: string
    sheets: Array<{ sheetId: number; title: string; rowCount: number; columnCount: number }>
  }> {
    const result = await this.sheets.spreadsheets.get({
      spreadsheetId,
      includeGridData: false,
    })
    const data = result.data

    return {
      spreadsheetId: data.spreadsheetId ?? '',
      title: data.properties?.title ?? '',
      url: data.spreadsheetUrl ?? '',
      sheets: (data.sheets ?? []).map(s => ({
        sheetId: s.properties?.sheetId ?? 0,
        title: s.properties?.title ?? '',
        rowCount: s.properties?.gridProperties?.rowCount ?? 0,
        columnCount: s.properties?.gridProperties?.columnCount ?? 0,
      })),
    }
  }

  /**
   * Clears a range (sets all cells to empty).
   */
  async clearRange(spreadsheetId: string, range: string): Promise<void> {
    await this.sheets.spreadsheets.values.clear({
      spreadsheetId,
      range,
    })
  }
}
