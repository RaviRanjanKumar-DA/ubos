# Phase 3 — Money and people

Built in slices like Phases 1 and 2; each ends with end-to-end tests, a browser check, docs and a local commit. Everything is
tested locally first, and payment and other outside services are tested against local stand-ins until a real account is connected.

Tax handling follows the common Indian GST invoice format. Have your CA confirm the invoice layout, rates and registers before relying on them for filing.

| Slice | Scope | Status |
|---|---|---|
| 3.1 Invoices and GST | Billing profile per business line (GSTIN, state, address, invoice series), GST invoices from a quote or from scratch, CGST + SGST or IGST by place of supply, consecutive numbers per financial year, issue and cancel with a reason, printable invoice, payments against invoices, sales register export. | Done (51 e2e checks, plus unit tests) |
| 3.2 Payment links | Razorpay payment links on invoices, signed webhook records the payment once, numbered receipts. A real Razorpay test account is not yet checked. | Done (40 e2e checks against a local stand-in) |
| 3.3 Collections and ledgers | Customer ledger with running balance, money due by age, instalment plans that move the due date, reminders to the owner and optional customer email, download. Payments not tied to an invoice show on the ledger as received. | Done (36 e2e checks, plus unit tests) |
| 3.4 Expenses and P&L | Expenses by category and business line, income against expenses, real profit and loss. | Planned |
| 3.5 Packages and access | Product and service gallery shareable on WhatsApp, course and software access with validity, renewal leads. | Planned |
| 3.6 HR core | Employee records, onboarding, documents, assets, HR reminders. | Planned |
| 3.7 Attendance and leave | Attendance, leave types and balances, approvals. | Planned |
| 3.8 Platform billing | Subscriptions, usage metering, self-serve trial for customers of UBOS. | Planned |
| 3.9 Visual flow builder | Drawing automation as a flowchart on top of the existing rules. | Planned |
