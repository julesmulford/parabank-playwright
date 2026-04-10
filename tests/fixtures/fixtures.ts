import { test as base } from '@playwright/test';
import { RegistrationPage } from '../pages/RegistrationPage';

type Fixtures = {
    registrationPage: RegistrationPage;
}

export const test = base.extend<Fixtures> ({
    registrationPage: async ({ page }, use ) => {
        await use (new RegistrationPage(page));
        },
});

export { expect } from '@playwright/test';