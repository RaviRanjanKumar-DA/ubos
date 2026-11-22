import type { FlowNode } from '@ubos/shared';

/** Where a new step goes: a list (top level, or an "if" step's Yes / No path) and a position in it. */
export interface Slot { parentId: string | null; branch: 'yes' | 'no' | null; index: number }

export const newId = () => Math.random().toString(36).slice(2, 10);

const listOf = (steps: FlowNode[], parentId: string | null, branch: 'yes' | 'no' | null): FlowNode[] | null => {
  if (!parentId) return steps;
  for (const s of steps) {
    if (s.type !== 'condition') continue;
    if (s.id === parentId) return branch === 'no' ? s.no : s.yes;
    const inner = listOf(s.yes, parentId, branch) ?? listOf(s.no, parentId, branch);
    if (inner) return inner;
  }
  return null;
};
const clone = (steps: FlowNode[]): FlowNode[] => JSON.parse(JSON.stringify(steps));

/** Inserts a step. An "if" step must end its path, so the steps that followed move into its Yes path. */
export function insertStep(steps: FlowNode[], slot: Slot, node: FlowNode): FlowNode[] {
  const out = clone(steps);
  const list = listOf(out, slot.parentId, slot.branch);
  if (!list) return out;
  if (node.type === 'condition') {
    const rest = list.splice(slot.index);
    node.yes = [...node.yes, ...rest];
    list.push(node);
  } else list.splice(slot.index, 0, node);
  return out;
}

export function updateStep(steps: FlowNode[], id: string, next: FlowNode): FlowNode[] {
  const walk = (list: FlowNode[]): FlowNode[] => list.map((s) => (s.id === id ? next : s.type === 'condition' ? { ...s, yes: walk(s.yes), no: walk(s.no) } : s));
  return walk(clone(steps));
}

/** Removes a step; removing an "if" step keeps its Yes path in its place and drops the No path. */
export function removeStep(steps: FlowNode[], id: string): FlowNode[] {
  const walk = (list: FlowNode[]): FlowNode[] => list.flatMap((s) => (s.id === id ? (s.type === 'condition' ? s.yes : []) : s.type === 'condition' ? [{ ...s, yes: walk(s.yes), no: walk(s.no) }] : [s]));
  return walk(clone(steps));
}

export function findStep(steps: FlowNode[], id: string): FlowNode | null {
  for (const s of steps) {
    if (s.id === id) return s;
    if (s.type === 'condition') { const f = findStep(s.yes, id) ?? findStep(s.no, id); if (f) return f; }
  }
  return null;
}

export const waitLabel = (h: number) => (h >= 24 && h % 24 === 0 ? `${h / 24} ${h === 24 ? 'day' : 'days'}` : h < 1 ? `${Math.round(h * 60)} minutes` : `${h} ${h === 1 ? 'hour' : 'hours'}`);

const contains = (n: FlowNode, id: string): boolean => n.id === id || (n.type === 'condition' && [...n.yes, ...n.no].some((c) => contains(c, id)));

/** Where a step sits now, as a slot (its list and position). */
export function slotOf(steps: FlowNode[], id: string, parentId: string | null = null, branch: 'yes' | 'no' | null = null): Slot | null {
  for (let i = 0; i < steps.length; i++) {
    const s = steps[i];
    if (s.id === id) return { parentId, branch, index: i };
    if (s.type === 'condition') { const f = slotOf(s.yes, id, s.id, 'yes') ?? slotOf(s.no, id, s.id, 'no'); if (f) return f; }
  }
  return null;
}

/** Moves a step (with everything under it) to another slot. Dropping an "if" step inside its own paths is refused (null). */
export function moveStep(steps: FlowNode[], id: string, to: Slot): FlowNode[] | null {
  const node = findStep(steps, id);
  const from = slotOf(steps, id);
  if (!node || !from) return null;
  if (to.parentId && contains(node, to.parentId)) return null;
  const sameList = from.parentId === to.parentId && from.branch === to.branch;
  if (sameList && (to.index === from.index || to.index === from.index + 1)) return steps;
  const without = removeExact(steps, id);
  return insertStep(without, sameList && from.index < to.index ? { ...to, index: to.index - 1 } : to, node);
}

/** Removes exactly this step and what hangs under it. */
function removeExact(steps: FlowNode[], id: string): FlowNode[] {
  const walk = (list: FlowNode[]): FlowNode[] => list.filter((s) => s.id !== id).map((s) => (s.type === 'condition' ? { ...s, yes: walk(s.yes), no: walk(s.no) } : s));
  return walk(JSON.parse(JSON.stringify(steps)));
}
