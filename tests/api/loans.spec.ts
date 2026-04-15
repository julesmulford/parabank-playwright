import { test, expect } from '../fixtures/apiFixtures';
import { LoanResponseSchema, AccountsSchema } from '../data/schemas';

test.describe('Loans', () => {

    test('request loan - happy path @smoke', async ({ apiSession }) => {
        const { ctx, customerId, accountId } = apiSession;
        const res = await ctx.post(`requestLoan?customerId=${customerId}&fromAccountId=${accountId}&amount=100&downPayment=10`);

        expect(res.ok()).toBeTruthy();
        const body = await res.json();
        expect(body.approved).toBe(true);
        expect(body.loanProviderName).toBe('Wealth Securities Dynamic Loans (WSDL)');
    });

    test('loan response matches LoanResponseSchema', async ({ apiSession }) => {
        const { ctx, customerId, accountId } = apiSession;
        const res = await ctx.post(`requestLoan?customerId=${customerId}&fromAccountId=${accountId}&amount=100&downPayment=10`);

        const result = LoanResponseSchema.safeParse(await res.json());
        expect(result.success, result.success ? '' : JSON.stringify(result.error.issues, null, 2)).toBe(true);
    });

    test('approved loan creates a new account', async ({ apiSession }) => {
        const { ctx, customerId, accountId } = apiSession;

        const beforeRes = await ctx.get(`customers/${customerId}/accounts`);
        const before    = AccountsSchema.parse(await beforeRes.json());

        await ctx.post(`requestLoan?customerId=${customerId}&fromAccountId=${accountId}&amount=100&downPayment=10`);

        const afterRes = await ctx.get(`customers/${customerId}/accounts`);
        const after    = AccountsSchema.parse(await afterRes.json());

        expect(after.length).toBe(before.length + 1);
    });

    test('loan denied when down payment exceeds available balance', async ({ apiSession }) => {
        const { ctx, customerId, accountId } = apiSession;
        const res = await ctx.post(`requestLoan?customerId=${customerId}&fromAccountId=${accountId}&amount=100&downPayment=9999999`);

        const body = await res.json();
        expect(body.approved).toBe(false);
    });

    test('loan request with non-existent fromAccountId returns error', async ({ apiSession }) => {
        const { ctx, customerId } = apiSession;
        const res = await ctx.post(`requestLoan?customerId=${customerId}&fromAccountId=999999999&amount=100&downPayment=10`);

        expect(res.ok()).toBeFalsy();
    });

});
