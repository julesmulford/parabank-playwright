Integrate with a GitHub PR or GitLab MR to detect changed areas and run targeted tests.

User request: $ARGUMENTS

## Steps

1. Read `CLAUDE.md` to understand the project and test structure.

2. Determine the PR/MR reference from arguments (e.g. PR number, MR URL, branch name). If not provided, ask the user.

3. **Detect the platform** (GitHub or GitLab):

   **GitHub PR:**
   ```bash
   gh pr view <number> --json number,title,headRefName,baseRefName,files
   gh pr diff <number> --name-only
   ```

   **GitLab MR:**
   ```bash
   glab mr view <number> --output json
   glab mr diff <number> --name-only
   ```

   If neither `gh` nor `glab` CLI is available, ask the user to provide the diff manually or as a list of changed files.

4. Display the PR/MR summary:
   ```
   PR #42 — "Add account transfer feature"
   Branch: feature/account-transfer → main
   Author: @jules
   Changed files (5):
     tests/pages/TransferPage.ts     [NEW]
     tests/ui/transfer.spec.ts       [NEW]
     tests/api/transfer.spec.ts      [NEW]
     tests/fixtures/fixtures.ts      [MODIFIED]
     tests/data/factories.ts         [MODIFIED]
   ```

5. Map changed files to tests using the same logic as `/smart-test`:
   - New/modified spec files → run those files
   - Modified page objects → find and run all specs that import them
   - Modified fixtures → run all UI tests
   - Modified factories → run all tests that import from data/
   - Config changes → full suite

6. Show the impact analysis and test selection before running:
   ```
   Test selection for PR #42:
     tests/ui/transfer.spec.ts         (new spec)
     tests/api/transfer.spec.ts        (new spec)
     tests/ui/registration.spec.ts     (uses modified fixtures.ts)
     tests/api/parabank.spec.ts        (uses modified factories.ts)

   Command:
     npx playwright test tests/ui/transfer.spec.ts tests/api/transfer.spec.ts \
       tests/ui/registration.spec.ts tests/api/parabank.spec.ts
   ```

7. Ask for confirmation, then run.

8. After the run, produce a **PR test report**:
   ```
   PR #42 Test Report
   ==================
   Passed:  8 / 10
   Failed:  2 / 10
   Duration: 45s

   FAILURES:
   - tests/ui/transfer.spec.ts > Transfer Funds > should transfer between accounts
     Error: locator.click: Timeout — suggest running /fix-locators

   RECOMMENDATION:
   Do not merge until the 2 failing tests are resolved.
   Run /analyse-results for detailed failure diagnosis.
   ```

9. Offer next steps:
   - `/fix-locators` for locator failures
   - `/analyse-results` for full diagnosis
   - Re-run after fixes to confirm
