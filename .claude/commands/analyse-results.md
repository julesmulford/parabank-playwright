Run Playwright tests and analyse the results, diagnosing failures and suggesting fixes.

User request: $ARGUMENTS

## Steps

1. Read `CLAUDE.md` to understand the project conventions.

2. Determine which tests to run. If not specified in arguments, run all tests. Otherwise run the specified project/file/grep pattern.

3. Run tests with JSON reporter to get machine-readable output:
   ```bash
   npx playwright test --reporter=json $ARGUMENTS 2>&1 | tee /tmp/pw-results.json
   ```
   If the JSON is too large, use `--reporter=json,list` and parse only failures.

4. Parse the results and produce a **summary**:
   - Total: X passed, Y failed, Z skipped
   - List each failing test with: file path, test title, error message, line number

5. For **each failing test**, perform deep analysis:

   a. Read the test file
   b. Read any page objects the test uses
   c. Examine the error type:

   **Locator / timeout errors** (`locator.click: Timeout`, `locator.fill: Error`, `expect(locator).toBeVisible`):
   - The locator likely doesn't match any element
   - Read the page object for the failing locator
   - Check if the element may have been renamed in the UI
   - Suggest 2–3 alternative locators ordered by the project's locator priority (getByRole → getByLabel → getByTestId → getByText → id)
   - Flag this for `/fix-locators` if user wants to apply

   **Assertion errors** (`expect(received).toBe(expected)`):
   - Check if the application behaviour has changed vs what the test expects
   - Is this a data timing issue? (parallel tests creating same data)
   - Is this a response schema change in the API?

   **Navigation / network errors** (`net::ERR_CONNECTION_REFUSED`, `Response status is 404`):
   - Is Parabank running? Check if `http://localhost:3000/parabank/index.htm` is reachable
   - Is the route correct? Check `playwright.config.ts` baseURL

   **Type / import errors**:
   - Read the import paths and check they resolve correctly
   - Check if a fixture is missing from `tests/fixtures/fixtures.ts`

6. For each failure, output a structured diagnosis:
   ```
   FAILED: tests/ui/registration.spec.ts > Register
   Error: locator.click: Timeout 15000ms exceeded
   Locator: page.locator('[id="customer.firstName"]')

   Diagnosis: The element with id "customer.firstName" was not found within the timeout.
   Possible causes:
   - The page did not fully load before interaction
   - The element id has changed in the app

   Suggested alternative locators:
   1. page.getByLabel('First Name')              ← preferred (semantic)
   2. page.getByPlaceholder('First Name')
   3. page.locator('[name="customer.firstName"]') ← fallback

   To apply fixes: run /fix-locators tests/ui/registration.spec.ts
   ```

7. If all tests pass, summarise the run metrics and note any tests that were slow (> 30s) as candidates for optimisation.

8. Do **not** automatically modify any files — only diagnose and suggest. Offer to run `/fix-locators` for locator issues.
