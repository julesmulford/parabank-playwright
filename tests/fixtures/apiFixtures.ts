import { test as base, request as playwrightRequest, type APIRequestContext } from '@playwright/test';
import { randomUUID } from 'crypto';
import { type CustomerData } from '../data/types';

const UI_BASE = 'http://localhost:3000/parabank/';
const API_BASE = 'http://localhost:3000/parabank/services/bank/';

export type ApiSession = {
    ctx:        APIRequestContext;
    customerId: string;
    accountId:  string;
    customer:   CustomerData;
};

function buildCustomer(): CustomerData {
    const ts = Date.now();
    return {
        firstName: 'Jules',
        lastName:  `Test${ts}`,
        street:    '123 High Street',
        city:      'York',
        state:     'North Yorkshire',
        zipCode:   'YO1 9DF',
        phone:     '07700901231',
        ssn:       `${Math.floor(100000000 + Math.random() * 900000000)}`,
        username:  `t_${randomUUID().replace(/-/g, '').slice(0, 12)}`,
        password:  'Password123!',
    };
}

async function registerCustomer(customer: CustomerData): Promise<void> {
    const uiCtx = await playwrightRequest.newContext({
        baseURL:          UI_BASE,
        extraHTTPHeaders: { Accept: 'text/html' },
    });
    await uiCtx.get('register.htm');
    const res = await uiCtx.post('register.htm', {
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        form: {
            'customer.firstName':        customer.firstName,
            'customer.lastName':         customer.lastName,
            'customer.address.street':   customer.street,
            'customer.address.city':     customer.city,
            'customer.address.state':    customer.state,
            'customer.address.zipCode':  customer.zipCode,
            'customer.phoneNumber':      customer.phone,
            'customer.ssn':              customer.ssn,
            'customer.username':         customer.username,
            'customer.password':         customer.password,
            'repeatedPassword':          customer.password,
        },
    });
    const body = await res.text();
    await uiCtx.dispose();
    if (!body.includes('Customer Created')) throw new Error(`Registration failed (status ${res.status()}):\n${body.slice(0, 1000)}`);
}

export const test = base.extend<{}, { apiSession: ApiSession }>({
    apiSession: [async ({}, use) => {
        const customer = buildCustomer();
        await registerCustomer(customer);

        const ctx = await playwrightRequest.newContext({
            baseURL:          API_BASE,
            extraHTTPHeaders: { Accept: 'application/json' },
        });

        const loginRes  = await ctx.get(`login/${customer.username}/${customer.password}`);
        const loginBody = await loginRes.json();
        const customerId = String(loginBody.id);

        const accountsRes = await ctx.get(`customers/${customerId}/accounts`);
        const accounts    = await accountsRes.json();
        const accountId   = String(accounts[0].id);

        await use({ ctx, customerId, accountId, customer });
        await ctx.dispose();
    }, { scope: 'worker' }],
});

export { expect } from '@playwright/test';
