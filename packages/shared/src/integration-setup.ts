// What each integration needs to be connected: steps to follow and the settings / credentials to enter.
// Secrets are stored encrypted per organization and never shown again in full.

export interface SetupField {
  key: string;
  label: string;
  type: 'text' | 'secret' | 'url' | 'select' | 'number';
  required?: boolean;
  help?: string;
  options?: string[];
  placeholder?: string;
}
export interface SetupDef {
  steps: string[];
  fields: SetupField[];
  /** UBOS gives the organization an inbound webhook URL to paste into the other service. */
  webhook?: boolean;
  /** Where the person gets the keys (shown as a hint, not a link we vouch for). */
  where?: string;
}

const key = (label = 'API key'): SetupField => ({ key: 'apiKey', label, type: 'secret', required: true });
const secret = (label = 'API secret'): SetupField => ({ key: 'apiSecret', label, type: 'secret', required: true });
const workspaceField: SetupField = { key: 'businessLine', label: 'Put new leads in business line', type: 'select', help: 'Leads from this source land here (assignment rules apply).' };

/** Defaults per category; specific integrations below override them. */
const BY_CATEGORY: Record<string, SetupDef> = {
  'Lead sources': {
    steps: ['Get an API key / CRM key from the portal’s seller or business account.', 'Paste it below and choose the business line for new leads.', 'Activate — new enquiries are pulled in automatically once the live connection ships.'],
    fields: [key(), workspaceField], where: 'Portal account → Settings → API / CRM integration',
  },
  'Forms & surveys': {
    steps: ['Copy the webhook URL below.', 'In your form tool, add a webhook / “send responses to URL” with it.', 'Match the form questions to lead fields when the first response arrives.'],
    fields: [workspaceField], webhook: true,
  },
  Calling: {
    steps: ['In your telephony account, create API credentials.', 'Paste them below with your virtual number (caller ID).', 'Copy the webhook URL into the provider’s “call events” setting so calls and recordings land on leads.'],
    fields: [key(), secret(), { key: 'callerId', label: 'Virtual number / caller ID', type: 'text', required: true, placeholder: '+91 80 1234 5678' }, workspaceField], webhook: true,
  },
  Messaging: {
    steps: ['Get API credentials from your messaging provider.', 'Paste them below.', 'Copy the webhook URL into the provider so incoming messages create leads.'],
    fields: [key(), { key: 'senderId', label: 'Sender number / ID', type: 'text', required: true }, workspaceField], webhook: true,
  },
  'Website & e-commerce': {
    steps: ['Install the UBOS plugin / app or use the webhook URL below.', 'Paste the store API key if asked.', 'Choose where new customers and orders go.'],
    fields: [{ key: 'siteUrl', label: 'Website / store URL', type: 'url', required: true, placeholder: 'https://example.com' }, { ...key('API key / access token'), required: false }, workspaceField], webhook: true,
  },
  Payments: {
    steps: ['In the payment dashboard, create API keys (use TEST mode first).', 'Paste the key ID and secret below.', 'Copy the webhook URL into the gateway so payments mark invoices paid.'],
    fields: [{ key: 'keyId', label: 'Key ID', type: 'text', required: true }, secret('Key secret'), { key: 'mode', label: 'Mode', type: 'select', options: ['test', 'live'], required: true }], webhook: true,
  },
  Accounting: {
    steps: ['Create an API / connector key in your accounting software.', 'Paste it below with your company name as it appears there.'],
    fields: [key('API key / token'), { key: 'company', label: 'Company name in the software', type: 'text', required: true }],
  },
  'Marketing & analytics': {
    steps: ['Create an API key or access token in the tool.', 'Paste it below with the account / pixel ID.'],
    fields: [key('API key / access token'), { key: 'accountId', label: 'Account / pixel / measurement ID', type: 'text', required: true }],
  },
  'AI & automation': {
    steps: ['Create an API key in your account.', 'Paste it below — UBOS calls the service with your key, so usage is billed to you.'],
    fields: [key()],
  },
  Productivity: {
    steps: ['Sign in with the account you want to connect (one-click sign-in arrives with the live connection).', 'Choose what UBOS may use.'],
    fields: [{ key: 'account', label: 'Account email', type: 'text', required: true }],
  },
  'Support desks': {
    steps: ['Create an API key in the help-desk admin settings.', 'Paste it with your help-desk domain.'],
    fields: [{ key: 'domain', label: 'Help-desk domain', type: 'url', required: true, placeholder: 'https://yourcompany.freshdesk.com' }, key()],
  },
  'Other CRMs': {
    steps: ['Create an API token in the other CRM.', 'Paste it below with your account domain.', 'Use it to import data or keep both in sync while you move.'],
    fields: [{ key: 'domain', label: 'Account domain / URL', type: 'url', placeholder: 'https://yourcompany.example.com' }, key('API token'), workspaceField],
  },
};

const SPECIFIC: Record<string, SetupDef> = {
  website_api: {
    steps: ['Copy the webhook URL below (or use the public API with an API key from Settings → API keys).', 'Send form submissions to it as JSON: name, mobile, email, source and any custom field.', 'Each submission becomes a lead in the chosen business line.'],
    fields: [workspaceField, { key: 'defaultSource', label: 'Default source', type: 'text', placeholder: 'website' }], webhook: true,
  },
  google_sheets: {
    steps: ['Share the sheet with the UBOS service account (shown when the live connection ships) or publish it.', 'Paste the sheet URL and the tab name.', 'New rows become leads; columns are matched like a bulk upload.'],
    fields: [{ key: 'sheetUrl', label: 'Google Sheet URL', type: 'url', required: true, placeholder: 'https://docs.google.com/spreadsheets/d/…' }, { key: 'tab', label: 'Tab name', type: 'text', placeholder: 'Sheet1' }, workspaceField],
  },
  facebook_leads: {
    steps: ['Connect your Facebook Page (Meta business login arrives with the live connection).', 'Pick the Page and its lead forms.', 'New form submissions become leads within a minute.'],
    fields: [{ key: 'pageId', label: 'Facebook Page ID', type: 'text', required: true }, { key: 'accessToken', label: 'Page access token', type: 'secret', required: true }, workspaceField],
    where: 'Meta Business Suite → Settings → Business assets → Pages',
  },
  indiamart: {
    steps: ['In IndiaMART Seller Panel open Settings → CRM integration and generate the CRM key.', 'Paste it below.', 'Buyer enquiries are pulled every few minutes.'],
    fields: [key('IndiaMART CRM key'), workspaceField],
  },
  justdial: {
    steps: ['Ask your JustDial account manager for the lead API / webhook option.', 'Give them the webhook URL below.'],
    fields: [workspaceField], webhook: true,
  },
  callerdesk: {
    steps: ['In CallerDesk, open Settings → API and copy the auth code.', 'Paste it below with your CallerDesk number.', 'Copy the webhook URL into CallerDesk → Webhook so calls, missed calls and recordings land on leads.'],
    fields: [key('CallerDesk auth code'), { key: 'callerId', label: 'CallerDesk number', type: 'text', required: true }, workspaceField], webhook: true,
  },
  whatsapp: {
    steps: ['Create a Meta app with WhatsApp in Meta for Developers and add your business number.', 'Paste the phone number ID, business account ID and a permanent access token.', 'Copy the webhook URL and verify token into the app’s WhatsApp → Configuration.'],
    fields: [{ key: 'phoneNumberId', label: 'Phone number ID', type: 'text', required: true }, { key: 'wabaId', label: 'WhatsApp business account ID', type: 'text', required: true }, { key: 'accessToken', label: 'Permanent access token', type: 'secret', required: true }, workspaceField],
    webhook: true, where: 'developers.facebook.com → your app → WhatsApp → API setup',
  },
  whatsapp_widget: {
    steps: ['Enter the WhatsApp number to chat with and a greeting.', 'Copy the website snippet (shown when the live connection ships) into your site.'],
    fields: [{ key: 'number', label: 'WhatsApp number', type: 'text', required: true }, { key: 'greeting', label: 'Greeting message', type: 'text', placeholder: 'Hi! How can we help?' }, workspaceField],
  },
  email_smtp: {
    steps: ['Use your company mailbox’s SMTP settings (Gmail / Outlook need an app password).', 'Enter them below; emails sent from UBOS will come from this address.'],
    fields: [{ key: 'host', label: 'SMTP server', type: 'text', required: true, placeholder: 'smtp.gmail.com' }, { key: 'port', label: 'Port', type: 'number', required: true, placeholder: '587' }, { key: 'user', label: 'Username / email', type: 'text', required: true }, { key: 'password', label: 'Password / app password', type: 'secret', required: true }],
  },
  sms_dlt: {
    steps: ['Register your sender ID and templates on the DLT portal.', 'Enter your SMS provider’s API key, sender ID and DLT entity ID.'],
    fields: [{ key: 'provider', label: 'Provider', type: 'select', options: ['MSG91', 'Kaleyra', 'Gupshup', 'Textlocal', 'Other'], required: true }, key(), { key: 'senderId', label: 'Sender ID (6 letters)', type: 'text', required: true }, { key: 'entityId', label: 'DLT entity ID', type: 'text', required: true }],
  },
  razorpay: {
    steps: ['In Razorpay Dashboard → Settings → API keys, generate keys (start in TEST mode).', 'Paste the key ID and secret below.', 'Add the webhook URL in Settings → Webhooks for payment.captured and payment_link.paid.'],
    fields: [{ key: 'keyId', label: 'Key ID', type: 'text', required: true, placeholder: 'rzp_test_…' }, secret('Key secret'), { key: 'mode', label: 'Mode', type: 'select', options: ['test', 'live'], required: true }], webhook: true,
  },
  google_meet: { steps: ['Sign in with Google (arrives with the live connection) to create Meet links and sync calendars.'], fields: [{ key: 'account', label: 'Google Workspace email', type: 'text', required: true }] },
  zapier: { steps: ['Copy the webhook URL into a Zapier “Webhooks by Zapier” step to send leads in.', 'For leads going out, use the outgoing webhooks setting (slice 1.7).'], fields: [workspaceField], webhook: true },
  make: { steps: ['Use the webhook URL in a Make “HTTP / Webhooks” module to send leads in.'], fields: [workspaceField], webhook: true },
  n8n: { steps: ['Use the webhook URL in an n8n HTTP Request node to send leads in.'], fields: [workspaceField], webhook: true },
  pabbly: { steps: ['Use the webhook URL in a Pabbly Connect “Webhook” action to send leads in.'], fields: [workspaceField], webhook: true },
  openai: { steps: ['Create a secret key at platform.openai.com → API keys.', 'Paste it below.'], fields: [key('OpenAI API key'), { key: 'model', label: 'Model', type: 'text', placeholder: 'gpt-4o-mini' }] },
  anthropic: { steps: ['Create a key at console.anthropic.com → API keys.', 'Paste it below.'], fields: [key('Anthropic API key'), { key: 'model', label: 'Model', type: 'text', placeholder: 'claude-sonnet-5-5' }] },
  gemini: { steps: ['Create a key in Google AI Studio.', 'Paste it below.'], fields: [key('Gemini API key'), { key: 'model', label: 'Model', type: 'text', placeholder: 'gemini-2.5-flash' }] },
};

/** Service-specific setups with field-level help (the ⓘ next to each field). */
const MORE: Record<string, SetupDef> = {
  // Meta
  instagram_dm: {
    steps: ['Link the Instagram professional account to your Facebook Page.', 'In Meta for Developers, add the Instagram Messaging product to your app.', 'Paste the Page ID and Page access token; copy the webhook URL into the app’s Webhooks → Instagram.'],
    fields: [{ key: 'pageId', label: 'Facebook Page ID', type: 'text', required: true, help: 'Meta Business Suite → Settings → Business assets → Pages → Page ID.' },
      { key: 'accessToken', label: 'Page access token', type: 'secret', required: true, help: 'Meta for Developers → your app → Messenger / Instagram → Access tokens → Generate (needs instagram_manage_messages).' }, workspaceField],
    webhook: true, where: 'developers.facebook.com → your app',
  },
  messenger: {
    steps: ['In Meta for Developers, add Messenger to your app and connect your Page.', 'Paste the Page ID and Page access token.', 'Copy the webhook URL and verify token into Messenger → Webhooks (messages, messaging_postbacks).'],
    fields: [{ key: 'pageId', label: 'Facebook Page ID', type: 'text', required: true, help: 'Meta Business Suite → Settings → Pages.' },
      { key: 'accessToken', label: 'Page access token', type: 'secret', required: true, help: 'Meta for Developers → Messenger → Settings → Access tokens.' }, workspaceField],
    webhook: true,
  },
  meta_capi: {
    steps: ['In Events Manager, open your dataset (pixel) → Settings.', 'Generate a Conversions API access token.', 'Paste the dataset ID and token; won leads are sent back as “Purchase” / “Lead” events.'],
    fields: [{ key: 'accountId', label: 'Dataset / pixel ID', type: 'text', required: true, help: 'Events Manager → Data sources → your dataset → Dataset ID.' },
      { key: 'accessToken', label: 'Conversions API access token', type: 'secret', required: true, help: 'Events Manager → dataset → Settings → Conversions API → Generate access token.' },
      { key: 'event', label: 'Send won leads as', type: 'select', options: ['Purchase', 'Lead', 'CompleteRegistration'], required: true }],
  },
  // Google
  google_ads: {
    steps: ['In the Google Ads lead form asset, choose “Webhook” under Lead delivery.', 'Paste the webhook URL and the key below into the form.', 'Send a test lead from Google Ads to check the mapping.'],
    fields: [{ key: 'googleKey', label: 'Webhook key (you choose it)', type: 'secret', required: true, help: 'Any secret text; type the same value in the Google Ads lead form “Key” box so UBOS knows the data is genuine.' }, workspaceField],
    webhook: true, where: 'Google Ads → Assets → Lead forms → Lead delivery → Webhook integration',
  },
  google_forms: {
    steps: ['Open the form → ⋮ → Script editor and paste the UBOS snippet (shown when the live connection ships), or link the form to a Google Sheet and use the Google Sheets integration.', 'Use the webhook URL below in the snippet.'],
    fields: [{ key: 'formUrl', label: 'Form URL', type: 'url', help: 'The link you share for the form.' }, workspaceField], webhook: true,
  },
  google_analytics: {
    steps: ['In Google Analytics, open Admin → Data streams → your web stream.', 'Copy the Measurement ID and create a Measurement Protocol API secret.', 'Paste both; UBOS sends “lead won” conversions.'],
    fields: [{ key: 'accountId', label: 'Measurement ID', type: 'text', required: true, placeholder: 'G-XXXXXXX', help: 'Admin → Data streams → web stream → Measurement ID.' },
      { key: 'apiSecret', label: 'Measurement Protocol API secret', type: 'secret', required: true, help: 'Same stream → Measurement Protocol API secrets → Create.' }],
  },
  google_drive: {
    steps: ['Sign in with Google (arrives with the live connection).', 'Choose the folder where lead and customer documents are stored.'],
    fields: [{ key: 'account', label: 'Google account', type: 'text', required: true }, { key: 'folderUrl', label: 'Folder URL', type: 'url', help: 'Open the folder in Drive and copy the address bar link.' }],
  },
  google_business: {
    steps: ['Sign in with the Google account that manages your Business Profile (arrives with the live connection).', 'Choose the location; calls, messages and reviews become lead activity.'],
    fields: [{ key: 'account', label: 'Google account', type: 'text', required: true }, { key: 'location', label: 'Business name / location', type: 'text', help: 'As shown on Google Maps.' }, workspaceField],
  },
  // CRMs
  hubspot: {
    steps: ['In HubSpot → Settings → Integrations → Private apps, create an app.', 'Give it read access to Contacts, Companies and Deals (write if you want to sync back).', 'Paste the access token; choose the business line for imported contacts and map their properties in step 2.'],
    fields: [{ key: 'apiKey', label: 'Private app access token', type: 'secret', required: true, help: 'HubSpot → Settings → Integrations → Private apps → your app → Access token (starts with pat-).' },
      { key: 'portalId', label: 'Hub ID', type: 'text', help: 'Shown at the top right of your HubSpot account menu.' }, workspaceField],
  },
  salesforce: {
    steps: ['In Salesforce Setup → App Manager, create a Connected App with OAuth (API, refresh_token).', 'Paste the instance URL, consumer key and secret; sign-in completes when the live connection ships.', 'Map Lead / Contact fields to UBOS in step 2.'],
    fields: [{ key: 'domain', label: 'Instance URL', type: 'url', required: true, placeholder: 'https://yourcompany.my.salesforce.com', help: 'The address you see after logging in to Salesforce.' },
      { key: 'apiKey', label: 'Consumer key', type: 'secret', required: true, help: 'Setup → App Manager → your Connected App → View → Consumer key.' },
      { key: 'apiSecret', label: 'Consumer secret', type: 'secret', required: true, help: 'Same page → Consumer secret.' }, workspaceField],
  },
  zoho_crm: {
    steps: ['In Zoho API Console, create a Self Client and generate a grant token with ZohoCRM.modules.ALL.', 'Paste your data centre, client ID, client secret and the grant token.', 'Map Zoho fields to UBOS in step 2.'],
    fields: [{ key: 'dc', label: 'Data centre', type: 'select', options: ['in', 'com', 'eu', 'au'], required: true, help: 'The ending of your Zoho address — zoho.in for India.' },
      { key: 'apiKey', label: 'Client ID', type: 'secret', required: true, help: 'api-console.zoho.in → Self Client → Client ID.' },
      { key: 'apiSecret', label: 'Client secret', type: 'secret', required: true },
      { key: 'grant', label: 'Grant token', type: 'secret', required: true, help: 'Self Client → Generate code; valid for a few minutes, so save right after creating it.' }, workspaceField],
  },
  pipedrive: {
    steps: ['In Pipedrive → Personal preferences → API, copy your API token.', 'Paste it with your company domain.', 'Map Pipedrive fields in step 2.'],
    fields: [{ key: 'domain', label: 'Company domain', type: 'url', required: true, placeholder: 'https://yourcompany.pipedrive.com' }, { key: 'apiKey', label: 'API token', type: 'secret', required: true, help: 'Pipedrive → avatar → Personal preferences → API.' }, workspaceField],
  },
  freshsales: {
    steps: ['In Freshsales → Profile settings → API settings, copy your API key.', 'Paste it with your bundle URL.'],
    fields: [{ key: 'domain', label: 'Bundle URL', type: 'url', required: true, placeholder: 'https://yourcompany.myfreshworks.com' }, { key: 'apiKey', label: 'API key', type: 'secret', required: true, help: 'Profile → Settings → API settings.' }, workspaceField],
  },
  leadsquared: {
    steps: ['In LeadSquared → Settings → API and webhooks, copy the access key and secret key.', 'Paste them with your API host.'],
    fields: [{ key: 'domain', label: 'API host', type: 'url', required: true, placeholder: 'https://api-in21.leadsquared.com', help: 'Shown on the same API settings page.' }, { key: 'apiKey', label: 'Access key', type: 'secret', required: true }, { key: 'apiSecret', label: 'Secret key', type: 'secret', required: true }, workspaceField],
  },
  telecrm: {
    steps: ['Ask TeleCRM support for an enterprise API token, or export leads and call history as Excel and use Bulk upload / Import past calls.', 'Paste the token below.'],
    fields: [{ key: 'apiKey', label: 'Enterprise API token', type: 'secret', required: true }, workspaceField],
  },
  linkedin_leads: {
    steps: ['Connect the LinkedIn ad account (LinkedIn sign-in arrives with the live connection).', 'Choose the Lead Gen forms to sync.'],
    fields: [{ key: 'accountId', label: 'Ad account ID', type: 'text', required: true, help: 'Campaign Manager → Account assets → Account settings.' }, workspaceField],
  },
  // Commerce & websites
  shopify: {
    steps: ['In Shopify admin → Settings → Apps → Develop apps, create an app with read_customers and read_orders.', 'Install it and copy the Admin API access token.', 'Paste the store URL and token; map customer fields in step 2.'],
    fields: [{ key: 'siteUrl', label: 'Store URL', type: 'url', required: true, placeholder: 'https://yourstore.myshopify.com' }, { key: 'apiKey', label: 'Admin API access token', type: 'secret', required: true, help: 'Develop apps → your app → API credentials → Admin API access token (shown once).' }, workspaceField],
    webhook: true,
  },
  woocommerce: {
    steps: ['In WordPress → WooCommerce → Settings → Advanced → REST API, add a key with Read permission.', 'Paste the site URL, consumer key and secret.'],
    fields: [{ key: 'siteUrl', label: 'Site URL', type: 'url', required: true }, { key: 'apiKey', label: 'Consumer key', type: 'secret', required: true, help: 'Starts with ck_.' }, { key: 'apiSecret', label: 'Consumer secret', type: 'secret', required: true, help: 'Starts with cs_.' }, workspaceField],
    webhook: true,
  },
  wordpress: {
    steps: ['Install a form-to-webhook add-on (e.g. for Contact Form 7, WPForms or Elementor Pro “Webhook” action).', 'Paste the webhook URL into the form’s webhook action.', 'Submit a test entry and map the fields in step 2.'],
    fields: [{ key: 'siteUrl', label: 'Website URL', type: 'url', required: true }, workspaceField], webhook: true,
  },
  // Calling & messaging providers
  exotel: {
    steps: ['In Exotel → API settings, copy the API key, token and account SID.', 'Paste them with your ExoPhone.', 'Add the webhook URL as the “Status callback” on your call flows.'],
    fields: [{ key: 'apiKey', label: 'API key', type: 'secret', required: true }, { key: 'apiSecret', label: 'API token', type: 'secret', required: true }, { key: 'sid', label: 'Account SID', type: 'text', required: true }, { key: 'callerId', label: 'ExoPhone', type: 'text', required: true }, workspaceField],
    webhook: true,
  },
  knowlarity: {
    steps: ['Get the API key and authorization token from Knowlarity SuperReceptionist → Settings → API.', 'Paste them with your SR number; add the webhook URL for call events.'],
    fields: [{ key: 'apiKey', label: 'x-api-key', type: 'secret', required: true }, { key: 'apiSecret', label: 'Authorization token', type: 'secret', required: true }, { key: 'callerId', label: 'SR number', type: 'text', required: true }, workspaceField],
    webhook: true,
  },
  interakt: {
    steps: ['In Interakt → Settings → Developer settings, copy the secret key.', 'Paste it; set the webhook URL in the same page for incoming messages.'],
    fields: [{ key: 'apiKey', label: 'Secret key', type: 'secret', required: true }, workspaceField], webhook: true,
  },
  wati: {
    steps: ['In WATI → API Docs, copy the API endpoint and access token.', 'Paste both; add the webhook URL under Webhooks.'],
    fields: [{ key: 'domain', label: 'API endpoint', type: 'url', required: true, placeholder: 'https://live-server-xxxx.wati.io' }, { key: 'apiKey', label: 'Access token', type: 'secret', required: true }, workspaceField], webhook: true,
  },
  // Other popular tools
  calendly: {
    steps: ['In Calendly → Integrations → API & Webhooks, create a personal access token.', 'Paste it; bookings become leads with a meeting on the calendar.'],
    fields: [{ key: 'apiKey', label: 'Personal access token', type: 'secret', required: true }, workspaceField], webhook: true,
  },
  zoom: {
    steps: ['In the Zoom App Marketplace, create a Server-to-Server OAuth app.', 'Paste the account ID, client ID and client secret.'],
    fields: [{ key: 'accountId', label: 'Account ID', type: 'text', required: true }, { key: 'apiKey', label: 'Client ID', type: 'secret', required: true }, { key: 'apiSecret', label: 'Client secret', type: 'secret', required: true }],
  },
  slack: {
    steps: ['In Slack → Apps → Incoming Webhooks, add a webhook to the channel for alerts.', 'Paste the webhook URL; choose which alerts to send (new lead, won, approvals).'],
    fields: [{ key: 'webhookUrl', label: 'Slack incoming webhook URL', type: 'url', required: true, help: 'Starts with https://hooks.slack.com/services/.' }, { key: 'alerts', label: 'Send', type: 'select', options: ['New leads and wins', 'Wins only', 'Everything'], required: true }],
  },
  mailchimp: {
    steps: ['In Mailchimp → Profile → Extras → API keys, create a key.', 'Paste it with the audience ID to sync contacts into.'],
    fields: [{ key: 'apiKey', label: 'API key', type: 'secret', required: true, help: 'Ends with your data centre, e.g. -us21.' }, { key: 'accountId', label: 'Audience ID', type: 'text', required: true, help: 'Audience → Settings → Audience name and defaults.' }],
  },
  tally_prime: {
    steps: ['Enable TallyPrime’s ODBC / XML server (F1 → Settings → Connectivity) on the PC running Tally.', 'Enter the Tally server address and company name (sync runs through the UBOS connector app).'],
    fields: [{ key: 'domain', label: 'Tally server address', type: 'url', required: true, placeholder: 'http://192.168.1.10:9000' }, { key: 'company', label: 'Company name in Tally', type: 'text', required: true }],
  },
};

export function setupFor(integrationKey: string, category: string): SetupDef {
  if (MORE[integrationKey]) return MORE[integrationKey];
  return SPECIFIC[integrationKey] ?? BY_CATEGORY[category] ?? { steps: ['Enter the details below.'], fields: [key()] };
}

// ── Field mapping: incoming data → UBOS lead ──

/** What to do when the incoming person already has an open lead in that business line. */
export const DUPLICATE_MODES = {
  add_remark: 'Keep the existing lead — add the new enquiry as a remark and bring it to the top',
  update_blank: 'Update the existing lead — fill only fields that are empty',
  overwrite: 'Update the existing lead — replace fields with the new values',
  new_lead: 'Always create a new lead (linked to the same customer)',
  skip: 'Skip — ignore enquiries from people who already have an open lead',
} as const;
export type DuplicateMode = keyof typeof DUPLICATE_MODES;

/** Built-in lead targets; custom fields are "cf:<key>". */
export const MAP_TARGETS: Record<string, string> = {
  name: 'Name', mobile: 'Mobile', email: 'Email', city: 'City', remark: 'First remark (enquiry text)', ignore: '— Ignore —',
};

const SOURCE_FIELDS: Record<string, string[]> = {
  indiamart: ['SENDER_NAME', 'SENDER_MOBILE', 'SENDER_EMAIL', 'SENDER_CITY', 'SENDER_COMPANY', 'QUERY_PRODUCT_NAME', 'QUERY_MESSAGE'],
  justdial: ['name', 'mobile', 'email', 'city', 'category', 'area'],
  tradeindia: ['sender_name', 'sender_mobile', 'sender_email', 'sender_city', 'product_name', 'message'],
  facebook_leads: ['full_name', 'phone_number', 'email', 'city', 'form_name', 'campaign_name'],
  linkedin_leads: ['firstName', 'lastName', 'phoneNumber', 'emailAddress', 'company', 'jobTitle'],
  google_ads: ['FULL_NAME', 'PHONE_NUMBER', 'EMAIL', 'CITY', 'campaign_id'],
  whatsapp: ['profile_name', 'wa_id', 'message'],
  whatsapp_widget: ['name', 'phone', 'message', 'page_url'],
  callerdesk: ['caller_name', 'caller_number', 'call_status', 'recording_url'],
  website_api: ['name', 'mobile', 'email', 'city', 'message', 'utm_source'],
  google_sheets: ['Name', 'Mobile', 'Email', 'City', 'Notes'],
  wordpress: ['your-name', 'your-phone', 'your-email', 'your-message'],
  shopify: ['customer.first_name', 'customer.last_name', 'customer.phone', 'customer.email', 'shipping_address.city', 'line_items'],
  woocommerce: ['billing.first_name', 'billing.last_name', 'billing.phone', 'billing.email', 'billing.city', 'line_items'],
  acres99: ['name', 'mobile', 'email', 'city', 'project', 'budget'],
  magicbricks: ['name', 'mobile', 'email', 'city', 'project', 'budget'],
  housing: ['name', 'mobile', 'email', 'city', 'project'],
  shiksha: ['name', 'mobile', 'email', 'city', 'course', 'college'],
};
const DEFAULT_SOURCE = ['name', 'phone', 'email', 'city', 'message'];

/** Sensible first guess: incoming field → lead field. */
export function guessTarget(sourceField: string): string {
  const f = sourceField.toLowerCase().replace(/[^a-z]/g, '');
  if (/(fullname|sendername|callername|profilename|^name$|yourname|firstname)/.test(f)) return 'name';
  if (/(phone|mobile|waid|callernumber|contact)/.test(f)) return 'mobile';
  if (/email/.test(f)) return 'email';
  if (/city/.test(f)) return 'city';
  if (/(message|query|notes|remark|comment)/.test(f)) return 'remark';
  return 'ignore';
}

export function sourceFieldsFor(integrationKey: string): string[] {
  return SOURCE_FIELDS[integrationKey] ?? DEFAULT_SOURCE;
}
/** Integrations whose data becomes leads (they get the mapping step). */
export function bringsLeads(def: SetupDef) {
  return def.fields.some((f) => f.key === 'businessLine');
}
