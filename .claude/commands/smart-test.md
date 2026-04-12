Detect which parts of the app have changed and run only the relevant tests.

User request: $ARGUMENTS

## Steps

1. Read `CLAUDE.md` to understand the project structure and test locations.

2. Get the list of changed files. Try in this order:

   **If on a feature branch vs main:**
   ```bash
   git diff --name-only origin/main...HEAD
   ```

   **If checking uncommitted changes:**
   ```bash
   git diff --name-only HEAD
   git diff --name-only --cached
   ```

   If arguments specify a commit range or branch, use that instead.

3. Analyse the changed files and build a test selection map:

   | Changed file pattern | Tests to run |
   |---|---|
   | `tests/ui/*.spec.ts` | That specific file |
   | `tests/api/*.spec.ts` | That specific file |
   | `tests/pages/FooPage.ts` | Any spec that imports `FooPage` |
   | `tests/fixtures/fixtures.ts` | All UI tests (fixtures affect all) |
   | `tests/data/factories.ts` | All tests that import from data/factories |
   | `playwright.config.ts` | Full test suite |
   | `.env` / `.env.*` | Full test suite |
   | `.github/workflows/` | No tests needed (CI config only) |

4. To find which tests use a changed page object, grep for imports:
   ```bash
   grep -rl "FooPage" tests/
   ```

5. Build the minimal test run command(s). Examples:
   - Single file: `npx playwright test tests/ui/registration.spec.ts`
   - Multiple files: `npx playwright test tests/ui/login.spec.ts tests/api/accounts.spec.ts`
   - All UI: `npx playwright test --project=chromium`
   - All API: `npx playwright test --project=api`

6. Show the user the impact analysis before running:
   ```
   Changed files:
     tests/pages/RegistrationPage.ts
     tests/data/factories.ts

   Tests selected:
     tests/ui/registration.spec.ts  (imports RegistrationPage)
     tests/api/registration.spec.ts (imports from factories)

   Command: npx playwright test tests/ui/registration.spec.ts tests/api/registration.spec.ts
   ```

7. Ask for confirmation, then run the selected tests.

8. After the run, report the results summary and offer to run `/analyse-results` if there are failures.
