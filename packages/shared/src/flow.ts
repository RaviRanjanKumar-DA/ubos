// Visual automation flows: a trigger, then steps drawn top to bottom. An "if" step splits into a Yes path and a No path;
// each path carries on to its own end. Waits pause a lead in the flow for hours or days.
import { AUTOMATION_ACTIONS, type RuleCondition } from './automation';

export interface FlowAction { type: string; userId?: string; stageId?: string; status?: string; labelId?: string; title?: string; dueHours?: number; text?: string; templateId?: string; sequenceId?: string; apiTemplateId?: string }
export type FlowNode =
  | { id: string; type: 'action'; action: FlowAction }
  | { id: string; type: 'wait'; hours: number }
  | { id: string; type: 'condition'; conditions: RuleCondition[]; yes: FlowNode[]; no: FlowNode[] };
export interface FlowGraph { steps: FlowNode[] }

export const FLOW_LIMITS = { nodes: 60, depth: 6, waitHoursMin: 0.25, waitHoursMax: 2160 };
const REQUIRED: Record<string, keyof FlowAction> = { change_stage: 'stageId', set_status: 'status', add_label: 'labelId', create_task: 'title', add_remark: 'text', send_template: 'templateId', notify_owner: 'text', enroll_sequence: 'sequenceId', call_api: 'apiTemplateId' };

interface Place { node: FlowNode; list: FlowNode[]; index: number; parent: Place | null; branch: 'yes' | 'no' | null }

/** Every step by id, with the list it sits in and the "if" step (and path) it hangs under. */
export function locate(g: FlowGraph) {
  const map = new Map<string, Place>();
  const walk = (list: FlowNode[], parent: Place | null, branch: 'yes' | 'no' | null) => {
    list.forEach((node, index) => {
      const p: Place = { node, list, index, parent, branch };
      map.set(node.id, p);
      if (node.type === 'condition') { walk(node.yes, p, 'yes'); walk(node.no, p, 'no'); }
    });
  };
  walk(g.steps, null, null);
  return map;
}

export const firstStep = (g: FlowGraph) => g.steps[0]?.id ?? null;

/** The step after `id`: for an "if" step, the first step of the path taken; otherwise the next step in the same list (null = the end). */
export function nextStep(g: FlowGraph, id: string, branch?: boolean): string | null {
  const p = locate(g).get(id);
  if (!p) return null;
  if (p.node.type === 'condition') return (branch ? p.node.yes : p.node.no)[0]?.id ?? null;
  return p.list[p.index + 1]?.id ?? null;
}

export function countSteps(steps: FlowNode[]): number {
  return steps.reduce((n, s) => n + 1 + (s.type === 'condition' ? countSteps(s.yes) + countSteps(s.no) : 0), 0);
}

/** Problems that stop a flow being saved, in plain words. Empty when it is fine. */
export function validateFlow(g: FlowGraph): string[] {
  const errors: string[] = [];
  const ids = new Set<string>();
  if (!g || !Array.isArray(g.steps)) return ['The flow is empty'];
  if (!g.steps.length) errors.push('Add at least one step');
  if (countSteps(g.steps) > FLOW_LIMITS.nodes) errors.push(`A flow can have at most ${FLOW_LIMITS.nodes} steps`);
  const walk = (list: FlowNode[], depth: number) => {
    if (depth > FLOW_LIMITS.depth) { errors.push(`"If" steps can be nested at most ${FLOW_LIMITS.depth} deep`); return; }
    list.forEach((s, i) => {
      if (!s || typeof s.id !== 'string' || !/^[a-zA-Z0-9_-]{1,40}$/.test(s.id)) { errors.push('A step has a bad id'); return; }
      if (ids.has(s.id)) errors.push('Two steps share an id');
      ids.add(s.id);
      if (s.type === 'action') {
        const t = s.action?.type;
        if (!t || !(t in AUTOMATION_ACTIONS)) errors.push('Choose what an action step does');
        else { const need = REQUIRED[t]; if (need && (s.action[need] === undefined || s.action[need] === '')) errors.push(`Complete the “${AUTOMATION_ACTIONS[t as keyof typeof AUTOMATION_ACTIONS]}” step`); }
      } else if (s.type === 'wait') {
        if (!(typeof s.hours === 'number' && s.hours >= FLOW_LIMITS.waitHoursMin && s.hours <= FLOW_LIMITS.waitHoursMax)) errors.push('A wait must be between 15 minutes and 90 days');
      } else if (s.type === 'condition') {
        if (!Array.isArray(s.conditions) || !s.conditions.length) errors.push('An "if" step needs at least one condition');
        if (i !== list.length - 1) errors.push('An "if" step must be the last step of its path; put the next steps inside Yes or No');
        walk(Array.isArray(s.yes) ? s.yes : [], depth + 1);
        walk(Array.isArray(s.no) ? s.no : [], depth + 1);
      } else errors.push('Unknown step type');
    });
  };
  walk(g.steps, 1);
  return [...new Set(errors)];
}

/** A rule ("when, if, then") drawn as a flow: its conditions become one "if" step whose Yes path holds the actions. */
export function flowFromRule(rule: { conditions: RuleCondition[]; actions: FlowAction[] }, makeId: () => string): FlowGraph {
  const actions: FlowNode[] = rule.actions.map((a) => ({ id: makeId(), type: 'action', action: a }));
  return { steps: rule.conditions.length ? [{ id: makeId(), type: 'condition', conditions: rule.conditions, yes: actions, no: [] }] : actions };
}
