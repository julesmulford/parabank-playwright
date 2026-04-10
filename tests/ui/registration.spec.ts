import { test, expect } from '../fixtures/fixtures';
import { RegistrationPage } from '../pages/RegistrationPage';


test.describe('Tests', () => {
    test('Register', async ({ registrationPage }) => {

        await registrationPage.goto();

        await registrationPage.registerDetails({
            firstName: 'John',
            lastName: 'Doe',
            street: '123 Main St',
            city: 'Anytown',
            state: 'CA',
            zipCode: '12345',
            phoneNumber: '555-1234',
            ssn: '123-45-6789',
            username: `johndoe_${Date.now()}`,
            password: 'Password1!',
            repeatedPassword: 'Password1!',
        });
    });
});
