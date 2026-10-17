import type { PrismaClient, Tx } from '@ubos/database';

type Db = Tx | PrismaClient;
type Level = 'basic' | 'advanced';
/** A step is either built (with a check and a link) or planned for a later phase. */
interface StepDef { id: string; title: string; level: Level; href?: string; phase?: string; done?: (c: Ctx) => Promise<boolean> }
interface CardDef { id: string; title: string; hint: string; tone: string; steps: StepDef[] }
interface GuideDef { id: string; title: string; icon: string; hint: string; cards: CardDef[] }
interface Ctx { db: Db; tenantId: string; workspaceId: string | null; audit: (prefix: string) => Promise<boolean> }

const WS = (tab: string) => (c: { workspaceId: string | null }) => (c.workspaceId ? `/app/workspaces/${c.workspaceId}?tab=${tab}` : '/app/workspaces');
const hrefs: Record<string, (c: { workspaceId: string | null }) => string> = {
  lead_fields: WS('fields'), lead_stages: WS('stages'), call_feedback: WS('feedback'), custom_actions: WS('actions'),
  sop_forms: WS('stages'), assignment_rules: WS('assignment'),
};

/**
 * The Setup Guide. Steps tick themselves off from real data (nobody ticks by hand); steps whose feature is not
 * built yet carry the phase that brings it. Later slices replace a `phase` with a check and a link.
 */
export const GUIDES: GuideDef[] = [
  {
    id: 'start', title: 'All you need to get started', icon: '🚀', hint: 'The essentials — your leads, your team, and UBOS set up the way you sell.',
    cards: [
      {
        id: 'leads', title: 'Set up your leads', hint: 'Shape your lead data, pipeline and how new leads land.', tone: '#d5efe9', steps: [
          { id: 'lead_fields', title: 'Configure lead fields', level: 'basic', done: async (c) => (await c.db.leadField.count({ where: { tenantId: c.tenantId, isArchived: false } })) > 0 },
          { id: 'lead_stages', title: 'Configure lead stages', level: 'basic', done: (c) => c.audit('pipeline.') },
          { id: 'add_lead', title: 'Add your first lead manually', level: 'basic', href: '/app/leads', done: async (c) => (await c.db.lead.count({ where: { tenantId: c.tenantId, importId: null } })) > 0 },
          { id: 'import_leads', title: 'Import leads from another CRM (Excel / CSV)', level: 'basic', href: '/app/leads/import', done: async (c) => (await c.db.leadImport.count({ where: { tenantId: c.tenantId } })) > 0 },
          { id: 'import_history', title: 'Import past calls and remarks from another CRM', level: 'advanced', phase: '1.5c' },
        ],
      },
      {
        id: 'team', title: 'Set up your team', hint: 'Add your people and decide who can do what.', tone: '#d6e6fb', steps: [
          { id: 'add_members', title: 'Add team members', level: 'basic', href: '/app/users', done: async (c) => (await c.db.user.count({ where: { tenantId: c.tenantId, isActive: true } })) > 1 },
          { id: 'team_structure', title: 'Configure branches, departments and teams', level: 'basic', href: '/app/org', done: async (c) => (await c.db.team.count({ where: { tenantId: c.tenantId } })) > 0 },
          { id: 'member_access', title: 'Configure roles and access', level: 'advanced', href: '/app/roles', done: async (c) => (await c.audit('role.')) || (await c.audit('user.roles_changed')) },
          { id: 'assignment_rules', title: 'Set lead assignment rules', level: 'basic', done: (c) => c.audit('workspace.assignment_changed') },
          { id: 'role_dashboards', title: 'Configure dashboards per role', level: 'advanced', phase: '1.6' },
        ],
      },
      {
        id: 'customise', title: 'Customise for your business', hint: 'Make UBOS sound and behave the way your team already works.', tone: '#fbe0cf', steps: [
          { id: 'call_feedback', title: 'Configure call feedback and lead statuses', level: 'basic', done: async (c) => (await c.audit('workspace.call_disposition')) || (await c.audit('workspace.lead_status')) },
          { id: 'custom_actions', title: 'Configure custom actions', level: 'basic', done: async (c) => (await c.db.customAction.count({ where: { tenantId: c.tenantId } })) > 0 },
          { id: 'sop_forms', title: 'Add stage rules (required details before a stage)', level: 'advanced', done: async (c) => (await c.db.leadStage.count({ where: { tenantId: c.tenantId, requiredFieldKeys: { isEmpty: false } } })) > 0 },
          { id: 'labels', title: 'Configure labels (tags)', level: 'advanced', phase: '1.5c' },
          { id: 'process_templates', title: 'Process templates after a sale (steps, owners, payments)', level: 'advanced', phase: '1.5d' },
        ],
      },
      {
        id: 'secure', title: 'Secure your organization', hint: 'Protect sign-ins and keep your licences in order.', tone: '#e3d9f7', steps: [
          { id: 'two_factor', title: 'Turn on two-factor sign-in for yourself', level: 'basic', href: '/app/security', done: async (c) => (await c.db.user.count({ where: { tenantId: c.tenantId, totpEnabled: true } })) > 0 },
          { id: 'security_policy', title: 'Review the security policy (2FA by role, IP allow-list, sign-in methods)', level: 'advanced', href: '/app/settings/security', done: (c) => c.audit('settings.security_updated') },
          { id: 'licences', title: 'Buy licences for your team', level: 'basic', href: '/app/billing', done: async (c) => (await c.db.subscription.count({ where: { tenantId: c.tenantId, status: 'active' } })) > 0 },
        ],
      },
    ],
  },
  {
    id: 'calling', title: 'Calling & Messaging', icon: '📞', hint: 'Calls, SMS, message templates, calling campaigns and AI call notes.',
    cards: [
      { id: 'sim', title: 'SIM-based calling', hint: "Use your reps' own SIMs — calls log automatically.", tone: '#d5efe9', steps: [
        { id: 'sim_recording', title: 'Configure SIM call recording', level: 'basic', phase: '2' },
        { id: 'sim_mode', title: 'SIM mode in the mobile app', level: 'basic', phase: '2' },
      ] },
      { id: 'templates', title: 'Messaging templates', hint: 'Pre-written WhatsApp, SMS and email so reps send in one tap.', tone: '#f7d3dc', steps: [
        { id: 'message_templates', title: 'WhatsApp / SMS / email templates', level: 'advanced', phase: '2' },
      ] },
      { id: 'campaigns', title: 'Calling campaigns', hint: 'Work through a list of leads in a focused calling sprint.', tone: '#f6d0cb', steps: [
        { id: 'campaign_setup', title: 'Configure calling campaigns', level: 'basic', phase: '2' },
        { id: 'first_campaign', title: 'Run your first campaign', level: 'basic', phase: '2' },
      ] },
      { id: 'summariser', title: 'Call summariser', hint: 'AI listens to calls and writes the notes for you.', tone: '#d6e6fb', steps: [
        { id: 'call_summary', title: 'Configure AI call notes', level: 'advanced', phase: '4' },
      ] },
    ],
  },
  {
    id: 'whatsapp', title: 'WhatsApp', icon: '💬', hint: 'Sync chats, or set up the WhatsApp Business API for templates and broadcasts.',
    cards: [
      { id: 'wa_sync', title: 'WhatsApp chat sync', hint: 'Bring WhatsApp conversations onto the lead journey.', tone: '#cdeed8', steps: [
        { id: 'wa_chat_sync', title: 'Connect WhatsApp chat sync', level: 'advanced', phase: '2' },
      ] },
      { id: 'wa_api', title: 'WhatsApp Business API', hint: 'Official WhatsApp for templates and broadcasts.', tone: '#dfe8d2', steps: [
        { id: 'wa_business', title: 'Set up WhatsApp Business API', level: 'advanced', phase: '2' },
        { id: 'wa_templates', title: 'Configure message templates', level: 'basic', phase: '2' },
        { id: 'wa_broadcast', title: 'Send your first broadcast', level: 'basic', phase: '2' },
      ] },
    ],
  },
  {
    id: 'ivr', title: 'IVR / Cloud Telephony', icon: '☎️', hint: 'Connect a cloud telephony provider; calls and recordings land on the lead.',
    cards: [
      { id: 'ivr_providers', title: 'Connect your IVR provider', hint: 'Already using an Indian telephony provider? Plug it in.', tone: '#d6e6fb', steps: [
        { id: 'ivr_callerdesk', title: 'Connect CallerDesk', level: 'advanced', phase: '2' },
        { id: 'ivr_telecmi', title: 'Connect TeleCMI', level: 'advanced', phase: '2' },
        { id: 'ivr_tata', title: 'Connect Tata Tele Services', level: 'advanced', phase: '2' },
        { id: 'ivr_knowlarity', title: 'Connect Knowlarity', level: 'advanced', phase: '2' },
        { id: 'ivr_mcube', title: 'Connect MCube', level: 'advanced', phase: '2' },
        { id: 'ivr_maqsam', title: 'Connect Maqsam', level: 'advanced', phase: '2' },
      ] },
    ],
  },
  {
    id: 'integrations', title: 'Integrations & Lead Sources', icon: '🔌', hint: 'Plug in the tools that send you leads or take payments.',
    cards: [
      { id: 'sources', title: 'Lead sources', hint: 'Wire up the channels that bring in your leads.', tone: '#d5efe9', steps: [
        { id: 'src_facebook', title: 'Connect Facebook Lead Ads', level: 'basic', phase: '1.7' },
        { id: 'src_sheets', title: 'Connect Google Sheets', level: 'basic', phase: '1.7' },
        { id: 'src_portals', title: 'Connect lead portals (IndiaMART, JustDial)', level: 'basic', phase: '1.7' },
      ] },
      { id: 'ecommerce', title: 'E-commerce', hint: 'Sync orders and abandoned carts as leads.', tone: '#e3d9f7', steps: [
        { id: 'shopify', title: 'Connect Shopify', level: 'basic', phase: '3' },
        { id: 'woocommerce', title: 'Connect WooCommerce', level: 'basic', phase: '3' },
      ] },
      { id: 'payments', title: 'Payments', hint: 'Send payment links and track them on leads.', tone: '#d5efe9', steps: [
        { id: 'razorpay', title: 'Connect Razorpay', level: 'basic', phase: '3' },
      ] },
    ],
  },
  {
    id: 'automation', title: 'Automation & Workflows', icon: '⚡', hint: 'Flowcharts, schedules, sequences and webhooks.',
    cards: [
      { id: 'first_automation', title: 'Build your first automation', hint: 'Pick the right tool for the job.', tone: '#fbe0cf', steps: [
        { id: 'flowchart', title: 'Create a flowchart', level: 'advanced', phase: '3' },
        { id: 'schedule', title: 'Set up a schedule', level: 'advanced', phase: '2' },
        { id: 'api_templates', title: 'Use API templates', level: 'advanced', phase: '3' },
        { id: 'sequence', title: 'Build a sequence', level: 'advanced', phase: '2' },
      ] },
      { id: 'webhooks', title: 'Webhooks', hint: 'Send UBOS events to any system.', tone: '#d6e6fb', steps: [
        { id: 'webhook_setup', title: 'Configure webhooks', level: 'advanced', phase: '1.7' },
      ] },
    ],
  },
  {
    id: 'reports', title: 'Reports & Analytics', icon: '📊', hint: 'Numbers your team can act on.',
    cards: [
      { id: 'numbers', title: 'Explore your numbers', hint: 'The three reports every team should know.', tone: '#cdeed8', steps: [
        { id: 'leaderboard', title: 'View the leaderboard', level: 'basic', phase: '1.6' },
        { id: 'call_reports', title: 'Review call reports', level: 'basic', phase: '1.6' },
        { id: 'lead_reports', title: 'Review lead reports', level: 'basic', phase: '1.6' },
      ] },
    ],
  },
  {
    id: 'data', title: 'Move your Data Around', icon: '🗂️', hint: 'Get data in, out and updated without spreadsheet pain.',
    cards: [
      { id: 'export', title: 'Export data', hint: 'Take leads or actions out of UBOS (as your access allows).', tone: '#d5efe9', steps: [
        { id: 'export_leads', title: 'Export leads', level: 'basic', href: '/app/leads', done: (c) => c.audit('lead.exported') },
        { id: 'export_actions', title: 'Export calls, remarks and actions', level: 'basic', phase: '1.5c' },
      ] },
      { id: 'update', title: 'Update data', hint: 'Bulk-edit leads in the app or through Excel.', tone: '#fbe0cf', steps: [
        { id: 'bulk_edit', title: 'Bulk edit leads (in the app)', level: 'basic', href: '/app/leads', done: (c) => c.audit('lead.bulk_') },
        { id: 'bulk_excel', title: 'Bulk edit leads (Excel)', level: 'advanced', phase: '1.5c' },
      ] },
    ],
  },
  {
    id: 'ai', title: 'AI Assistants & Connectors', icon: '🤖', hint: 'Connect Claude, ChatGPT and other AI tools to your CRM.',
    cards: [
      { id: 'mcp', title: 'Connect Claude, ChatGPT & other AI tools', hint: 'One connector — AI tools read and act on UBOS within your permissions.', tone: '#e3d9f7', steps: [
        { id: 'mcp_setup', title: 'Configure the AI connector (MCP)', level: 'advanced', phase: '4' },
      ] },
    ],
  },
  {
    id: 'developer', title: 'Developer & Advanced', icon: '🛠️', hint: 'Build on top of UBOS.',
    cards: [
      { id: 'api', title: 'API access', hint: 'Programmatic access to your data.', tone: '#d5efe9', steps: [
        { id: 'api_keys', title: 'Generate API keys', level: 'advanced', phase: '1.7' },
      ] },
      { id: 'embed', title: 'Customise the app', hint: 'Embed your own tools inside UBOS.', tone: '#d6e6fb', steps: [
        { id: 'embedded_apps', title: 'Add embedded apps & iframes', level: 'advanced', phase: '5' },
      ] },
    ],
  },
];

export const STEP_IDS = new Set(GUIDES.flatMap((g) => g.cards.flatMap((c) => c.steps.map((s) => s.id))));

/** Works with a tenant transaction (RLS) or the platform client: every query names the tenant explicitly. */
export async function setupGuide(db: Db, tenantId: string) {
  const [settings, ws, actions] = await Promise.all([
    db.organizationSetting.findUnique({ where: { tenantId }, select: { setupSkipped: true } }),
    db.workspace.findFirst({ where: { tenantId, isArchived: false }, orderBy: { name: 'asc' }, select: { id: true } }),
    db.auditLog.findMany({ where: { tenantId }, distinct: ['action'], select: { action: true } }),
  ]);
  const seen = actions.map((a) => a.action);
  const ctx: Ctx = { db, tenantId, workspaceId: ws?.id ?? null, audit: async (prefix) => seen.some((a) => a.startsWith(prefix)) };
  const skipped = new Set(settings?.setupSkipped ?? []);
  const guides = [];
  for (const g of GUIDES) {
    const cards = [];
    for (const c of g.cards) {
      const steps = [];
      for (const s of c.steps) {
        const available = !!s.done;
        const done = available ? await s.done!(ctx) : false;
        steps.push({
          id: s.id, title: s.title, level: s.level, available, done, skipped: !done && skipped.has(s.id),
          href: available ? s.href ?? hrefs[s.id]?.(ctx) ?? null : null, phase: s.phase ?? null,
        });
      }
      cards.push({ id: c.id, title: c.title, hint: c.hint, tone: c.tone, steps, done: steps.filter((x) => x.done || x.skipped).length, total: steps.length });
    }
    guides.push({ id: g.id, title: g.title, icon: g.icon, hint: g.hint, cards, done: cards.reduce((n, c) => n + c.done, 0), total: cards.reduce((n, c) => n + c.total, 0) });
  }
  const avail = guides.flatMap((g) => g.cards.flatMap((c) => c.steps)).filter((s) => s.available);
  return { guides, available: { done: avail.filter((s) => s.done || s.skipped).length, total: avail.length } };
}
