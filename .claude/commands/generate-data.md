Generate test data factories or types for this project.

User request: $ARGUMENTS

## Steps

1. Read `CLAUDE.md` for data conventions.

2. Read `tests/data/factories.ts` and `tests/data/types.ts` (if they exist) to understand existing patterns.

3. Read any relevant page objects or test files to understand what shape of data is needed.

4. If not clear from arguments, ask:
   - **What entity** needs data? (customer, account, transaction, loan application)
   - **What fields** are required vs optional with sensible defaults?
   - **Any uniqueness constraints**? (username, SSN, email must be unique per run)

5. Generate factory functions following these rules:
   - Unique fields use `Date.now()` suffix or `crypto.randomUUID()`
   - Provide defaults for every field so callers can override only what they need
   - Factory returns a fully typed object
   - Keep factories in `tests/data/factories.ts`
   - Keep interfaces/types in `tests/data/types.ts`

6. **Factory template**:
   ```ts
   // tests/data/factories.ts
   import type { CustomerData } from './types';

   export function buildCustomer(overrides: Partial<CustomerData> = {}): CustomerData {
       const ts = Date.now();
       return {
           firstName: 'Test',
           lastName: `User${ts}`,
           street: '123 High Street',
           city: 'York',
           state: 'North Yorkshire',
           zipCode: 'YO1 9DF',
           phone: '07700901234',
           ssn: String(Math.floor(100000000 + Math.random() * 900000000)),
           username: `testuser_${ts}`,
           password: 'Password123!',
           ...overrides,
       };
   }
   ```

7. **Types template**:
   ```ts
   // tests/data/types.ts
   export interface CustomerData {
       firstName: string;
       lastName: string;
       street: string;
       city: string;
       state: string;
       zipCode: string;
       phone: string;
       ssn: string;
       username: string;
       password: string;
   }
   ```

8. **Show the generated code** and confirm before writing. Also note any existing tests that hardcode data and could be refactored to use the new factory.
