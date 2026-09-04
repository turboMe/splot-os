---
name: browser-login-flow
category: coding
description: >-
  Browser login and authentication flow patterns for Playwright MCP.
  Covers session management, cookie persistence, MFA handling,
  credential safety, and OAuth/SSO flows.
keywords: [browser, login, authentication, session, cookie, oauth, mfa, playwright]
allowedTools: [shell_execute, fs_read_file]
minComplexity: moderate
recommendedTier: pro
estimatedTokens: 850
outputFormat: text
tags: [browser, auth, security, automation]
version: 1
success_rate: null
total_uses: 0
last_used: null
handoffCapable: true
---
# Browser Login Flow

## Trigger
- "Log into website X"
- "Automate login for testing"
- "Handle authentication in browser automation"

## Login Flow Procedure

### Step 1: Navigate to login page
```
browser_navigate({ url: 'https://app.example.com/login' })
browser_snapshot()
```

### Step 2: Identify login form
Look for in snapshot:
- Email/username input
- Password input
- Submit/login button
- "Remember me" checkbox
- OAuth buttons (Google, GitHub, etc.)

### Step 3: Fill credentials
```
browser_fill({ ref: 'email-ref', value: '<test-email>' })
browser_fill({ ref: 'password-ref', value: '<test-password>' })
browser_click({ ref: 'submit-ref' })
```

### Step 4: Verify login success
```
browser_snapshot()
```
Check for:
- ✅ Dashboard/home page loaded
- ✅ User name/avatar visible
- ❌ Error message ("Invalid credentials")
- ❌ Still on login page

## Authentication Patterns

### Standard Email/Password
Most common. Fill email + password → submit.

### OAuth / SSO (Google, GitHub, etc.)
```
1. Click "Sign in with Google" button
2. browser_snapshot() — new window/redirect to Google
3. Fill Google email → "Next"
4. Fill Google password → "Next"
5. Handle consent screen if shown
6. Auto-redirect back to app
7. browser_snapshot() — verify logged in
```
⚠️ OAuth flows often open new windows — MCP may need special handling.

### Two-Factor Authentication (2FA/MFA)
```
1. After password, check if 2FA page appears
2. If TOTP: user must provide code manually
3. If SMS: user must provide code manually
4. If push notification: wait for approval
```
⚠️ 2FA cannot be fully automated — alert user when 2FA is required.

### Magic Link / Email Login
```
1. Enter email → submit
2. Alert user: "Check email for login link"
3. Cannot proceed automatically — need user to click link
```

## Session Management

### Cookie Persistence
After successful login, browser cookies are active for the session.
Subsequent `browser_navigate` calls maintain the session.

### Session Check
```
browser_evaluate({
  expression: 'document.cookie.includes("session") || document.cookie.includes("token")'
})
```

### Force Logout
```
browser_navigate({ url: 'https://app.example.com/logout' })
```
Or clear cookies:
```
browser_evaluate({ expression: 'document.cookie.split(";").forEach(c => document.cookie = c.trim().split("=")[0] + "=;expires=Thu, 01 Jan 1970 00:00:00 GMT")' })
```

## Credential Safety Rules

### 🔴 NEVER
- Use production credentials in automated tests
- Store credentials in skill files or logs
- Expose passwords in screenshots
- Send credentials to external services

### 🟢 ALWAYS
- Use test/staging accounts
- Source credentials from environment variables
- Redact credentials in logs (→ secrets-redactor)
- Rotate test credentials regularly

### Credential Resolution
```typescript
// In test code
const email = process.env.TEST_USER_EMAIL;
const password = process.env.TEST_USER_PASSWORD;
```

## Error Handling

| Scenario | Recovery |
|----------|----------|
| Wrong password | Check error message → report to user |
| Account locked | Cannot proceed → report to user |
| CAPTCHA appears | Cannot automate → report to user |
| Session expired | Re-navigate to login → re-authenticate |
| Network error | Retry after 5s, max 3 attempts |

## Success Criteria
- Login form detected and filled
- Login success verified (dashboard loaded)
- No credentials in logs or screenshots
- Session active for subsequent requests
- Error handling for common failures
