import { test, expect, request as playwrightRequest, type APIRequestContext } from '@playwright/test'

//const API_BASE = `services/bank`;

const REQUEST_CONFIG = {
  baseURL: 'http://localhost:3000/parabank/',
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

// Register via HTML form using pure HTTP post, no endpoint available
async function registerCustomer() {
    const ctx = await playwrightRequest.newContext(REQUEST_CONFIG);

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
        `services/bank/login/${customer.username}/${customer.password}`,
        { headers: {Accept: 'application/json' } }
    );
    expect(res.ok()).toBeTruthy();
    const body = await res.json();
    return String(body.id);
}

test.describe('Parabank - API driven E2E', () => {
    test.beforeAll(async () => {

        await registerCustomer();

        const ctx = await playwrightRequest.newContext(REQUEST_CONFIG);
        customerId = await getCustomerId(ctx);
        console.log(`Customer registered - id: ${customerId}, username: ${customer.username}`);

        const accountsRes = await ctx.get(
            `services/bank/customers/${customerId}/accounts`,
            { headers: { Accept: 'application/json' } }
        );

        expect(accountsRes.ok()).toBeTruthy();
        expect(accountsRes.status()).toBe(200);
        const accounts = await accountsRes.json();
        expect(accounts.length).toBeGreaterThan(0);
        accountId = String(accounts[0].id);
        console.log(`Seed account: ${accountId}`);

        await ctx.dispose();
    });

    test('can fetch customer details', async ( {request} ) => {
        const res = await request.get(
            `services/bank/customers/${customerId}`,
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
});