import { Page, Locator } from '@playwright/test';

class LoginPage {

    readonly page: Page;
    readonly register: Locator;

    constructor(page: Page) {
        this.page = page;
        this.register = page.getByRole('link', { name: 'Register' })
    }


}
    