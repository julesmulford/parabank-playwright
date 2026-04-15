import { test, expect } from '../fixtures/apiFixtures';
import { CustomerSchema } from '../data/schemas';

test.describe('Authentication', () => {

    test('login with valid credentials returns customer data @smoke', async ({ apiSession }) => {
        const { ctx, customer, customerId } = apiSession;
        const res = await ctx.get(`login/${customer.username}/${customer.password}`);

        expect(res.ok()).toBeTruthy();

        const result = CustomerSchema.safeParse(await res.json());
        expect(result.success, result.success ? '' : JSON.stringify(result.error.issues, null, 2)).toBe(true);
        expect(String(result.data?.id)).toBe(customerId);
    });

    test('login with wrong password returns non-200', async ({ apiSession }) => {
        const { ctx, customer } = apiSession;
        const res = await ctx.get(`login/${customer.username}/wrongpassword`);

        expect(res.ok()).toBeFalsy();
    });

    test('login with non-existent username returns non-200', async ({ apiSession }) => {
        const { ctx } = apiSession;
        const res = await ctx.get(`login/nonexistent_user_xyz_abc/anypassword`);

        expect(res.ok()).toBeFalsy();
    });

});
