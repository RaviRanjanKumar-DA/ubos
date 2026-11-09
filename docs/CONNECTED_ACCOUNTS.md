# Connected accounts: setup

Booking links work with no outside account. Facebook, Gmail and Outlook each need an app registered with that company. Those apps are free to create, but Facebook, and Gmail for customers outside your own organization, need approval first.

UBOS must be reachable on a public https address before Facebook can deliver leads. On a laptop (`localhost`) only the test stand-in works.

## Facebook and Instagram Lead Ads

1. At developers.facebook.com create a **Business** app. Note the App ID and App Secret.
2. Add **Facebook Login for Business**. Valid redirect address: `https://<api address>/connect/facebook/callback`.
3. Add **Webhooks**, object **Page**, field **leadgen**. Callback: `https://<api address>/connect/meta/webhook`. Verify token: any long random text.
4. Set on the server: `META_APP_ID`, `META_APP_SECRET`, `META_VERIFY_TOKEN`.
5. Request **Advanced Access** through App Review for `pages_show_list`, `pages_read_engagement`, `pages_manage_metadata`, `pages_manage_ads` and `leads_retrieval`. Facebook also requires business verification and a public privacy policy page. Until this is approved, only people with a role on the app can connect.
6. In UBOS: **Connected accounts → Connect Facebook**, then choose a business line for each page.

Only new leads arrive. Earlier leads are not fetched.

## Gmail

Reuses `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` from sign-in (`docs/LOGIN_SETUP.md`).

1. In Google Cloud enable the **Gmail API**.
2. Add the redirect address `https://<api address>/connect/google/callback`.
3. Add the scopes `gmail.readonly` and `gmail.send` to the consent screen.

`gmail.readonly` is a Google *restricted* scope:

- **Your own Google Workspace:** set the app to Internal. No review is needed.
- **Consumer Gmail in testing mode:** up to 100 named test users, and they must reconnect every 7 days.
- **Selling to other companies:** Google requires app verification and an annual independent security assessment, which is a paid cost. Decide this before offering Gmail sync to customers.

## Outlook and Microsoft 365

Reuses `MICROSOFT_CLIENT_ID` and `MICROSOFT_CLIENT_SECRET`.

1. In the Azure app registration add the redirect address `https://<api address>/connect/microsoft/callback`.
2. Add delegated permissions `Mail.Read`, `Mail.Send` and `offline_access`.

## What the mailbox sync does

- Every 5 minutes (`MAIL_SYNC_MINUTES`) UBOS reads message headers from the last check. The first check goes back 14 days and reads up to 300 messages.
- A message is kept only when the other party is a customer the mailbox owner can already see. Other message bodies are never downloaded.
- Open tracking counts when the image loads. Some mail apps load images automatically or block them, so treat opens as approximate. Clicks are more reliable.
