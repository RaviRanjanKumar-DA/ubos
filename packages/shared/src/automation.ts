// Automation rules: "when X, if Y, then Z".

export const AUTOMATION_TRIGGERS = {
  'lead.created': 'A new lead arrives',
  'lead.updated': 'A repeat enquiry arrives',
  'lead.stage_changed': 'A lead changes stage',
  'lead.won': 'A lead is won',
  'lead.lost': 'A lead is lost',
  'call.logged': 'A call is logged',
  'whatsapp.received': 'A WhatsApp message arrives',
  'payment.received': 'A payment is recorded',
  'quote.accepted': 'A quote is accepted',
  'process.completed': 'An after-sale process is completed',
  'lead.idle': 'A lead has no activity for some days',
} as const;
export type AutomationTrigger = keyof typeof AUTOMATION_TRIGGERS;

export const AUTOMATION_ACTIONS = {
  assign: 'Assign the lead',
  change_stage: 'Change stage',
  set_status: 'Set status',
  add_label: 'Add a label',
  create_task: 'Create a task',
  add_remark: 'Add a remark',
  send_template: 'Send a template (WhatsApp / SMS / email)',
  notify_owner: 'Notify the lead owner',
  enroll_sequence: 'Start a sequence',
} as const;
export type AutomationAction = keyof typeof AUTOMATION_ACTIONS;

export const CONDITION_OPS = { eq: 'is', neq: 'is not', contains: 'contains', gt: 'more than', lt: 'less than', empty: 'is empty', not_empty: 'is filled' } as const;
export type ConditionOp = keyof typeof CONDITION_OPS;
/** Built-in condition fields; custom lead fields are "cf:<key>". */
export const CONDITION_FIELDS: Record<string, string> = { source: 'Source', status: 'Status', stage: 'Stage', owner: 'Owner', score: 'Score', city: 'City' };

export interface RuleCondition { field: string; op: ConditionOp; value?: string }

/** Whether a lead's values satisfy every condition (shared so the engine and tests agree). */
export function matchesConditions(conditions: RuleCondition[], values: Record<string, unknown>) {
  return conditions.every((c) => {
    const raw = values[c.field];
    const blank = raw === undefined || raw === null || raw === '';
    if (c.op === 'empty') return blank;
    if (c.op === 'not_empty') return !blank;
    if (blank) return c.op === 'neq';
    const a = String(raw).toLowerCase(), b = String(c.value ?? '').toLowerCase();
    if (c.op === 'eq') return a === b;
    if (c.op === 'neq') return a !== b;
    if (c.op === 'contains') return a.includes(b);
    return c.op === 'gt' ? Number(raw) > Number(c.value) : Number(raw) < Number(c.value);
  });
}
