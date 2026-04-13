# Parabank Playwright Framework

A Playwright API and UI test automation framework for the Parabank demo banking application. Runs on **Azure DevOps**, **AWS CodeBuild**, and **CircleCI** with AI integration via Claude.

---

## Tech Stack

- **Playwright** — UI, API, Accessibility, and Performance testing
- **TypeScript** — ESM module format
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

| Variable   | Default                              | Description          |
|------------|--------------------------------------|----------------------|
| `BASE_URL` | `http://localhost:3000/parabank/`    | Target app URL       |
| `TEST_ENV` | —                                    | Loads `.env.staging` |

Override locally via a `.env` file (gitignored).

---

## Parabank API Reference

Base path: `http://localhost:3000/parabank/services/bank`

### Customers

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/customers/{customerId}` | Get customer details |
| PUT | `/customers/{customerId}/update` | Update customer info |
| GET | `/customers/{customerId}/accounts` | List all accounts for a customer |

### Accounts

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/accounts/{accountId}` | Get account details |
| POST | `/createAccount?customerId=&newAccountType=&fromAccountId=` | Open a new account |
| GET | `/accounts/{accountId}/transactions` | Get all transactions |
| GET | `/accounts/{accountId}/transactions/month/{month}/type/{type}` | Filter by month and type |
| GET | `/accounts/{accountId}/transactions/fromDate/{fromDate}/toDate/{toDate}` | Filter by date range |
| GET | `/accounts/{accountId}/transactions/amount/{amount}` | Filter by amount |

### Transactions

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/transactions/{transactionId}` | Get a specific transaction |

### Transfers & Payments

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/transfer?fromAccountId=&toAccountId=&amount=` | Transfer funds between accounts |
| POST | `/billpay?accountId=&amount=` | Pay a bill (payee in request body) |
| POST | `/deposit?accountId=&amount=` | Deposit funds |

### Loans

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/requestLoan?customerId=&fromAccountId=&amount=&downPayment=` | Request a loan |

### Login / Session

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/login/{username}/{password}` | Authenticate and get customer object |

### Positions (Investments)

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/customers/{customerId}/positions` | Get investment positions |
| GET | `/positions/{positionId}` | Get a specific position |
| POST | `/buyPosition?customerId=&accountId=&name=&symbol=&shares=&pricePerShare=` | Buy a position |
| POST | `/sellPosition?customerId=&accountId=&positionId=&shares=&pricePerShare=` | Sell a position |
