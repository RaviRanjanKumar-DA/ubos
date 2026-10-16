# Setting up "Continue with Google" and "Continue with Microsoft"

Both are **free**. You need to do this once for the whole UBOS platform (not per customer).
Until it is done, these buttons stay hidden and everything else works (password, username, mobile, email code, 2FA).

> UBOS only lets people sign in this way if an admin has already added them as a user with the same email.
> Nobody can create an account by signing in with Google or Microsoft.

## Google (Gmail and Google Workspace accounts)

1. Open https://console.cloud.google.com/ and create a project, e.g. "UBOS".
2. **APIs & Services → OAuth consent screen**: choose *External*, fill in the app name (UBOS), support email and developer email. Scopes: `openid`, `email`, `profile`. While testing, add your own Gmail under *Test users*.
3. **APIs & Services → Credentials → Create credentials → OAuth client ID**:
   - Application type: *Web application*
   - Authorized redirect URI: `http://localhost:4000/oauth/google/callback`
4. Copy the **Client ID** and **Client secret** into `C:\Users\ravi\UBOS\.env`:
   ```
   GOOGLE_CLIENT_ID=...
   GOOGLE_CLIENT_SECRET=...
   ```
5. Restart the API. "Continue with Google" now appears on the login page.

## Microsoft (Outlook.com, Hotmail, Office 365 / Microsoft 365 accounts)

1. Open https://entra.microsoft.com/ (sign in with any Microsoft account), then go to **Applications → App registrations → New registration**.
   - Name: UBOS
   - Supported account types: *Accounts in any organizational directory and personal Microsoft accounts*
   - Redirect URI: platform *Web*, `http://localhost:4000/oauth/microsoft/callback`
2. In the new app, open **Certificates & secrets → New client secret**, then copy the secret **Value**.
3. Copy the **Application (client) ID** from *Overview*, and put both into `.env`:
   ```
   MICROSOFT_CLIENT_ID=...
   MICROSOFT_CLIENT_SECRET=...
   ```
4. Restart the API. "Continue with Microsoft" now appears.

## Email code

Works out of the box locally. Codes go to the local mailbox at http://localhost:8025 (Mailpit), and no real email is sent.
At go-live, set `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS` and `MAIL_FROM` to a real mail service.

## At go-live

Add the production redirect URIs, e.g. `https://api.yourdomain.com/oauth/google/callback`, publish the Google consent screen, and set `API_PUBLIC_URL`, `WEB_ORIGIN` and `COOKIE_SECURE=true`.
