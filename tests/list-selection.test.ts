import { describe, expect, test } from 'bun:test';
import { selectListItem } from '../src/lib/list-selection';
import { operatorGroups } from '../src/lib/operator-queue-view';
import type { Job } from '../src/lib/shared';

describe('list selection', () => {
  const order = ['d', 'b', 'a', 'c'];
  test('plain clicks replace a selection; Ctrl and Cmd toggle individual items', () => {
    expect([...selectListItem(order, new Set(['b']), 'b', 'a').selected]).toEqual(['a']);
    const added = selectListItem(order, new Set(['b']), 'b', 'a', { ctrlKey: true });
    expect([...added.selected]).toEqual(['b', 'a']);
    expect([...selectListItem(order, added.selected, added.anchor, 'b', { metaKey: true }).selected]).toEqual(['a']);
  });
  test('Shift follows visible order in both directions and retains the range anchor', () => {
    const range = selectListItem(order, new Set(['c']), 'b', 'c', { shiftKey: true });
    expect([...range.selected]).toEqual(['b', 'a', 'c']);
    expect(range.anchor).toBe('b');
    expect([...selectListItem(order, range.selected, range.anchor, 'd', { shiftKey: true }).selected]).toEqual(['d', 'b']);
  });
  test('Ctrl+Shift preserves selections outside the range; checkbox clicks toggle', () => {
    expect([...selectListItem(order, new Set(['d']), 'a', 'c', { ctrlKey: true, shiftKey: true }).selected]).toEqual(['d', 'a', 'c']);
    expect([...selectListItem(order, new Set(['b', 'a']), 'b', 'a', {}, true).selected]).toEqual(['b']);
  });
  test('stale anchors fall back to selecting the clicked item; invalid targets leave selection intact', () => {
    expect([...selectListItem(order, new Set(['b']), 'removed', 'a', { shiftKey: true }).selected]).toEqual(['a']);
    expect([...selectListItem(order, new Set(['b']), 'b', 'removed').selected]).toEqual(['b']);
  });
});

const job = (id: string, overrides: Partial<Job> = {}): Job => ({
  id, title: id, status: 'queued', created_at: 10, queued_at: 10, confirmed_at: 10,
  email: 'maker@purdue.edu', material: 'PLA', color: 'black', copies: 1,
  ...overrides,
} as Job);

describe('operator queue views', () => {
  test('same-titled submissions remain separate and identify both submissions', () => {
    const groups = operatorGroups([
      job('a', { batch_id: 'first-id', batch_title: 'Robot' }),
      job('b', { batch_id: 'second-id', batch_title: 'Robot' }),
      job('c', { batch_id: 'first-id', batch_title: 'Robot' }),
    ], 'batch', 'queue');
    expect(groups).toHaveLength(2);
    expect(groups[0].jobs.map(item => item.id)).toEqual(['a', 'c']);
    expect(groups.map(group => group.title)).toEqual(['Robot · #FIRST-ID', 'Robot · #SECOND-I']);
  });
  test('named groups and ungrouped prints never collide, including a group named ungrouped', () => {
    const groups = operatorGroups([job('a', { group_name: 'ungrouped' }), job('b')], 'custom', 'queue');
    expect(groups).toHaveLength(2);
    expect(groups[0].jobs[0].id).toBe('a');
    expect(groups[1].title).toBe('Ungrouped');
  });
  test('natural name sort and reversed copies sort work within filament groups', () => {
    const jobs = [job('a', { title: 'Part 10', copies: 1 }), job('b', { title: 'Part 2', copies: 4 }), job('c', { title: 'Part 1', color: 'red' })];
    expect(operatorGroups(jobs, 'material-color', 'title')[0].jobs.map(item => item.id)).toEqual(['b', 'a']);
    expect(operatorGroups(jobs, 'material-color', 'copies', true)[0].jobs.map(item => item.id)).toEqual(['a', 'b']);
  });
  test('date direction reverses dates while equal dates retain queue order', () => {
    const jobs = [job('a', { created_at: 20, queued_at: 3 }), job('b', { created_at: 20, queued_at: 1 }), job('c', { created_at: 5 })];
    expect(operatorGroups(jobs, 'none', 'newest')[0].jobs.map(item => item.id)).toEqual(['b', 'a', 'c']);
    expect(operatorGroups(jobs, 'none', 'newest', true)[0].jobs.map(item => item.id)).toEqual(['c', 'b', 'a']);
    expect(operatorGroups(jobs, 'none', 'queue', true)[0].jobs.map(item => item.id)).toEqual(['b', 'a', 'c']);
  });
});
