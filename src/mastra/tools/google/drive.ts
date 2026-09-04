import { google, type drive_v3 } from 'googleapis'
import type { OAuth2Client } from 'google-auth-library'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { getGoogleAuth, type MailboxAccount } from './auth.js'

export class DriveService {
  private drive: drive_v3.Drive

  constructor(authClient: OAuth2Client) {
    this.drive = google.drive({ version: 'v3', auth: authClient })
  }

  static async create(account: MailboxAccount = 'gastrobridge'): Promise<DriveService> {
    const auth = await getGoogleAuth(account)
    return new DriveService(auth)
  }

  /**
   * Upload a local file to Google Drive and return view/download links.
   */
  async uploadFile(opts: {
    filePath: string
    customFilename?: string
    makePublic?: boolean
  }): Promise<{ fileId: string; name: string; webViewLink: string; webContentLink?: string }> {
    if (!fs.existsSync(opts.filePath)) {
      throw new Error(`File not found at path: ${opts.filePath}`)
    }

    const filename = opts.customFilename || path.basename(opts.filePath)
    const fileStream = fs.createReadStream(opts.filePath)

    const file = await this.drive.files.create({
      requestBody: {
        name: filename,
      },
      media: {
        body: fileStream,
      },
      fields: 'id, name, webViewLink, webContentLink',
    })

    const fileId = file.data.id!

    if (opts.makePublic !== false) {
      try {
        await this.drive.permissions.create({
          fileId,
          requestBody: {
            role: 'reader',
            type: 'anyone',
          },
        })
      } catch (e: any) {
        console.warn(`[DriveService] Could not set public permission: ${e.message}`)
      }
    }

    return {
      fileId,
      name: filename,
      webViewLink: file.data.webViewLink ?? `https://drive.google.com/file/d/${fileId}/view?usp=sharing`,
      webContentLink: file.data.webContentLink ?? undefined,
    }
  }
}
