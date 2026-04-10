
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