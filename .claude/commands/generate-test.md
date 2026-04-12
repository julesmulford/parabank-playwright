Generate a Playwright test for this project.

User request: $ARGUMENTS

## Steps

1. Read `CLAUDE.md` to understand project conventions and structure.

2. If the test type or feature is not clear from the arguments, ask the user:
   - **Type**: ui / api / accessibility / performance
   - **Feature**: what page, endpoint, or user journey to test
   - **Scenario**: happy path, edge case, negative test?

3. Read existing similar tests for patterns:
   - UI test → read `tests/ui/*.spec.ts`
   - API test → read `tests/api/*.spec.ts`
   - A11y test → read `tests/accessibility/*.spec.ts` (if any)
   - Performance test → read `tests/performance/*.spec.ts` (if any)

4. Read relevant page objects from `tests/pages/` if writing a UI or accessibility test.

5. Read `tests/fixtures/fixtures.ts` to understand available fixtures.

6. Read `tests/data/factories.ts` and `tests/data/types.ts` for test data patterns.

7. Generate the test following these rules:
   - Place in the correct directory: `tests/ui/`, `tests/api/`, `tests/accessibility/`, `tests/performance/`
   - Import `{ test, expect }` from `'../fixtures/fixtures'` (never from `@playwright/test` directly) for UI/a11y tests
   - API tests may import from `@playwright/test` directly
   - Use `test.describe` blocks grouped by feature
   - Add `@smoke` tag to critical happy-path tests
   - Use factory functions from `tests/data/factories.ts` for test data — do not hardcode
   - No assertions inside page object methods
   - No `page.waitForTimeout()` — use action auto-wait or `expect(locator).toBeVisible()`

8. **UI test structure**:
   ```ts
   import { test, expect } from '../fixtures/fixtures';

   test.describe('Feature Name', () => {
       test('does something @smoke', async ({ pageObjectFixture }) => {
           await pageObjectFixture.goto();
           await pageObjectFixture.doAction(data);
           await expect(pageObjectFixture.someLocator).toBeVisible();
       });
   });
   ```

9. **API test structure**:
   ```ts
   import { test, expect } from '@playwright/test';

   test.describe('API - Feature Name', () => {
       test('GET /endpoint returns 200', async ({ request }) => {
           const res = await request.get('services/bank/...');
           expect(res.ok()).toBeTruthy();
           const body = await res.json();
           expect(body.field).toBe('value');
       });
   });
   ```

10. **Accessibility test structure**:
    ```ts
    import { test, expect } from '../fixtures/fixtures';
    import AxeBuilder from '@axe-core/playwright';

    test.describe('Accessibility - Page Name', () => {
        test('has no WCAG 2.1 AA violations on load', async ({ page }) => {
            await page.goto('register.htm');
            const results = await new AxeBuilder({ page })
                .withTags(['wcag2a', 'wcag2aa'])
                .analyze();
            expect(results.violations).toEqual([]);
        });
    });
    ```

11. **Performance test structure**:
    ```ts
    import { test, expect } from '@playwright/test';

    test.describe('Performance - Page Name', () => {
        test('LCP is within threshold', async ({ page }) => {
            await page.goto('index.htm');
            const lcp = await page.evaluate(() =>
                new Promise<number>(resolve => {
                    new PerformanceObserver(list => {
                        const entries = list.getEntries();
                        resolve(entries[entries.length - 1].startTime);
                    }).observe({ type: 'largest-contentful-paint', buffered: true });
                })
            );
            expect(lcp).toBeLessThan(2500);
        });
    });
    ```

12. If a new page object is required that doesn't yet exist, say so and ask the user if they'd like to run `/generate-page-object` first.

13. If a new fixture entry is needed (new page object used), add it to `tests/fixtures/fixtures.ts`.

14. **Show the complete generated code** and ask for confirmation before writing any files.
