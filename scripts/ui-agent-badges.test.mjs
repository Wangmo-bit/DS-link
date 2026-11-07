// Agent badges: attribution to the right turn, dedupe by agent label, and the
// state fold from the Host's own facts. The rules come from the user's
// 2026-11-07 decisions: colour per state, no placeholder when a turn dispatched
// nothing, cancelled/unknown is muted rather than "failed".
import test from 'node:test';
import assert from 'node:assert/strict';
import { AGENT_STATE, agentBadges, agentState, agentStateOf, agentsByTurn, turnWindows, turnWindowSignature } from '../src/client/native-flow-plan.mjs';

const turn = (number, start, end, status = 'closed') => ({
  turn: number, status, start: start === undefined ? undefined : { time: start }, end: end === undefined ? undefined : { time: end },
});

test('turn windows come from the published timeline and truncate stale open turns', () => {
  const timeline = { turns: new Map([
    [1, turn(1, 100, 200)],
    [2, turn(2, 300, undefined, 'open')],
    [3, turn(3, 500, 600)],
  ]) };
  // turn 2 is open and is followed by turn 3, so it ends where turn 3 begins; a
  // crash-orphaned turn must not swallow every later dispatch.
  assert.deepEqual(turnWindows(turnWindowSignature(timeline)), [
    { turn: 1, from: 100, to: 200 },
    { turn: 2, from: 300, to: 499 },
    { turn: 3, from: 500, to: 600 },
  ]);
});

test('boundary signature changes only when attribution facts change', () => {
  const state = value => ({ turns: new Map([[7, value]]) });
  const before = turn(7, 100, undefined, 'open');
  const sameBoundaries = { ...before, steps: [{ step: 1 }] };
  const ended = turn(7, 100, 200, 'closed');
  assert.equal(turnWindowSignature(state(before)), turnWindowSignature(state(sameBoundaries)));
  assert.notEqual(turnWindowSignature(state(before)), turnWindowSignature(state(ended)));
  assert.deepEqual(turnWindows(turnWindowSignature(undefined)), []);
});

test('a dispatch is attributed to the turn that was open when it started', () => {
  const windows = [{ turn: 1, from: 100, to: 200 }, { turn: 2, from: 300, to: Infinity }];
  const catalog = [
    { id: 'a', createdAt: 150, label: '冷审' },
    { id: 'b', createdAt: 350, label: '开发' },
    { id: 'c', createdAt: 50, label: '孤儿' },        // before any turn: dropped, never guessed
  ];
  const byTurn = agentsByTurn(catalog, windows);
  assert.deepEqual(byTurn.get(1)?.map(agent => agent.label), ['冷审']);
  assert.deepEqual(byTurn.get(2)?.map(agent => agent.label), ['开发']);
  assert.equal(byTurn.size, 2, 'unattributable entries are dropped, not assigned to a guess');
});

test('the same agent dispatched repeatedly in one turn is still one agent', () => {
  const windows = [{ turn: 7, from: 100, to: 900 }];
  const catalog = [
    { id: 'a1', createdAt: 120, label: '开发' },
    { id: 'a2', createdAt: 300, label: '开发' },
    { id: 'a3', createdAt: 500, label: '开发' },
    { id: 'b1', createdAt: 600, label: '冷审' },
  ];
  const agents = agentsByTurn(catalog, windows).get(7);
  assert.equal(agents.length, 2, '100 dispatches of one agent collapse to one badge');
  assert.deepEqual(agents.map(agent => agent.label).sort(), ['冷审', '开发']);
  // Every instance id must survive dedupe: otherwise the third run's failure is lost.
  assert.deepEqual(agents.find(agent => agent.label === '开发').ids, ['a1', 'a2', 'a3']);
});

test('a failing instance of a repeated agent is not hidden by an earlier success', () => {
  // Real case from this session (turn 281): probe ran three times; the third
  // ended with an error. Keeping only the first instance would have shown green.
  const windows = [{ turn: 281, from: 100, to: 900 }];
  const catalog = [
    { id: 'p1', createdAt: 120, label: '摸底' },
    { id: 'p2', createdAt: 300, label: '摸底' },
    { id: 'p3', createdAt: 500, label: '摸底' },
  ];
  const [agent] = agentsByTurn(catalog, windows).get(281);
  const facts = { p1: { lastTurnCompleted: true }, p2: { lastTurnCompleted: true }, p3: { lastTurnCompleted: false } };
  assert.equal(agentStateOf(agent.ids.map(id => facts[id])), 'idle', 'one unfinished instance must not read as all done');
  assert.equal(agentStateOf([{ lastTurnCompleted: true }, { lastTurnCompleted: true }]), 'done');
  assert.equal(agentStateOf([{ lastTurnCompleted: true }, { running: true }]), 'running');
  assert.equal(agentStateOf([]), 'idle');
});

test('a child without a label still counts as one agent', () => {
  const agents = agentsByTurn([{ id: 'x', createdAt: 100 }], [{ turn: 1, from: 100, to: 200 }]).get(1);
  assert.deepEqual(agents, [{ label: '子智能体', ids: ['x'], count: 1 }]);
});

test('state folds from running then the latest-turn outcome', () => {
  assert.equal(agentState({ running: true }), AGENT_STATE.running);
  assert.equal(agentState({ running: false, lastTurnCompleted: true }), AGENT_STATE.done);
  // Cancelled / interrupted / unknown all land here: the Host folds them the same
  // way, and calling a user-cancelled agent "failed" would be a lie.
  assert.equal(agentState({ running: false, lastTurnCompleted: false }), AGENT_STATE.idle);
  assert.equal(agentState({ running: false }), AGENT_STATE.idle);
  assert.equal(agentState({}), AGENT_STATE.idle);
  assert.equal(agentState({ running: false, lastTurnCompleted: false, failed: true }), AGENT_STATE.failed);
});

test('badges group by state with the live state first', () => {
  const badges = agentBadges([
    { label: 'a', state: 'done' }, { label: 'b', state: 'running' },
    { label: 'c', state: 'done' }, { label: 'd', state: 'idle' },
  ]);
  assert.deepEqual(badges, [
    { state: 'running', count: 1 },
    { state: 'done', count: 2 },
    { state: 'idle', count: 1 },
  ]);
});

test('a turn with no agents yields no badges so nothing is rendered', () => {
  assert.deepEqual(agentBadges([]), []);
  assert.deepEqual(agentBadges(undefined), []);
  assert.equal(agentsByTurn([], [{ turn: 1, from: 0, to: 10 }]).size, 0);
  assert.equal(agentsByTurn([{ id: 'a', createdAt: 5, label: 'x' }], []).size, 0);
});
