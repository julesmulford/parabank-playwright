
Install playwright:
npm install
npx playwright install

Run tests:
npx playwright test

npx playwright test --headed
npx playwright test tests/api/parabank.spec.ts --project=api


Start parabank docker image:
docker run -p 3000:8080 parasoft/parabank

Initialise db:
curl -X POST http://localhost:3000/parabank/services/bank/initializeDB 


Azure DevOps Pipeline (self-hosted agent)

Prerequisites before running the pipeline:

1. Start Docker Desktop and wait for it to be ready (whale icon in system tray)

2. Start the local Azure agent:
   cd C:\Azure-agent
   run.cmd

   Keep this terminal open — the agent must be running to pick up pipeline jobs.

3. Trigger the pipeline by pushing to main or develop, or manually via Azure DevOps UI.

Note: the agent must be running on this machine for any Azure pipeline jobs to execute.
If the agent is not running, jobs will queue indefinitely.


Endpoint Reference
Customers

GET /customers/{customerId} — get customer details
PUT /customers/{customerId}/update — update customer info
GET /customers/{customerId}/accounts — list all accounts for a customer

Accounts

GET /accounts/{accountId} — get account details
POST /createAccount?customerId=&newAccountType=&fromAccountId= — open a new account (checking or savings)
GET /accounts/{accountId}/transactions — get all transactions for an account
GET /accounts/{accountId}/transactions/month/{month}/type/{type} — filter transactions by month and type
GET /accounts/{accountId}/transactions/fromDate/{fromDate}/toDate/{toDate} — filter by date range
GET /accounts/{accountId}/transactions/amount/{amount} — filter by amount

Transactions

GET /transactions/{transactionId} — get a specific transaction

Transfers & Payments

POST /transfer?fromAccountId=&toAccountId=&amount= — transfer funds between accounts
POST /billpay?accountId=&amount= — pay a bill (payee details in request body)
POST /deposit?accountId=&amount= — deposit funds

Loans

POST /requestLoan?customerId=&fromAccountId=&amount=&downPayment= Parasoft — request a loan

Login / Session

GET /login/{username}/{password} — authenticate and get customer object back

Positions (investments)

GET /customers/{customerId}/positions — get investment positions
GET /positions/{positionId} — get a specific position
POST /buyPosition?customerId=&accountId=&name=&symbol=&shares=&pricePerShare= — buy a position
POST /sellPosition?customerId=&accountId=&positionId=&shares=&pricePerShare= — sell a position