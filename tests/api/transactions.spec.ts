import { test, expect } from '../fixtures/apiFixtures';
import { AccountSchema } from '../data/schemas';

test.describe('Transactions', () => {

    test('deposit funds - happy path @smoke', async ({ apiSession }) => {
        const { ctx, accountId } = apiSession;
        const amount = 10;
        const res = await ctx.post(`deposit?accountId=${accountId}&amount=${amount}`);

        expect(res.ok()).toBeTruthy();
        const body = await res.text();
        expect(body).toMatch(new RegExp(`Successfully deposited \\$${amount}(\\.\\d+)? to account #\\d+`));
    });

    test('deposit increases account balance by exact amount', async ({ apiSession }) => {
        const { ctx, accountId } = apiSession;
        const amount = 25;

        const beforeRes = await ctx.get(`accounts/${accountId}`);
        const before = AccountSchema.parse(await beforeRes.json());

        await ctx.post(`deposit?accountId=${accountId}&amount=${amount}`);

        const afterRes = await ctx.get(`accounts/${accountId}`);
        const after = AccountSchema.parse(await afterRes.json());

        expect(after.balance).toBeCloseTo(before.balance + amount, 2);
    });

    test('deposit minimum precision (0.01) succeeds', async ({ apiSession }) => {
        const { ctx, accountId } = apiSession;
        const res = await ctx.post(`deposit?accountId=${accountId}&amount=0.01`);

        expect(res.ok()).toBeTruthy();
    });

    // NOTE: Parabank (demo app) does not validate zero or negative deposit amounts.
    // These tests document actual behaviour rather than enforcing business rules.
    test('deposit zero amount is accepted by Parabank', async ({ apiSession }) => {
        const { ctx, accountId } = apiSession;
        const res = await ctx.post(`deposit?accountId=${accountId}&amount=0`);

        expect(res.ok()).toBeTruthy();
        expect(await res.text()).toMatch(/Successfully deposited \$0/);
    });

    test('deposit negative amount is accepted by Parabank', async ({ apiSession }) => {
        const { ctx, accountId } = apiSession;
        const res = await ctx.post(`deposit?accountId=${accountId}&amount=-50`);

        expect(res.ok()).toBeTruthy();
        expect(await res.text()).toMatch(/Successfully deposited \$-50/);
    });

    test('deposit to non-existent account returns error', async ({ apiSession }) => {
        const { ctx } = apiSession;
        const res = await ctx.post(`deposit?accountId=999999999&amount=10`);

        expect(res.ok()).toBeFalsy();
    });

    test('transfer funds between accounts', async ({ apiSession }) => {
        const { ctx, customerId, accountId } = apiSession;
        const amount = 10;

        // Create a second account to transfer into
        const createRes = await ctx.post(`createAccount?customerId=${customerId}&newAccountType=1&fromAccountId=${accountId}`);
        expect(createRes.ok()).toBeTruthy();
        const newAccount = await createRes.json();
        const toAccountId = String(newAccount.id);

        const fromBefore = AccountSchema.parse(await (await ctx.get(`accounts/${accountId}`)).json());
        const toBefore   = AccountSchema.parse(await (await ctx.get(`accounts/${toAccountId}`)).json());

        const transferRes = await ctx.post(`transfer?fromAccountId=${accountId}&toAccountId=${toAccountId}&amount=${amount}`);
        expect(transferRes.ok()).toBeTruthy();

        const fromAfter = AccountSchema.parse(await (await ctx.get(`accounts/${accountId}`)).json());
        const toAfter   = AccountSchema.parse(await (await ctx.get(`accounts/${toAccountId}`)).json());

        expect(fromAfter.balance).toBeCloseTo(fromBefore.balance - amount, 2);
        expect(toAfter.balance).toBeCloseTo(toBefore.balance + amount, 2);
    });

    // NOTE: Parabank (demo app) does not enforce overdraft protection or same-account restrictions.
    // These tests document actual behaviour rather than enforcing business rules.
    test('transfer more than available balance is accepted by Parabank', async ({ apiSession }) => {
        const { ctx, customerId, accountId } = apiSession;

        const createRes = await ctx.post(`createAccount?customerId=${customerId}&newAccountType=1&fromAccountId=${accountId}`);
        const newAccount = await createRes.json();
        const toAccountId = String(newAccount.id);

        const res = await ctx.post(`transfer?fromAccountId=${accountId}&toAccountId=${toAccountId}&amount=9999999`);

        expect(res.ok()).toBeTruthy();
    });

    test('transfer to same account is accepted by Parabank', async ({ apiSession }) => {
        const { ctx, accountId } = apiSession;
        const res = await ctx.post(`transfer?fromAccountId=${accountId}&toAccountId=${accountId}&amount=10`);

        expect(res.ok()).toBeTruthy();
    });

});
