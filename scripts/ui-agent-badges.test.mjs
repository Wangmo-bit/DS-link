// Agent badges: attribution to the right turn, dedupe by agent label, and the
// state fold from the Host's own facts. The rules come from the user's
// 2026-11-07 decisions: colour per state, no placeholder when a turn dispatched
// nothing, cancelled/unknown is muted rather than "failed".
import test from 'node:test';
import assert from 'node:assert/strict';
import { AGENT_STATE, agentBadges, agentState, agentsByTurn, turnWindows } from '../src/client/native-flow-plan.mjs';

const node = (turn, start, end, status = 'closed') => ({ kind: 'assistant-step', location: { kind: 'turn', turn: {
  turn, status, start: start === undefined ? undefined : { time: start }, end: end === undefined ? undefined : { time: end },
} } });

test('turn windows come from the transcript and keep an open turn open-ended', () => {
  const nodes = new Map([
    ['a', node(1, 100, 200)],
    ['b', node(2, 300, undefined, 'open')],
    ['c', node(3, 500, 600)],
  ]);
  assert.deepEqual(turnWindows(nodes), [
    { turn: 1, from: 100, to: 200 },
    { turn: 2, from: 300, to: Infinity },
    { turn: 3, from: 500, to: 600 },
  ]);
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
});

test('a child without a label still counts as one agent', () => {
  const agents = agentsByTurn([{ id: 'x', createdAt: 100 }], [{ turn: 1, from: 100, to: 200 }]).get(1);
  assert.deepEqual(agents, [{ label: '子智能体', id: 'x', count: 1 }]);
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
