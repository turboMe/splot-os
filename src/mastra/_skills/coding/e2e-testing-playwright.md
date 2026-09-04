---
name: e2e-testing-playwright
category: coding
description: >-
  End-to-end testing using Playwright. Covers writing, running, and
  debugging e2e tests for web applications. Includes patterns for
  page objects, test fixtures, assertions, and visual regression.
  Integrates with QA SubAgent role for automated test execution.
keywords: [testing, e2e, playwright, qa, automation, regression, integration]
allowedTools: [shell_execute, fs_read_file, coding_write_file_tracked, coding_run_test]
minComplexity: moderate
recommendedTier: pro
estimatedTokens: 800
outputFormat: text
tags: [testing, e2e, qa, playwright]
version: 1
success_rate: null
total_uses: 0
last_used: null
handoffCapable: true
---
# E2E Testing with Playwright

> Adapted from [OpenAI playwright-interactive skill](https://github.com/openai/codex-skills).

## Trigger
- "Write e2e tests for this feature"
- "Test the login flow"
- "Verify the UI works end-to-end"
- QA SubAgent automated testing

## Setup

### Install (one-time)
```bash
npm install -D @playwright/test
npx playwright install chromium
```

### Config (`playwright.config.ts`)
```typescript
import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests/e2e',
  timeout: 30_000,
  retries: 1,
  use: {
    baseURL: process.env.BASE_URL || 'http://localhost:3000',
    headless: true,
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
  },
});
```

## Test Patterns

### Basic Navigation Test
```typescript
import { test, expect } from '@playwright/test';

test('homepage loads successfully', async ({ page }) => {
  await page.goto('/');
  await expect(page).toHaveTitle(/My App/);
  await expect(page.locator('h1')).toBeVisible();
});
```

### Form Submission Test
```typescript
test('user can submit contact form', async ({ page }) => {
  await page.goto('/contact');
  await page.fill('[name="email"]', 'test@example.com');
  await page.fill('[name="message"]', 'Hello from e2e test');
  await page.click('button[type="submit"]');
  await expect(page.locator('.success-message')).toBeVisible();
});
```

### Authentication Flow
```typescript
test('user can log in', async ({ page }) => {
  await page.goto('/login');
  await page.fill('[name="email"]', 'test@example.com');
  await page.fill('[name="password"]', 'testpass123');
  await page.click('button[type="submit"]');
  await expect(page).toHaveURL('/dashboard');
  await expect(page.locator('[data-testid="user-name"]')).toContainText('Test');
});
```

### Page Object Pattern
```typescript
class LoginPage {
  constructor(private page: Page) {}
  
  async login(email: string, password: string) {
    await this.page.fill('[name="email"]', email);
    await this.page.fill('[name="password"]', password);
    await this.page.click('button[type="submit"]');
  }
  
  async expectSuccess() {
    await expect(this.page).toHaveURL('/dashboard');
  }
}
```

## Running Tests

```bash
# Run all e2e tests
npx playwright test

# Run specific test file
npx playwright test tests/e2e/login.spec.ts

# Run in headed mode (visible browser)
npx playwright test --headed

# Run with UI mode (interactive)
npx playwright test --ui

# Generate report
npx playwright show-report
```

## Best Practices

1. **Use data-testid attributes** for stable selectors
2. **Avoid sleep()** — use `waitForSelector()` or `expect().toBeVisible()`
3. **Isolate tests** — each test should start from a clean state
4. **Use fixtures** for common setup (login, seed data)
5. **Screenshot on failure** — configured automatically
6. **Keep tests fast** — target < 10s per test

## Integration with QA SubAgent

The QA SubAgent can run e2e tests via `coding.run_test`:
```typescript
coding.run_test({ command: 'npx playwright test --reporter=json' })
```

## Success Criteria
- Tests use Page Object pattern for reusability
- All critical user flows covered
- Tests run in < 60s total
- Screenshots captured on failure
- No flaky tests (retry mechanism in config)
