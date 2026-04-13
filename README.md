# Parabank Playwright Framework — with AI Agents

A TypeScript Playwright test automation framework for the Parabank demo banking application, extended with **nine Claude-powered AI agents** that automate the tasks that typically slow teams down: generating tests, healing broken locators, detecting flaky tests, analyzing failures, and reviewing conventions. Runs on **Azure DevOps**, **AWS CodeBuild**, and **CircleCI**.

---

## Tech Stack

- **Playwright** — UI, API, Accessibility, and Performance testing
- **TypeScript** — ESM module format
- **Claude AI** — Haiku, Sonnet, and Opus models via `@anthropic-ai/sdk`
- **Node 20**
- **Docker** — Parabank runs as a local container
- **CI/CD** — Azure DevOps, AWS CodeBuild, CircleCI

---

## Local Setup

### 1. Install dependencies

```bash
npm install
npx playwright install
```

### 2. Start Parabank

```bash
docker run -p 3000:8080 parasoft/parabank
```

### 3. Initialise the database

```bash
curl -X POST http://localhost:3000/parabank/services/bank/initializeDB
```

### 4. Run tests

```bash
npx playwright test                                          # all tests
npx playwright test --headed                                 # with browser visible
npx playwright test tests/api/parabank.spec.ts --project=api # API tests only
npx playwright test --grep @smoke                            # smoke suite only
npx playwright test --reporter=json > results.json           # machine-readable output
```

---

## AI Agents

All agents live in `tests/agents/` and run with `npx tsx`. They require an `ANTHROPIC_API_KEY` environment variable.

```bash
export ANTHROPIC_API_KEY=sk-ant-...
```

### Agent overview

| Agent | Model | What it does |
|---|---|---|
| `orchestrator` | Haiku | Picks the minimal test command for changed files |
| `testGenerator` | Opus + thinking | Generates complete, convention-correct test files |
| `locatorHealer` | Opus + thinking | Fixes broken locators against the live app |
| `analyzer` | Sonnet | Analyzes failed test runs and diagnoses root causes |
| `traceInspector` | Opus + thinking | Deep timeline analysis of Playwright traces |
| `flakinessDetector` | Sonnet | Runs a spec N times and classifies flaky tests |
| `coverageReporter` | Sonnet | Crawls the app and maps gaps in test coverage |
| `conventionReviewer` | Haiku | Static + AI review of test files against conventions |
| `dataFactory` | Sonnet | Generates boundary-aware test data variants |

All agents use **prompt caching** (`cache_control: ephemeral`) so repeated invocations only pay for what changes between calls. Models are chosen to match task complexity — Haiku for classification, Sonnet for analysis, Opus + extended thinking for code generation.

---

### Orchestrator

**What it does:** Looks at which files have changed (via `git diff`) and asks Claude to decide the minimal `npx playwright test` command that covers those changes. Avoids running the full 4-project suite when only an API spec changed.

```bash
npx tsx tests/agents/orchestrator.ts                  # diff against HEAD, print command
npx tsx tests/agents/orchestrator.ts --run            # diff and execute the command
npx tsx tests/agents/orchestrator.ts --base main      # diff against main branch
npx tsx tests/agents/orchestrator.ts --verbose        # show token usage and cache hit stats
```

**Output:** A single `npx playwright test ...` command on stdout (pipe-friendly for CI), or `no-tests-needed` for doc/config-only changes.

**CI usage:** Use `--base origin/main` in CI pipelines where HEAD already includes the commit.

**Possible improvements:**
- Cache the full decision table as a lookup (skip Claude for exact match patterns)
- Add `--dry-run` that prints cost estimate before committing to the run
- Extend decision rules to map page object changes to only the specs that import them

---

### Test Generator

**What it does:** Given a feature description and test type, generates a complete, convention-correct Playwright test — including the page object if one doesn't exist. Validates with `tsc --noEmit` before writing. Uses three-level prompt caching: static rules (always cached) → project context (cached for 5 min) → feature request (never cached).

```bash
npx tsx tests/agents/testGenerator.ts --feature "transfer funds between accounts"
npx tsx tests/agents/testGenerator.ts --feature "loan request" --type api
npx tsx tests/agents/testGenerator.ts --feature "registration page" --type accessibility
npx tsx tests/agents/testGenerator.ts --feature "home page load" --type performance
npx tsx tests/agents/testGenerator.ts --feature "login" --type ui --write   # confirm then write files
```

**Flags:**
- `--feature` — description of what to test (required)
- `--type` — `ui` (default) | `api` | `accessibility` | `performance`
- `--write` — prompt for confirmation then write files to disk

**Output:** Streams generated TypeScript to stdout. With `--write`, validates TypeScript then writes files and warns if new page objects need registering in `fixtures.ts`.

**Possible improvements:**
- Accept an existing spec as a style reference so the model matches local patterns exactly
- Auto-register new page objects into `fixtures.ts` instead of just warning
- Add `--model sonnet` flag for cheaper generation when extended thinking isn't needed

---

### Locator Healer

**What it does:** Reads all page objects in `tests/pages/`, visits each page in a real Playwright browser, extracts the interactive DOM (forms, buttons, inputs), and asks Claude Opus to rewrite any locator that no longer matches the live app. Shows a diff before writing. Shares a single browser instance across all healing passes.

```bash
npx tsx tests/agents/locatorHealer.ts --page LoginPage
npx tsx tests/agents/locatorHealer.ts --page AccountPage --write
npx tsx tests/agents/locatorHealer.ts --all                       # heal every page object
npx tsx tests/agents/locatorHealer.ts --all --write               # heal all and write changes
npx tsx tests/agents/locatorHealer.ts --page LoginPage --auth john john  # login before visiting
```

**Flags:**
- `--page` — page object class name (e.g. `LoginPage`)
- `--all` — heal every page object in `tests/pages/`
- `--write` — write healed files to disk (shows diff first)
- `--auth <username> <password>` — login before visiting authenticated pages

**Output:** Unified diff of locator changes to stdout. With `--write`, overwrites the page object files.

**Possible improvements:**
- Run the existing test suite after healing to verify no regressions
- Add `--confidence low|medium|high` to filter out speculative heals
- Generate a healing report showing which locators changed and why

---

### Failure Analyzer

**What it does:** Reads Playwright test results (JSON or JUnit XML) and any artifacts in `test-results/` (screenshots, error-context files) and produces a structured failure analysis for every test that failed: root cause category, confidence level, verbatim evidence, and a concrete fix. Pre-processes large JSON reports to extract only failures before sending to Claude — avoids sending megabytes of passing-test metadata.

```bash
npx tsx tests/agents/analyzer.ts                                  # auto-detect results.json or junit.xml
npx tsx tests/agents/analyzer.ts --results test-results/results.json
npx tsx tests/agents/analyzer.ts --results test-results/junit.xml
npx tsx tests/agents/analyzer.ts --output report.md               # save Markdown report
npx tsx tests/agents/analyzer.ts --compare run-a.json run-b.json  # flakiness diff between two runs
```

**Flags:**
- `--results` — path to JSON or XML results file
- `--output` — save the Markdown report to a file
- `--compare` — diff two JSON result files to identify tests that changed status between runs

**Output:** Structured Markdown with per-failure root cause analysis and a health verdict (`✅ Healthy / ⚠️ At Risk / 🔴 Critical`).

**Possible improvements:**
- Group related failures by shared stack trace signature (deduplicate noise from cascading failures)
- Integrate with `traceInspector` automatically when traces are detected
- Support Allure JSON format in addition to Playwright JSON and JUnit XML

---

### Trace Inspector

**What it does:** Extracts a `trace.zip` artefact produced by Playwright, parses the NDJSON event log (actions, network calls, console messages, errors), and asks Claude Opus with extended thinking to produce a timeline, pinpoint the exact failure, diagnose the root cause, and recommend fixes. Cross-platform zip extraction (PowerShell on Windows, `unzip` on Unix).

```bash
npx tsx tests/agents/traceInspector.ts --trace test-results/trace.zip
npx tsx tests/agents/traceInspector.ts --trace test-results/trace.zip --output analysis.md
npx tsx tests/agents/traceInspector.ts --all                       # inspect every trace.zip in test-results/
```

**Flags:**
- `--trace` — path to a specific `trace.zip`
- `--all` — find and inspect every `trace.zip` under `test-results/`
- `--output` — save the Markdown report (with `--all`, per-trace filenames are generated automatically)

**Output:** Chronological timeline, exact failure point with error message, root cause category with confidence, and two-level fix recommendations (immediate + long-term).

**Tip:** Enable traces in `playwright.config.ts` with `trace: 'on-first-retry'` — traces are then captured automatically for any test that needed a retry.

**Possible improvements:**
- Add screenshot extraction from the trace zip to pass image content alongside the NDJSON
- Support `--since 10m` to only inspect traces newer than a given time window
- Correlate trace timeline with network HAR data for API-level failures

---

### Flakiness Detector

**What it does:** Runs a spec file N times (default 5), collects pass/fail/timeout status per test per run, then asks Claude to classify each non-passing test as Stable-Failing, Flaky, Timeout-prone, or Environment-sensitive — and recommend a concrete fix for each.

```bash
npx tsx tests/agents/flakinessDetector.ts --spec tests/ui/registration.spec.ts
npx tsx tests/agents/flakinessDetector.ts --spec tests/api/parabank.spec.ts --runs 10
npx tsx tests/agents/flakinessDetector.ts --spec tests/ui/login.spec.ts --runs 5 --output flaky-report.md
```

**Flags:**
- `--spec` — path to the spec file to test (required)
- `--runs` — number of times to run the spec (default `5`, max `50`)
- `--output` — save the Markdown report to a file

**Output:** Per-test classification with pass rate, run pattern, likely cause, and fix. Ends with a reliability summary. Stable-passing tests are omitted from the Claude prompt — if all tests pass every run, the agent exits early without any Claude call.

**Possible improvements:**
- Accept multiple specs or a glob pattern to batch-test a whole directory
- Add `--parallel` to run the N iterations concurrently instead of sequentially
- Feed flaky test names directly into `traceInspector` for deeper analysis

---

### Coverage Reporter

**What it does:** Crawls the Parabank UI (unauthenticated, and optionally authenticated) to discover all reachable pages, then scans existing spec files for their test keywords, and asks Claude to produce a risk-scored gap report — which pages aren't tested, which are only partially covered, and what to write next.

```bash
npx tsx tests/agents/coverageReporter.ts
npx tsx tests/agents/coverageReporter.ts --auth john john
npx tsx tests/agents/coverageReporter.ts --output coverage-gaps.md
npx tsx tests/agents/coverageReporter.ts --auth john john --output coverage-gaps.md
```

**Flags:**
- `--auth <username> <password>` — login to discover authenticated-only pages
- `--output` — save the Markdown report to a file

**Output:** Coverage summary (X/Y pages tested), well-covered pages, partial coverage gaps, and a prioritized list of untested pages by risk level (Critical/High/Medium/Low) with suggested test scenarios. Ends with a recommended next-sprint plan naming the top 3 test files to create.

**Possible improvements:**
- Add `--sitemap` to seed the crawler from an XML sitemap instead of link-following
- Track coverage trend over time by diffing against a previous report
- Cross-reference with the risk register to weight risk scores against actual business impact

---

### Convention Reviewer

**What it does:** Two-phase review of TypeScript test files. Phase 1 runs instant zero-cost regex checks for the most common violations (wrong imports, `waitForTimeout`, XPath, CSS class selectors, hardcoded usernames, missing `describe` blocks). Phase 2 sends file content and Phase 1 findings to Claude Haiku for subtler issues the regex can't catch.

```bash
npx tsx tests/agents/conventionReviewer.ts                         # review all test files
npx tsx tests/agents/conventionReviewer.ts --staged                # review only git-staged files
npx tsx tests/agents/conventionReviewer.ts --files tests/ui/login.spec.ts
npx tsx tests/agents/conventionReviewer.ts --files tests/ui/ tests/api/
npx tsx tests/agents/conventionReviewer.ts --staged --skip-ai      # static analysis only (instant, free)
npx tsx tests/agents/conventionReviewer.ts --files tests/ui/ --output review.md
```

**Flags:**
- `--files` — one or more file paths or directories
- `--staged` — review only files staged in git (ideal for pre-commit hooks)
- `--skip-ai` — run Phase 1 only (no Claude call, no API cost)
- `--output` — save the full Markdown report to a file

**Output:** Phase 1 static findings (CRITICAL/MAJOR/MINOR per violation), Phase 2 AI findings for subtler issues, and a final verdict (`🔴 BLOCK / ⚠️ WARN / ✅ PASS`).

**Pre-commit hook setup:**
```bash
# .husky/pre-commit
npx tsx tests/agents/conventionReviewer.ts --staged --skip-ai
```

**Possible improvements:**
- Auto-fix trivial violations (wrong import path, missing `@smoke` tag) instead of just reporting
- Add a `--fix` flag that applies Claude's suggested corrections directly to files
- Extend static rules to catch missing `beforeEach` cleanup or shared mutable state between tests

---

### Data Factory

**What it does:** Generates realistic, boundary-aware test data factory functions for Parabank entities. Reads existing `types.ts` and `factories.ts` so all output matches the schema and naming conventions exactly. Deduplicates against existing function names before writing so re-running is safe.

```bash
npx tsx tests/agents/dataFactory.ts --entity customer
npx tsx tests/agents/dataFactory.ts --entity customer --scenario "invalid ssn"
npx tsx tests/agents/dataFactory.ts --entity customer --count 5
npx tsx tests/agents/dataFactory.ts --entity customer --write            # append to factories.ts
npx tsx tests/agents/dataFactory.ts --entity customer --output variants.ts  # write standalone file
```

**Flags:**
- `--entity` — entity type to generate data for (default `customer`)
- `--scenario` — focus on a specific edge case (e.g. `"minimum length fields"`, `"special characters"`)
- `--count` — number of factory variants to generate (default `3`, max `20`)
- `--write` — append generated functions to `tests/data/factories.ts`
- `--output` — write to a standalone file instead of appending

**Output:** Explanation of each variant and its test purpose, then all TypeScript code in a single block. With `--write`, strips the import line, deduplicates against existing exports, and appends to `factories.ts` with a timestamp comment.

**Possible improvements:**
- Support `--entity account`, `--entity transaction` as Parabank adds more entity types
- Add `--validate` flag to run generated factories through the registration flow to confirm they're accepted by the app
- Generate data tables (arrays of variants) for `test.each` parameterized tests

---

## CI/CD Pipelines

### Azure DevOps (`azure-pipelines.yml`)

Triggers on push to `main` or `develop`, and on PRs targeting `main`.

Uses a **self-hosted agent** running on your local machine. Before triggering any pipeline job:

1. Start **Docker Desktop** and wait for it to be ready (whale icon in system tray)
2. Start the local Azure agent:
   ```bash
   cd C:\Azure-agent
   run.cmd
   ```
   Keep this terminal open — the agent must be running to pick up jobs. If the agent is not running, jobs will queue indefinitely.
3. Trigger via push to `main`/`develop` or manually via the Azure DevOps UI.

---

### AWS CodeBuild (`buildspec.yml`)

Uses the AWS free tier — **100 build minutes/month** on `BUILD_GENERAL1_SMALL`.

Triggered **manually** to avoid unexpected charges:
1. Go to AWS Console → **CodeBuild** → `parabank-playwright`
2. Click **Start build**

Artifacts (HTML report, test results) are uploaded to S3 after each run.
Test results are parsed and displayed in the CodeBuild Test Reports tab.

> Privileged mode must be enabled on the CodeBuild project for Docker to work.

---

### CircleCI (`.circleci/config.yml`)

Uses the official Microsoft Playwright Docker image — browsers are pre-installed, no install step needed.

Free tier: **6,000 credits/month** (~100 credits per run).

Triggers on push to `main` or `develop`. Connect your GitHub repo via the CircleCI dashboard to enable.

---

## Project Structure

```
tests/
  agents/           # AI agents (Claude-powered automation tools)
  api/              # API specs — use request fixture, no browser
  ui/               # UI specs — use page objects via fixtures
  accessibility/    # Axe-core a11y specs
  performance/      # CDP performance metric specs
  pages/            # Page Object classes
  actions/          # Reusable multi-step flows
  fixtures/
    fixtures.ts     # Single fixture file — all page objects registered here
  data/
    factories.ts    # Factory functions for test data
    types.ts        # Shared TypeScript interfaces
playwright.config.ts
buildspec.yml       # AWS CodeBuild config
azure-pipelines.yml # Azure DevOps config
.circleci/
  config.yml        # CircleCI config
```

---

## Environment Variables

| Variable | Default | Description |
|---|---|---|
| `BASE_URL` | `http://localhost:3000/parabank/` | Target app URL |
| `TEST_ENV` | — | Loads `.env.staging` |
| `ANTHROPIC_API_KEY` | — | Required for all AI agents |

Override locally via a `.env` file (gitignored).

---

## Parabank API Reference

Base path: `http://localhost:3000/parabank/services/bank`

### Customers

| Method | Endpoint | Description |
|---|---|---|
| GET | `/customers/{customerId}` | Get customer details |
| PUT | `/customers/{customerId}/update` | Update customer info |
| GET | `/customers/{customerId}/accounts` | List all accounts for a customer |

### Accounts

| Method | Endpoint | Description |
|---|---|---|
| GET | `/accounts/{accountId}` | Get account details |
| POST | `/createAccount?customerId=&newAccountType=&fromAccountId=` | Open a new account |
| GET | `/accounts/{accountId}/transactions` | Get all transactions |
| GET | `/accounts/{accountId}/transactions/month/{month}/type/{type}` | Filter by month and type |
| GET | `/accounts/{accountId}/transactions/fromDate/{fromDate}/toDate/{toDate}` | Filter by date range |
| GET | `/accounts/{accountId}/transactions/amount/{amount}` | Filter by amount |

### Transactions

| Method | Endpoint | Description |
|---|---|---|
| GET | `/transactions/{transactionId}` | Get a specific transaction |

### Transfers & Payments

| Method | Endpoint | Description |
|---|---|---|
| POST | `/transfer?fromAccountId=&toAccountId=&amount=` | Transfer funds between accounts |
| POST | `/billpay?accountId=&amount=` | Pay a bill (payee in request body) |
| POST | `/deposit?accountId=&amount=` | Deposit funds |

### Loans

| Method | Endpoint | Description |
|---|---|---|
| POST | `/requestLoan?customerId=&fromAccountId=&amount=&downPayment=` | Request a loan |

### Login / Session

| Method | Endpoint | Description |
|---|---|---|
| GET | `/login/{username}/{password}` | Authenticate and get customer object |

### Positions (Investments)

| Method | Endpoint | Description |
|---|---|---|
| GET | `/customers/{customerId}/positions` | Get investment positions |
| GET | `/positions/{positionId}` | Get a specific position |
| POST | `/buyPosition?customerId=&accountId=&name=&symbol=&shares=&pricePerShare=` | Buy a position |
| POST | `/sellPosition?customerId=&accountId=&positionId=&shares=&pricePerShare=` | Sell a position |
