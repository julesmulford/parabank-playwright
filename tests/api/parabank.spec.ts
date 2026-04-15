import { test, expect, request as playwrightRequest, type APIRequestContext } from '@playwright/test'
import { CustomerSchema } from '../data/schemas';

const UI_REQUEST_CONFIG = {
  baseURL: 'http://localhost:3000/parabank/',
  extraHTTPHeaders: { Accept: 'text/html' },
} as const;

const API_REQUEST_CONFIG = {
  baseURL: 'http://localhost:3000/parabank/services/bank/',
  extraHTTPHeaders: { Accept: 'application/json' },
} as const;

const ts = Date.now();
const customer = {
    firstName: 'Jules',
    lastName: `Test${ts}`,
    street: '123 High Street',
    city: 'York',
    state: 'North Yorkshire',
    zipCode: 'YO1 9DF',
    phone: '07700901231',
    ssn: `${Math.floor(100000000 + Math.random() * 900000000)}`,
    username: `jules_${ts}`,
    password: 'Password123!',
};

let customerId: string;
let accountId: string;
let ctx: APIRequestContext;

// Register via HTML form using pure HTTP post, no endpoint available
async function registerCustomer() {
    const ctx = await playwrightRequest.newContext(UI_REQUEST_CONFIG);

    const getRes = await ctx.get('register.htm');
    expect(getRes.status()).toBe(200);

    const res = await ctx.post(`register.htm`, {
        headers: { 'Content-Type': 'application/x-www-form-urlencoded'},
        form: {
                'customer.firstName':           customer.firstName,
                'customer.lastName':            customer.lastName,
                'customer.address.street':      customer.street,
                'customer.address.city':        customer.city,
                'customer.address.state':       customer.state,
                'customer.address.zipCode':     customer.zipCode,
                'customer.phoneNumber':         customer.phone,
                'customer.ssn':                 customer.ssn,
                'customer.username':            customer.username,
                'customer.password':            customer.password,
                'repeatedPassword':             customer.password,
        },
    });

    const body = await res.text();

    console.log('Status:', res.status());
    console.log('URL:', res.url());
    console.log('Body:', body);

    expect(res.status()).toBe(200);
    //const body = await res.text();
    expect(body).toContain('Welcome');

    await ctx.dispose();
}

async function getCustomerId(ctx: Awaited<ReturnType<typeof playwrightRequest.newContext>>) {
    const res = await ctx.get(
        `login/${customer.username}/${customer.password}`,
        { headers: {Accept: 'application/json' } }
    );
    expect(res.ok()).toBeTruthy();
    const body = await res.json();
    return String(body.id);
}

test.describe('Parabank - API driven E2E', () => {
    test.beforeAll(async () => {

        await registerCustomer();

        ctx = await playwrightRequest.newContext(API_REQUEST_CONFIG);
        customerId = await getCustomerId(ctx);
        console.log(`Customer registered - id: ${customerId}, username: ${customer.username}`);

        const accountsRes = await ctx.get(
            `customers/${customerId}/accounts`,
            { headers: { Accept: 'application/json' } }
        );

        expect(accountsRes.ok()).toBeTruthy();
        expect(accountsRes.status()).toBe(200);
        const accounts = await accountsRes.json();
        expect(accounts.length).toBeGreaterThan(0);
        accountId = String(accounts[0].id);
        console.log(`Seed account: ${accountId}`);

    });

    test.afterAll(async () => {
        await ctx.dispose();
    });

    test('can fetch customer details', async () => {
        const res = await ctx.get(
            `customers/${customerId}`,
            { headers: { Accept: 'application/json' } }
        );

        console.log('Status:', res.status());
        console.log('URL:', res.url());
        console.log('Body:', await res.text());

        expect(res.ok()).toBeTruthy();
        const body = await res.json();
        expect(body.firstName).toBe(customer.firstName);
        expect(body.lastName).toBe(customer.lastName);
    });

    test('Verify customer account type and balance', async () => {
        const res = await ctx.get(`customers/${customerId}/accounts`, 
            { headers: { Accept: 'application/json' } });

        expect(res.ok()).toBeTruthy();
        
        const body = await res.json();
        console.log('Body', body);
        expect(body[0].type).toEqual('CHECKING');
        expect(body[0].balance).toEqual(515.5);    
    });

    test('Request a loan', async () => {
        const res = await ctx.post(`requestLoan?customerId=${customerId}&fromAccountId=${accountId}&amount=5&downPayment=5`,
            { headers: {Accept: 'application/json'} }
        )

        const body = await res.json();
        console.log(body);

        expect(String(body.accountId).length).toBe(5);
        expect(body.loanProviderName).toEqual("Wealth Securities Dynamic Loans (WSDL)");
        expect(body.approved).toEqual(true);
    });

    test('Transfer funds between accounts', async () => {

        const res = await ctx.post('transfer?fromAccountId=&toAccountId=&amount=', 
            { headers: { Accept: 'application/json' } }
        );

        //`/transfer?fromAccountId=&toAccountId=&amount=
    });

    test('Pay a bill', async() => {
        const res = await ctx.post(`billpay?accountId=&amount=`, 
            { headers: { Accept: 'application/json' } }
    )
        //`/billpay?accountId=&amount=`
    });

    test('Deposit funds', async() => {
        const amount = 5;

        const res = await ctx.post(`deposit?accountId=${accountId}&amount=${amount}`,
            { headers: { Accept: 'application/json' } }
        );

        console.log('Status:', res.status());

        const rawText = await res.text();
        let body: unknown;
        try { body = JSON.parse(rawText); } catch { body = rawText; }
        
        console.log('Body:', body);

        expect(res.ok()).toBeTruthy();
        expect(body).toMatch(new RegExp(`Successfully deposited \\$${amount}(\\.\\d+)? to account #\\d+`));
    });

    test('customer details response matches CustomerSchema', async() => {
        const res = await ctx.get(`customers/${customerId}`, 
            { headers: { Accept: 'application/json' } }
        );

        expect(res.ok()).toBeTruthy();
        const body = await res.json();
        const result = CustomerSchema.safeParse(body);

        expect(result.success, result.success? '' : JSON.stringify(result.error.issues, null, 2)).toBe(true);
    });
});
