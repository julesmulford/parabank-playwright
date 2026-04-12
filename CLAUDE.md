# Playwright Automation Framework — Parabank

## Overview
TypeScript Playwright framework testing [Parabank](http://localhost:3000/parabank/), a demo banking application running as a Docker container (`parasoft/parabank`, port 3000→8080). Tests cover API, UI, Accessibility, and Performance.

## Tech Stack
- **Runner**: `@playwright/test` (Playwright v1.59+)
- **Language**: TypeScript, ESM (`"type": "module"`)
- **Accessibility**: `@axe-core/playwright` (install when writing a11y tests)
- **Base URL**: `http://localhost:3000/parabank/` (override via `BASE_URL` env var)

---

## Project Structure

```
tests/
  api/              # API-level specs — use request fixture, no browser
  ui/               # UI specs — use page objects via fixtures
  accessibility/    # Axe-core a11y specs — one file per page/feature
  performance/      # CDP performance metric specs
  pages/            # Page Object classes (one file = one class)
  actions/          # Reusable multi-step flows that compose page objects
  fixtures/
    fixtures.ts     # SINGLE fixture file — every page object registered here
  data/
    factories.ts    # Factory functions returning typed test data
    types.ts        # Shared TypeScript interfaces for test data
playwright.config.ts
.env                # Local overrides (gitignored)
.env.example        # Committed template
```

---

## Conventions

### Page Objects (`tests/pages/`)
- **One class per page**, filename equals class name: `AccountPage.ts` → `class AccountPage`
- Declare all locators as `readonly` constructor properties
- Methods = actions only — no assertions inside page objects
- Export a typed data `interface` alongside the class when a page takes structured input
- Always `export` the class

**Locator priority (best → last resort):**
1. `getByRole('button', { name: '...' })` — most resilient, semantically correct
2. `getByLabel('...')` — form fields
3. `getByTestId('...')` — when `data-testid` attributes exist
4. `getByText('...')` / `getByPlaceholder('...')` — visible text/placeholder
5. `locator('[id="customer.firstName"]')` — last resort when no accessible selector exists

**Never** use XPath, CSS class selectors (`.btn-primary`), or positional selectors (`nth-child`).

### Fixtures (`tests/fixtures/fixtures.ts`)
- **All** page objects must have a fixture entry here
- Tests always import `{ test, expect }` from `'../fixtures/fixtures'` — never directly from `@playwright/test`
- Pattern:
  ```ts
  type Fixtures = { loginPage: LoginPage; registrationPage: RegistrationPage; }
  export const test = base.extend<Fixtures>({
      loginPage: async ({ page }, use) => { await use(new LoginPage(page)); },
  });
  ```

### Actions (`tests/actions/`)
- For flows spanning multiple pages (e.g. "login then open new account")
- Accept instantiated page objects as parameters — not raw `Page`
- Named as verbs: `loginAsCustomer.ts`, `openNewAccount.ts`, `transferFunds.ts`

### Test Data (`tests/data/`)
- `factories.ts` — factory functions with sensible defaults; unique fields use `Date.now()` or `crypto.randomUUID()`
- `types.ts` — shared interfaces (separate from page-level interfaces)
- **Never** hardcode usernames or data that would collide in parallel runs

### API Tests (`tests/api/`)
- Use the `request` fixture (pre-configured in `playwright.config.ts` with base URL and headers)
- Use `beforeAll` for registration/auth setup; share state via module-level `let` variables
- Avoid `playwrightRequest.newContext()` unless you need a separate auth context

### UI Tests (`tests/ui/`)
- Always import from `'../fixtures/fixtures'`
- Group tests in `test.describe` blocks by feature
- Tag critical happy-path tests: `test('login @smoke', ...)`

### Accessibility Tests (`tests/accessibility/`)
- Use `checkA11y` from `@axe-core/playwright`
- Test key states: page load, after form interaction, post-navigation
- Assert zero violations at `wcag2a` and `wcag2aa` levels

### Performance Tests (`tests/performance/`)
- Use Playwright CDP session to capture timing metrics
- Assert thresholds: LCP < 2500ms, FCP < 1800ms, TTI < 3500ms

---

## Running Tests

```bash
npx playwright test                                      # all
npx playwright test --project=api                        # API only
npx playwright test --project=chromium                   # UI (Chromium)
npx playwright test --grep @smoke                        # smoke suite
npx playwright test tests/ui/registration.spec.ts        # single file
npx playwright test --reporter=json > results.json       # machine-readable output
```

---

## Environment

```bash
BASE_URL=http://localhost:3000/parabank/   # override target
TEST_ENV=staging                           # loads .env.staging
```

Parabank setup:
```bash
docker run -d -p 3000:8080 parasoft/parabank
curl -X POST http://localhost:3000/parabank/services/bank/initializeDB
```

---

## Rules for AI Code Generation

- **DO NOT** import `test`/`expect` from `@playwright/test` in test files — use the fixtures wrapper
- **DO NOT** put assertions inside page object methods
- **DO NOT** use `page.waitForTimeout()` — use `expect(locator).toBeVisible()` or Playwright action auto-wait
- **DO NOT** hardcode data that conflicts across parallel runs — always use uniqueness strategies
- **DO NOT** create helpers, abstractions, or new files speculatively — only what the task requires
- **ALWAYS** add new page objects to `tests/fixtures/fixtures.ts`
- **ALWAYS** show generated code and wait for user approval before writing files
- **ALWAYS** follow the locator priority order above
- **ALWAYS** place files in the correct directory per the structure above
