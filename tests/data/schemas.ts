import { z } from 'zod';

export const AddressSchema = z.object({
    street:  z.string(),
    city:    z.string(),
    state:   z.string(),
    zipCode: z.string(),
});

export const CustomerSchema = z.object({
    id:          z.number(),
    firstName:   z.string(),
    lastName:    z.string(),
    address:     AddressSchema,
    phoneNumber: z.string(),
    ssn:         z.string(),
});

export const AccountSchema = z.object({
    id:         z.number(),
    customerId: z.number(),
    type:       z.enum(['CHECKING', 'SAVINGS', 'LOAN', 'CREDIT_CARD']),
    balance:    z.number(),
});

export const AccountsSchema = z.array(AccountSchema);

export const LoanResponseSchema = z.object({
    loanProviderName: z.string(),
    approved:         z.boolean(),
    message:          z.string().optional(),  // absent on approved loans
    accountId:        z.number().optional(),
    responseDate:     z.number().optional(),  // epoch millis, not ISO string
});

export const BillPayResponseSchema = z.object({
    payeeName: z.string(),
    amount:    z.number(),
    accountId: z.number(),
});

export type Address         = z.infer<typeof AddressSchema>;
export type Customer        = z.infer<typeof CustomerSchema>;
export type Account         = z.infer<typeof AccountSchema>;
export type LoanResponse    = z.infer<typeof LoanResponseSchema>;
export type BillPayResponse = z.infer<typeof BillPayResponseSchema>;