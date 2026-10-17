// Analytics catalogue shared by the API (query engine) and the web (dashboard builder).

export type MetricFormat = 'count' | 'percent' | 'hours' | 'minutes' | 'currency';
export type GroupBy =
  | 'none' | 'day' | 'week' | 'month' | 'stage' | 'status' | 'source' | 'owner' | 'workspace'
  | 'disposition' | 'lost_reason' | 'heatmap';
export type RangePreset = 'today' | 'yesterday' | 'last_7_days' | 'last_30_days' | 'this_month' | 'last_month' | 'this_quarter' | 'this_year' | 'custom';
export type WidgetType = 'kpi' | 'line' | 'bar' | 'pie' | 'funnel' | 'table' | 'leaderboard' | 'heatmap' | 'gauge' | 'followups' | 'forecast';

export interface MetricDef {
  label: string;
  format: MetricFormat;
  /** Which date the range applies to; "none" = a current snapshot that ignores the range. */
  basis: 'created' | 'closed' | 'activity' | 'due' | 'none';
  groupBy: GroupBy[];
  hint: string;
  /** Higher is better (for trend colours); false for e.g. response time. */
  up?: boolean;
}

const TIME: GroupBy[] = ['day', 'week', 'month'];
const LEAD_DIMS: GroupBy[] = ['stage', 'status', 'source', 'owner', 'workspace'];

export const METRICS: Record<string, MetricDef> = {
  leads: { label: 'New leads', format: 'count', basis: 'created', groupBy: ['none', ...TIME, ...LEAD_DIMS], hint: 'Leads created in the period', up: true },
  won: { label: 'Leads won', format: 'count', basis: 'closed', groupBy: ['none', ...TIME, 'source', 'owner', 'workspace'], hint: 'Leads moved to a Won stage in the period', up: true },
  lost: { label: 'Leads lost', format: 'count', basis: 'closed', groupBy: ['none', ...TIME, 'source', 'owner', 'workspace', 'lost_reason'], hint: 'Leads moved to a Lost stage in the period', up: false },
  win_rate: { label: 'Win rate', format: 'percent', basis: 'closed', groupBy: ['none', ...TIME, 'source', 'owner', 'workspace'], hint: 'Won ÷ (won + lost) closed in the period', up: true },
  open_leads: { label: 'Open leads', format: 'count', basis: 'none', groupBy: ['none', 'stage', 'status', 'source', 'owner', 'workspace'], hint: 'Leads not yet won or lost (today)' },
  stuck_leads: { label: 'Stuck leads', format: 'count', basis: 'none', groupBy: ['none', 'stage', 'owner', 'workspace'], hint: 'Open leads longer in their stage than the stage SLA', up: false },
  contact_rate: { label: 'Contact rate', format: 'percent', basis: 'created', groupBy: ['none', ...TIME, 'source', 'owner', 'workspace'], hint: 'Share of new leads that were worked (call or remark)', up: true },
  first_response: { label: 'First response time', format: 'hours', basis: 'created', groupBy: ['none', ...TIME, 'source', 'owner', 'workspace'], hint: 'Average hours from enquiry to first call or remark', up: false },
  calls: { label: 'Calls', format: 'count', basis: 'activity', groupBy: ['none', ...TIME, 'owner', 'workspace', 'disposition', 'heatmap'], hint: 'Calls logged in the period', up: true },
  connected_calls: { label: 'Connected calls', format: 'count', basis: 'activity', groupBy: ['none', ...TIME, 'owner', 'workspace', 'heatmap'], hint: 'Calls where the customer was reached', up: true },
  connect_rate: { label: 'Connect rate', format: 'percent', basis: 'activity', groupBy: ['none', ...TIME, 'owner', 'workspace', 'heatmap'], hint: 'Connected ÷ all calls', up: true },
  talk_time: { label: 'Talk time', format: 'minutes', basis: 'activity', groupBy: ['none', ...TIME, 'owner', 'workspace'], hint: 'Minutes on connected calls', up: true },
  followups_due: { label: 'Follow-ups due', format: 'count', basis: 'due', groupBy: ['none', ...TIME, 'owner', 'workspace'], hint: 'Follow-ups planned for the period' },
  followup_compliance: { label: 'Follow-ups done on time', format: 'percent', basis: 'due', groupBy: ['none', ...TIME, 'owner', 'workspace'], hint: 'Due follow-ups closed by the end of their day', up: true },
  overdue_followups: { label: 'Overdue follow-ups', format: 'count', basis: 'none', groupBy: ['none', 'owner', 'workspace'], hint: 'Open follow-ups past their time (today)', up: false },
  pipeline_value: { label: 'Pipeline value', format: 'currency', basis: 'none', groupBy: ['none', 'stage', 'owner', 'workspace'], hint: 'Deal value of open leads (business lines with a deal value field)' },
  weighted_pipeline: { label: 'Weighted pipeline', format: 'currency', basis: 'none', groupBy: ['none', 'stage', 'owner', 'workspace'], hint: 'Deal value × stage win probability' },
  won_value: { label: 'Won value', format: 'currency', basis: 'closed', groupBy: ['none', ...TIME, 'source', 'owner', 'workspace'], hint: 'Deal value of leads won in the period', up: true },
};

export const GROUP_LABELS: Record<GroupBy, string> = {
  none: 'Total', day: 'Day', week: 'Week', month: 'Month', stage: 'Stage', status: 'Status', source: 'Source', owner: 'Person',
  workspace: 'Business line', disposition: 'Call outcome', lost_reason: 'Lost reason', heatmap: 'Weekday × hour',
};

export const RANGE_LABELS: Record<RangePreset, string> = {
  today: 'Today', yesterday: 'Yesterday', last_7_days: 'Last 7 days', last_30_days: 'Last 30 days', this_month: 'This month',
  last_month: 'Last month', this_quarter: 'This quarter', this_year: 'This year', custom: 'Custom',
};

export const WIDGET_LABELS: Record<WidgetType, string> = {
  kpi: 'KPI tile', line: 'Line / trend', bar: 'Bar chart', pie: 'Donut', funnel: 'Funnel', table: 'Table', leaderboard: 'Leaderboard',
  heatmap: 'Heatmap (best time to call)', gauge: 'Target gauge', followups: 'Follow-up list', forecast: 'Month-end forecast',
};

/** Widgets that need no metric of their own. */
export const SPECIAL_WIDGETS: WidgetType[] = ['funnel', 'leaderboard', 'followups', 'forecast'];

export interface WidgetConfig {
  id: string;
  type: WidgetType;
  title: string;
  metric?: string;
  groupBy?: GroupBy;
  /** Widget-level range; empty = the dashboard's range. */
  range?: RangePreset;
  target?: number;
  w: 3 | 4 | 6 | 8 | 12; // width in 12-column grid
  h: 1 | 2 | 3; // height in rows
}

const kpi = (id: string, metric: string, w: WidgetConfig['w'] = 3): WidgetConfig => ({ id, type: 'kpi', title: METRICS[metric].label, metric, groupBy: 'none', w, h: 1 });

/** Ready dashboards for each level. People duplicate them to customise. */
export const DASHBOARD_TEMPLATES: { key: string; name: string; description: string; widgets: WidgetConfig[] }[] = [
  {
    key: 'company', name: 'Company overview', description: 'All business lines together — for the CEO / management.',
    widgets: [
      kpi('k1', 'leads'), kpi('k2', 'won'), kpi('k3', 'win_rate'), kpi('k4', 'weighted_pipeline'),
      { id: 'c1', type: 'bar', title: 'New leads by business line', metric: 'leads', groupBy: 'workspace', w: 6, h: 2 },
      { id: 'c2', type: 'line', title: 'New leads per day', metric: 'leads', groupBy: 'day', w: 6, h: 2 },
      { id: 'c3', type: 'forecast', title: 'Month-end forecast', w: 4, h: 2 },
      { id: 'c4', type: 'bar', title: 'Win rate by business line', metric: 'win_rate', groupBy: 'workspace', w: 4, h: 2 },
      { id: 'c5', type: 'pie', title: 'Leads by source', metric: 'leads', groupBy: 'source', w: 4, h: 2 },
      { id: 'c6', type: 'leaderboard', title: 'Leaderboard', w: 12, h: 2 },
    ],
  },
  {
    key: 'business_line', name: 'Business line', description: 'One business line: funnel, sources, team and forecast.',
    widgets: [
      kpi('k1', 'leads'), kpi('k2', 'contact_rate'), kpi('k3', 'first_response'), kpi('k4', 'stuck_leads'),
      { id: 'c1', type: 'funnel', title: 'Funnel (new leads in the period)', w: 6, h: 2 },
      { id: 'c2', type: 'bar', title: 'Open leads by stage', metric: 'open_leads', groupBy: 'stage', w: 6, h: 2 },
      { id: 'c3', type: 'table', title: 'Win rate by source', metric: 'win_rate', groupBy: 'source', w: 4, h: 2 },
      { id: 'c4', type: 'pie', title: 'Why leads are lost', metric: 'lost', groupBy: 'lost_reason', w: 4, h: 2 },
      { id: 'c5', type: 'forecast', title: 'Month-end forecast', w: 4, h: 2 },
      { id: 'c7', type: 'leaderboard', title: 'Team leaderboard', w: 12, h: 2 },
    ],
  },
  {
    key: 'team', name: 'Team', description: 'Calls, follow-up discipline and the team leaderboard — for managers and team leaders.',
    widgets: [
      kpi('k1', 'calls'), kpi('k2', 'connect_rate'), kpi('k3', 'followup_compliance'), kpi('k4', 'overdue_followups'),
      { id: 'c1', type: 'line', title: 'Calls per day', metric: 'calls', groupBy: 'day', w: 6, h: 2 },
      { id: 'c2', type: 'heatmap', title: 'Best time to call (connect rate)', metric: 'connect_rate', groupBy: 'heatmap', w: 6, h: 2 },
      { id: 'c3', type: 'bar', title: 'Calls by outcome', metric: 'calls', groupBy: 'disposition', w: 6, h: 2 },
      { id: 'c4', type: 'bar', title: 'Overdue follow-ups by person', metric: 'overdue_followups', groupBy: 'owner', w: 6, h: 2 },
      { id: 'c5', type: 'leaderboard', title: 'Leaderboard', w: 12, h: 2 },
    ],
  },
  {
    key: 'my_day', name: 'My day', description: 'Your follow-ups, calls and wins.',
    widgets: [
      kpi('k1', 'overdue_followups'), kpi('k2', 'calls'), kpi('k3', 'connected_calls'), kpi('k4', 'won'),
      { id: 'c1', type: 'followups', title: 'Follow-ups due today & overdue', w: 6, h: 2 },
      { id: 'c2', type: 'bar', title: 'My open leads by stage', metric: 'open_leads', groupBy: 'stage', w: 6, h: 2 },
      { id: 'c3', type: 'line', title: 'My calls per day', metric: 'calls', groupBy: 'day', w: 6, h: 2 },
      { id: 'c4', type: 'gauge', title: 'Calls vs target', metric: 'calls', groupBy: 'none', target: 300, w: 6, h: 2 },
    ],
  },
  {
    key: 'marketing', name: 'Marketing', description: 'Sources: volume, contact and win rates.',
    widgets: [
      kpi('k1', 'leads'), kpi('k2', 'contact_rate'), kpi('k3', 'win_rate'), kpi('k4', 'first_response'),
      { id: 'c1', type: 'bar', title: 'New leads by source', metric: 'leads', groupBy: 'source', w: 6, h: 2 },
      { id: 'c2', type: 'table', title: 'Win rate by source', metric: 'win_rate', groupBy: 'source', w: 6, h: 2 },
      { id: 'c3', type: 'line', title: 'New leads per week', metric: 'leads', groupBy: 'week', w: 12, h: 2 },
    ],
  },
];

/** Default probability that an open lead in this stage is won, when the stage has none set. */
export function defaultWinProbability(position: number, openStages: number): number {
  return Math.round(((position + 1) / (openStages + 1)) * 80);
}
