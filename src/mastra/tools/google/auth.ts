import { OAuth2Client } from 'google-auth-library'
import { getDb } from '../../lib/mongo.js'

export type MailboxAccount = 'gastrobridge' | 'personal'
export const MAILBOX_ACCOUNTS: MailboxAccount[] = ['gastrobridge', 'personal']

const cachedAuthMap = new Map<MailboxAccount, OAuth2Client>()

/**
 * Get authenticated OAuth2 client for a given mailbox account.
 * Default is 'gastrobridge' for backward compatibility.
 */
export async function getGoogleAuth(account: MailboxAccount = 'gastrobridge'): Promise<OAuth2Client> {
  const cached = cachedAuthMap.get(account)
  if (cached) return cached

  const clientId = process.env.GOOGLE_CLIENT_ID
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET

  if (!clientId || !clientSecret) {
    throw new Error('Google OAuth not configured: missing GOOGLE_CLIENT_ID or GOOGLE_CLIENT_SECRET')
  }

  // 1. Try DB first
  let refreshToken: string | null = null
  try {
    const db = await getDb()
    const doc = await db.collection('google_accounts').findOne({ account })
    if (doc?.refreshToken) {
      refreshToken = doc.refreshToken
    }
  } catch {
    // DB lookup fallback
  }

  // 2. Fallback to ENV variables
  if (!refreshToken) {
    if (account === 'personal') {
      refreshToken = process.env.GOOGLE_REFRESH_TOKEN_PERSONAL ?? null
    } else {
      refreshToken = process.env.GOOGLE_REFRESH_TOKEN_GASTROBRIDGE ?? process.env.GOOGLE_REFRESH_TOKEN ?? null
    }
  }

  if (!refreshToken) {
    throw new Error(`Google OAuth not configured for account '${account}': missing refresh token. Run OAuth flow via /api/auth/google?account=${account}`)
  }

  const oauth2Client = new OAuth2Client(
    clientId,
    clientSecret,
    process.env.GOOGLE_REDIRECT_URI
  )

  oauth2Client.setCredentials({ refresh_token: refreshToken })

  // Force token refresh to validate
  await oauth2Client.getAccessToken()

  cachedAuthMap.set(account, oauth2Client)
  return oauth2Client
}

/**
 * Generate OAuth URL for user to authorize a specific account.
 */
export function getGoogleAuthUrl(account: MailboxAccount = 'personal'): string {
  const oauth2Client = new OAuth2Client(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    process.env.GOOGLE_REDIRECT_URI
  )

  return oauth2Client.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',
    scope: [...GOOGLE_OAUTH_SCOPES],
    state: account,
  })
}

/**
 * Full set of OAuth scopes used across Google tools.
 * Adding a new service here requires re-running the OAuth flow
 * to get a refresh token with the new scopes.
 */
export const GOOGLE_OAUTH_SCOPES = [
  // Calendar (existing)
  'https://www.googleapis.com/auth/calendar',
  'https://www.googleapis.com/auth/calendar.events',
  // Gmail (existing)
  'https://www.googleapis.com/auth/gmail.modify',
  'https://www.googleapis.com/auth/gmail.compose',
  // Sheets (new — Faza 6.1)
  'https://www.googleapis.com/auth/spreadsheets',
  // Slides (new — Faza 6.1)
  'https://www.googleapis.com/auth/presentations',
  // Drive — needed to create files (sheets/slides) and list/move them
  'https://www.googleapis.com/auth/drive.file',
] as const

/**
 * Exchange authorization code for tokens.
 */
export async function exchangeGoogleCode(code: string): Promise<{
  accessToken: string
  refreshToken: string
  expiryDate: number | null
}> {
  const oauth2Client = new OAuth2Client(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    process.env.GOOGLE_REDIRECT_URI
  )

  const { tokens } = await oauth2Client.getToken(code)

  return {
    accessToken: tokens.access_token ?? '',
    refreshToken: tokens.refresh_token ?? '',
    expiryDate: tokens.expiry_date ?? null
  }
}

/**
 * Save tokens in MongoDB google_accounts collection.
 */
export async function saveGoogleAccountTokens(account: MailboxAccount, tokens: {
  accessToken: string
  refreshToken: string
  expiryDate: number | null
}): Promise<void> {
  const db = await getDb()
  await db.collection('google_accounts').updateOne(
    { account },
    {
      $set: {
        account,
        accessToken: tokens.accessToken,
        ...(tokens.refreshToken ? { refreshToken: tokens.refreshToken } : {}),
        expiryDate: tokens.expiryDate,
        updatedAt: new Date(),
      },
    },
    { upsert: true }
  )

  clearGoogleAuthCache(account)
}

/**
 * Clear cached auth (for token rotation).
 */
export function clearGoogleAuthCache(account?: MailboxAccount): void {
  if (account) {
    cachedAuthMap.delete(account)
  } else {
    cachedAuthMap.clear()
  }
}
