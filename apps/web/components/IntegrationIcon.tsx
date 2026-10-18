import {
  siAnthropic, siBrevo, siCalendly, siDropbox, siFacebook, siGmail, siGoogle, siGoogleads, siGoogleanalytics, siGoogledrive,
  siGoogleforms, siGooglegemini, siGooglemeet, siGooglesheets, siHubspot, siInstagram, siIntercom, siMailchimp, siMake, siMessenger,
  siMeta, siN8n, siNotion, siOdoo, siPaypal, siPaytm, siPhonepe, siQuickbooks, siRazorpay, siShopify, siStripe, siTata, siTelegram,
  siTypeform, siWebflow, siWhatsapp, siWix, siWoocommerce, siWordpress, siYoutube, siZapier, siZendesk, siZoho, siZoom,
} from 'simple-icons';

type SimpleIcon = { title: string; hex: string; path: string };

/** Official brand marks (simple-icons, CC0) where available. */
const ICONS: Record<string, SimpleIcon> = {
  google_sheets: siGooglesheets, facebook_leads: siFacebook, google_ads: siGoogleads, youtube: siYoutube, google_business: siGoogle,
  google_forms: siGoogleforms, typeform: siTypeform, tatatele: siTata,
  whatsapp: siWhatsapp, whatsapp_widget: siWhatsapp, instagram_dm: siInstagram, messenger: siMessenger, telegram: siTelegram, email_smtp: siGmail,
  wordpress: siWordpress, wix: siWix, webflow: siWebflow, shopify: siShopify, woocommerce: siWoocommerce,
  razorpay: siRazorpay, paytm: siPaytm, phonepe: siPhonepe, stripe: siStripe, paypal: siPaypal,
  zoho_books: siZoho, quickbooks: siQuickbooks,
  google_analytics: siGoogleanalytics, meta_capi: siMeta, mailchimp: siMailchimp, brevo: siBrevo,
  anthropic: siAnthropic, gemini: siGooglegemini, zapier: siZapier, make: siMake, n8n: siN8n,
  google_meet: siGooglemeet, zoom: siZoom, calendly: siCalendly, google_drive: siGoogledrive, dropbox: siDropbox, notion: siNotion,
  zendesk: siZendesk, intercom: siIntercom, zoho_crm: siZoho, hubspot: siHubspot, odoo: siOdoo,
};

/** Brand-coloured monogram tiles for services without a published mark. */
const MONOGRAMS: Record<string, [string, string]> = {
  website_api: ['</>', '#5b3cc4'], linkedin_leads: ['in', '#0a66c2'], indiamart: ['IM', '#2e3192'], justdial: ['Jd', '#ff6600'],
  tradeindia: ['TI', '#1a5fb4'], sulekha: ['S', '#e21e26'], urbancompany: ['UC', '#111111'], shiksha: ['S', '#f47920'],
  collegedunia: ['CD', '#1c5d99'], careers360: ['C', '#f15a24'], acres99: ['99', '#0f4c81'], magicbricks: ['MB', '#d8232a'],
  housing: ['H', '#6c2eb9'], nobroker: ['NB', '#fd3752'], jotform: ['J', '#ff6100'], tally_forms: ['T', '#111111'],
  callerdesk: ['CD', '#0b6efd'], knowlarity: ['K', '#e4002b'], exotel: ['E', '#2c66dd'], myoperator: ['MO', '#0071bc'],
  ozonetel: ['O', '#f26522'], servetel: ['S', '#0fa0ce'], telecmi: ['T', '#ff5a1f'], mcube: ['M', '#00a651'], maqsam: ['M', '#7b2ff7'],
  twilio: ['Tw', '#f22f46'], interakt: ['I', '#0d6efd'], wati: ['W', '#23b7e5'], aisensy: ['AI', '#00a884'], gupshup: ['G', '#f99d1c'],
  sms_dlt: ['SMS', '#546e7a'], cashfree: ['C', '#5d2be3'], payu: ['PU', '#8bb31d'], instamojo: ['IM', '#ec6140'],
  tally_prime: ['T', '#0057a8'], openai: ['AI', '#10a37f'], pabbly: ['P', '#0e7afe'], ms_teams: ['T', '#5059c9'], slack: ['S', '#4a154b'],
  freshdesk: ['F', '#0fb875'], salesforce: ['SF', '#00a1e0'], leadsquared: ['LS', '#0d74bc'], telecrm: ['T', '#6c3ef4'],
  pipedrive: ['P', '#017737'], freshsales: ['F', '#f2603a'], bitrix24: ['B', '#2fc6f6'], kylas: ['K', '#1f6feb'],
};

export function IntegrationIcon({ id, name, size = 40 }: { id: string; name: string; size?: number }) {
  const icon = ICONS[id];
  if (icon) {
    return (
      <span className="int-icon" style={{ width: size, height: size, background: `#${icon.hex}14` }} aria-hidden="true">
        <svg viewBox="0 0 24 24" width={size * 0.55} height={size * 0.55} fill={`#${icon.hex}`}><path d={icon.path} /></svg>
      </span>
    );
  }
  const [text, color] = MONOGRAMS[id] ?? [name.replace(/[^A-Za-z0-9]/g, '').slice(0, 2).toUpperCase(), '#5b3cc4'];
  return (
    <span className="int-icon mono" style={{ width: size, height: size, background: color, fontSize: size * (text.length > 2 ? 0.28 : 0.36) }} aria-hidden="true">{text}</span>
  );
}
