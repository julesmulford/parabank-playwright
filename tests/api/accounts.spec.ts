import { test, expect } from '../fixtures/apiFixtures';
import { CustomerSchema, AccountsSchema } from '../data/schemas';

test.describe('Customer & Accounts', () => {

    test('customer details response matches CustomerSchema @smoke', async ({ apiSession }) => {
        const { ctx, customerId } = apiSession;
        const res = await ctx.get(`customers/${customerId}`);

        expect(res.ok()).toBeTruthy();

        const result = CustomerSchema.safeParse(await res.json());
        expect(result.success, result.success ? '' : JSON.stringify(result.error.issues, null, 2)).toBe(true);
    });

    test('customer firstName and lastName match registration data', async ({ apiSession }) => {
        const { ctx, customerId, customer } = apiSession;
        const res = await ctx.get(`customers/${customerId}`);

        const body = await res.json();
        expect(body.firstName).toBe(customer.firstName);
        expect(body.lastName).toBe(customer.lastName);
    });

    test('accounts response matches AccountsSchema', async ({ apiSession }) => {
        const { ctx, customerId } = apiSession;
        const res = await ctx.get(`customers/${customerId}/accounts`);

        expect(res.ok()).toBeTruthy();

        const result = AccountsSchema.safeParse(await res.json());
        expect(result.success, result.success ? '' : JSON.stringify(result.error.issues, null, 2)).toBe(true);
    });

    test('new customer has exactly one CHECKING account', async ({ apiSession }) => {
        const { ctx, customerId } = apiSession;
        const res = await ctx.get(`customers/${customerId}/accounts`);

        const accounts = await res.json();
        expect(accounts).toHaveLength(1);
        expect(accounts[0].type).toBe('CHECKING');
    });

    test('non-existent customer ID returns error', async ({ apiSession }) => {
        const { ctx } = apiSession;
        const res = await ctx.get(`customers/999999999`);

        expect(res.ok()).toBeFalsy(); // Parabank returns 400 for unknown IDs
    });

    test('non-existent customer accounts returns error', async ({ apiSession }) => {
        const { ctx } = apiSession;
        const res = await ctx.get(`customers/999999999/accounts`);

        expect(res.ok()).toBeFalsy(); // Parabank returns 400 for unknown IDs
    });

});
