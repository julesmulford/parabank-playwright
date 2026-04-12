import type { CustomerData } from './types.js';

export function buildCustomer(overrides: Partial<CustomerData> = {}): CustomerData {
    const ts = Date.now();
    return {
        firstName: 'Test',
        lastName: `User${ts}`,
        street: '123 High Street',
        city: 'York',
        state: 'North Yorkshire',
        zipCode: 'YO1 9DF',
        phone: '07700901234',
        ssn: String(Math.floor(100000000 + Math.random() * 900000000)),
        username: `testuser_${ts}`,
        password: 'Password123!',
        ...overrides,
    };
}
