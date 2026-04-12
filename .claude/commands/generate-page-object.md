Generate a Playwright Page Object class for this project.

User request: $ARGUMENTS

## Steps

1. Read `CLAUDE.md` to understand conventions, especially the locator priority order.

2. If not specified, ask the user:
   - **Page name**: e.g. "Login page", "Account overview"
   - **Route**: e.g. `login.htm`, `overview.htm`
   - **Key actions**: what does a user do on this page? (fill form, click button, read balance)

3. Read existing page objects for style reference:
   - `tests/pages/RegistrationPage.ts`
   - `tests/pages/LoginPage.ts`

4. Read `tests/fixtures/fixtures.ts` to understand the current fixture registrations.

5. If Parabank is running (check if `http://localhost:3000/parabank/index.htm` is reachable), navigate to the page and use Playwright's inspector output or describe visible elements to determine locators. Otherwise, infer locators from the feature description and existing patterns.

6. Generate the page object following these rules:
   - File: `tests/pages/{PageName}Page.ts`
   - Class name: `{PageName}Page`
   - All locators as `readonly` properties in the constructor
   - **Locator priority**:
     1. `getByRole('button', { name: '...' })` — preferred
     2. `getByLabel('...')` — for form fields
     3. `getByTestId('...')` — if `data-testid` exists
     4. `getByText('...')` / `getByPlaceholder('...')`
     5. `locator('[id="..."]')` — last resort only
   - Never XPath, CSS class selectors, or positional selectors
   - Methods are actions only — no assertions
   - Export the class and any data interface

7. **Template**:
   ```ts
   import { Page, Locator } from '@playwright/test';

   export class AccountPage {
       readonly page: Page;
       readonly balance: Locator;
       readonly transferButton: Locator;

       constructor(page: Page) {
           this.page = page;
           this.balance = page.getByRole('cell', { name: /\$[\d,]+/ });
           this.transferButton = page.getByRole('link', { name: 'Transfer Funds' });
       }

       async goto(accountId: string) {
           await this.page.goto(`activity.htm?id=${accountId}`);
       }

       async clickTransfer() {
           await this.transferButton.click();
       }
   }

   export interface AccountData {
       accountId: string;
   }
   ```

8. After generating the page object, also generate the fixture entry to add to `tests/fixtures/fixtures.ts`:
   ```ts
   // Add to Fixtures type:
   accountPage: AccountPage;

   // Add to base.extend:
   accountPage: async ({ page }, use) => { await use(new AccountPage(page)); },
   ```

9. **Show the complete generated code** for both files and confirm with the user before writing.
