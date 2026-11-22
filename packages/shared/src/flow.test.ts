import { describe, expect, it } from 'vitest';
import { countSteps, firstStep, flowFromRule, nextStep, validateFlow, type FlowGraph } from './flow';

const g: FlowGraph = {
  steps: [
    { id: 'a', type: 'action', action: { type: 'add_remark', text: 'Hi {name}' } },
    { id: 'w', type: 'wait', hours: 24 },
    { id: 'c', type: 'condition', conditions: [{ field: 'source', op: 'eq', value: 'website' }], yes: [{ id: 'y1', type: 'action', action: { type: 'create_task', title: 'Call' } }, { id: 'y2', type: 'wait', hours: 2 }], no: [] },
  ],
};

describe('flows', () => {
  it('walks steps, waits and paths', () => {
    expect(firstStep(g)).toBe('a');
    expect(nextStep(g, 'a')).toBe('w');
    expect(nextStep(g, 'w')).toBe('c');
    expect(nextStep(g, 'c', true)).toBe('y1');
    expect(nextStep(g, 'c', false)).toBe(null);
    expect(nextStep(g, 'y1')).toBe('y2');
    expect(nextStep(g, 'y2')).toBe(null);
    expect(nextStep(g, 'gone')).toBe(null);
    expect(countSteps(g.steps)).toBe(5);
  });
  it('accepts a good flow', () => {
    expect(validateFlow(g)).toEqual([]);
  });
  it('explains what is wrong', () => {
    expect(validateFlow({ steps: [] })).toContain('Add at least one step');
    expect(validateFlow({ steps: [{ id: 'x', type: 'action', action: { type: 'create_task' } }] })[0]).toMatch(/Complete/);
    expect(validateFlow({ steps: [{ id: 'x', type: 'wait', hours: 0 }] })[0]).toMatch(/15 minutes/);
    expect(validateFlow({ steps: [{ id: 'c', type: 'condition', conditions: [], yes: [], no: [] }] })[0]).toMatch(/condition/);
    const notLast: FlowGraph = { steps: [{ id: 'c', type: 'condition', conditions: [{ field: 'source', op: 'empty' }], yes: [], no: [] }, { id: 'a', type: 'wait', hours: 1 }] };
    expect(validateFlow(notLast).join()).toMatch(/last step/);
    expect(validateFlow({ steps: [{ id: 'a', type: 'wait', hours: 1 }, { id: 'a', type: 'wait', hours: 1 }] })).toContain('Two steps share an id');
  });
  it('limits nesting', () => {
    let inner: FlowGraph['steps'] = [{ id: 'z', type: 'wait', hours: 1 }];
    for (let i = 0; i < 7; i++) inner = [{ id: `c${i}`, type: 'condition', conditions: [{ field: 'source', op: 'empty' }], yes: inner, no: [] }];
    expect(validateFlow({ steps: inner }).join()).toMatch(/nested/);
  });
  it('draws a rule as a flow', () => {
    let n = 0;
    const id = () => `s${++n}`;
    expect(flowFromRule({ conditions: [], actions: [{ type: 'add_remark', text: 'x' }] }, id)).toEqual({ steps: [{ id: 's1', type: 'action', action: { type: 'add_remark', text: 'x' } }] });
    const f = flowFromRule({ conditions: [{ field: 'source', op: 'eq', value: 'website' }], actions: [{ type: 'add_remark', text: 'x' }] }, id);
    expect(f.steps[0].type).toBe('condition');
    expect(validateFlow(f)).toEqual([]);
  });
});
