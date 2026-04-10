import { Page, Locator } from '@playwright/test';

export class RegistrationPage {

    readonly page: Page;
    readonly firstName: Locator;
    readonly lastName: Locator;
    readonly street: Locator;
    readonly city: Locator;
    readonly state: Locator;
    readonly zipCode: Locator;
    readonly phoneNumber: Locator;
    readonly ssn: Locator;
    readonly username: Locator;
    readonly password: Locator;
    readonly repeatedPassword: Locator;
    readonly registerButton: Locator;

    constructor(page: Page) {
        this.page = page;
        this.firstName = page.locator('[id="customer.firstName"]')
        this.lastName = page.locator('[id="customer.lastName"]')
        this.street = page.locator('[id="customer.address.street"]')
        this.city = page.locator('[id="customer.address.city"]')
        this.state = page.locator('[id="customer.address.state"]')
        this.zipCode = page.locator('[id="customer.address.zipCode"]')
        this.phoneNumber = page.locator('[id="customer.phoneNumber"]')
        this.ssn = page.locator('[id="customer.ssn"]')
        this.username = page.locator('[id="customer.username"]')
        this.password = page.locator('[id="customer.password"]')
        this.repeatedPassword = page.locator('[id="repeatedPassword"]')
        this.registerButton = page.getByRole('button', { name: 'Register' });
    }

    async goto() {
        await this.page.goto('register.htm');
    }

    async registerDetails(data: RegistrationData) {
        await this.firstName.fill(data.firstName);
        await this.lastName.fill(data.lastName);
        await this.street.fill(data.street);
        await this.city.fill(data.city);
        await this.state.fill(data.state);
        await this.zipCode.fill(data.zipCode);
        await this.phoneNumber.fill(data.phoneNumber);
        await this.ssn.fill(data.ssn);
        await this.username.fill(data.username);
        await this.password.fill(data.password);
        await this.repeatedPassword.fill(data.repeatedPassword);
        await this.registerButton.click();
    }
}

export interface RegistrationData {
    firstName: string;
    lastName: string;
    street: string;
    city: string;
    state: string;
    zipCode: string;
    phoneNumber: string;
    ssn: string;
    username: string;
    password: string;
    repeatedPassword: string;
}