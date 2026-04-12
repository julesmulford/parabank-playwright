Suggest and (with approval) apply locator fixes for failing Playwright tests.

User request: $ARGUMENTS

## Steps

1. Read `CLAUDE.md` — especially the locator priority order.

2. Identify which file(s) to inspect. If not in arguments, ask the user which test file or page object has failing locators.

3. Read the test file(s) and their associated page objects from `tests/pages/`.

4. If a recent test run result is available (e.g. from `/analyse-results`), use the error messages to pinpoint which locators failed. Otherwise, run the specific test with verbose output to get the failure:
   ```bash
   npx playwright test <file> --reporter=list 2>&1
   ```

5. For each broken locator:

   a. Note the current locator and what error it produced
   b. Apply the locator priority rules to generate better alternatives:
      - Can `getByRole()` match this element? (buttons, links, headings, inputs with accessible name)
      - Can `getByLabel()` match it? (labelled form fields)
      - Is there a `data-testid`? Use `getByTestId()`
      - Is there visible text? Use `getByText()` or `getByPlaceholder()`
      - Fall back to `locator('[id="..."]')` only if no accessible selector works
   c. Propose **2–3 ranked alternatives** with reasoning

6. Present a clear diff for each change:
   ```
   FILE: tests/pages/RegistrationPage.ts

   CURRENT:
     this.firstName = page.locator('[id="customer.firstName"]')

   PROPOSED (ranked):
   1. this.firstName = page.getByLabel('First Name')          ← semantic, most resilient
   2. this.firstName = page.getByPlaceholder('First Name')    ← fallback
   3. this.firstName = page.locator('[name="customer.firstName"]') ← attribute fallback
   ```

7. **Ask the user to confirm** before making any changes:
   - "Which alternative would you like me to apply? (1/2/3 or skip)"
   - Apply ONLY the chosen fix, nothing else

8. After user approval, apply the selected locator change(s) using the Edit tool.

9. After applying, offer to re-run the affected test to verify:
   ```bash
   npx playwright test <file> --project=chromium
   ```

10. **Never apply changes automatically without explicit user confirmation** — this is a review-then-apply workflow.
