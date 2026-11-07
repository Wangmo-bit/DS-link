// React-owned adapter around the Host's native ChatFlow.
//
// Bubble mode (user decisions, 2026-11-06):
// - One bubble per utterance: body text plus a one-line turn summary. No
//   thinking/tool process is ever rendered inside the bubble.
// - The summary carries elapsed time, thinking count, tool count and the turn's
//   real end state. It updates live
//   while the turn runs and finalises when it ends. No token counts.
// - No empty process bubbles. A text-less segment never becomes a bubble; the
//   turn's last segment only stands alone to carry the summary of a turn that
//   produced no text at all.
// - Internal mechanism rows (model retries) never draw in the timeline.
//
// Card mode is untouched: the adapter hands the native flow straight through.
import React, { useCallback, useEffect, useLayoutEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { MessageBubble, ThinkingDots } from './chat-ui.jsx';
import { formatTurnSummary } from './chat-skin-model.mjs';
import { AGENT_STATE, agentBadges, agentStateOf, agentsByTurn, planNativeFlow, processNeedsInput, teamDispatchSignature, teamRosterSignature, turnWindows, turnWindowSignature } from './native-flow-plan.mjs';
import { useDisplayMode } from './display-mode.mjs';

export const FLOW_SLOT = 'conversation.chat.flow.adapter';
const normalizedPolicies = new WeakMap();
function inlinePolicy(policy) {
  if (!policy || typeof policy !== 'object') return policy;
  let next = normalizedPolicies.get(policy);
  if (!next) { next = {...policy, stepGrouping:'none', foldCompletedTurns:false}; normalizedPolicies.set(policy,next); }
  return next;
}
function statusOf(turn) {
  const reason = turn?.end?.data?.reason?.kind;
  if (reason === 'error') return 'error';
  if (reason === 'aborted' || reason === 'interrupted') return 'interrupted';
  return undefined;
}
function thinkingCountOf(turn) {
  const steps = turn?.steps?.map(step => step.data?.get?.('assistant-step'));
  if (!steps?.length || !steps.every(Boolean)) return undefined;
  return steps.filter(step => step.blocks?.some(block => block.kind === 'reasoning' && block.text?.trim())).length;
}
function clockText(start, now) {
  if (!Number.isFinite(start) || !Number.isFinite(now)) return '';
  const seconds = Math.max(0, Math.floor((now - start) / 1000));
  return seconds >= 60 ? `${Math.floor(seconds / 60)} 分 ${seconds % 60} 秒` : `${seconds} 秒`;
}
// Real elapsed time plus the real counts, while the turn is still open. The
// bubble right below already shows the working dots, so the line does not repeat
// "思考中" — it only reports what the dots cannot: how long and how much.
function runningText({ turn, control, now }) {
  const parts = [];
  const elapsed = clockText(turn?.start?.time, now);
  if (elapsed) parts.push(elapsed);
  const counts = formatTurnSummary({ thinkingCount: thinkingCountOf(turn), toolCount: control?.data?.toolCallCount, status: statusOf(turn) });
  if (counts) parts.push(counts);
  return parts.join(' · ');
}
// Frozen one-liner for a turn that ended.
function endedText({ turn, control }) {
  const elapsedMs = turn?.start && turn?.end ? turn.end.time - turn.start.time : undefined;
  const base = formatTurnSummary({ elapsedMs, thinkingCount: thinkingCountOf(turn), toolCount: control?.data?.toolCallCount, status: statusOf(turn) });
  return base;
}
// Re-renders once a second so a running summary keeps moving, then stops.
function RunningHeading({ turn, control, agents }) {
  const start = turn?.start?.time;
  const [now,setNow] = useState(Date.now);
  useEffect(() => {
    if (!Number.isFinite(start)) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [start]);
  return <span className="sl-chat-summary sl-heading-process" data-sl-running="">{runningText({ turn, control, now })}{agents?.length ? <><span className="sl-summary-divider" aria-hidden="true">·</span><AgentBadges badges={agents}/></> : null}</span>;
}
function SummaryHeading({ turn, control, running, agents }) {
  return running ? <RunningHeading turn={turn} control={control} agents={agents}/> : <EndedHeading turn={turn} control={control} agents={agents}/>;
}
function EndedHeading({ turn, control, agents }) {
  const text = endedText({ turn, control });
  if (!text && !agents?.length) return null;
  return <span className="sl-chat-summary sl-heading-process">{text}{agents?.length ? <>{text ? <span className="sl-summary-divider" aria-hidden="true">·</span> : null}<AgentBadges badges={agents}/></> : null}</span>;
}
// One inline SVG per state. The silhouette is the same for every state; only the
// colour changes, so a glance reads "how many are still working" without having
// to parse labels.
const AGENT_GLYPH = 'M2.9 13.3c0-2.45 2.25-4 5.1-4s5.1 1.55 5.1 4';
function AgentIcon({ state }) {
  return <svg className={`sl-agent-icon sl-agent-icon--${state}`} width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.45" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
    <circle cx="8" cy="4.7" r="2.55"/>
    <path d={AGENT_GLYPH}/>
  </svg>;
}
const AGENT_STATE_LABEL = { running: '运行中', done: '已完成', failed: '失败', idle: '未确认' };
// A turn with no dispatched agent renders nothing at all — no placeholder.
function AgentBadges({ badges }) {
  if (!badges?.length) return null;
  const total = badges.reduce((sum, badge) => sum + badge.count, 0);
  const spoken = badges.map(badge => `${AGENT_STATE_LABEL[badge.state]} ${badge.count} 个`).join('，');
  // One agent needs no count: the single icon already says "one", and the spoken
  // form drops the count too so it matches what is on screen.
  if (total === 1) {
    const only = badges[0];
    const single = `本轮 1 个 agent，${AGENT_STATE_LABEL[only.state]}`;
    return <span className="sl-agent-badges" data-sl-agent-badges="" role="img" aria-label={single} title={single}>
      <AgentIcon state={only.state}/>
    </span>;
  }
  return <span className="sl-agent-badges" data-sl-agent-badges="" role="img" aria-label={`本轮 ${total} 个 agent，${spoken}`} title={`本轮 ${total} 个 agent，${spoken}`}>
    {badges.map(badge => <span className="sl-agent-badge" key={badge.state} data-state={badge.state}>
      <AgentIcon state={badge.state}/><span className="sl-agent-count">{badge.count}</span>
    </span>)}
  </span>;
}
// Subscribes to real process state only to classify it; nothing it reads is
// rendered. Both selectors return primitives so the Host snapshot stays stable.
function AttentionNode({ member, useChatNode, report }) {
  const needsInput = useChatNode(member.key, processNeedsInput) === true;
  useEffect(() => {
    report(member.key, needsInput);
    return () => report(member.key, false);
  }, [member.key, needsInput, report]);
  return null;
}
// Host group members are `{kind:'node', key, groupPart?}`; the tool filter lives
// inside processNeedsInput, which inspects the resolved node.
function AttentionGroup({ groupKey, useChatGroup, useChatNode, report }) {
  const members = useChatGroup(groupKey, group => group?.members) ?? [];
  return members.map(member =>
    <AttentionNode key={`${member.key}:${member.groupPart ?? ''}`} member={member} useChatNode={useChatNode} report={report}/>);
}
// The only per-turn signal bubble mode still reports is a prompt that is waiting
// on the user. A tool that failed mid-turn is not reported: the turn's own result
// is the answer, and printing every recoverable tool failure was judged noise
// (user decision 2026-11-06). Turn-level failures still show as 执行失败/已停止.
function TurnAttention({ turn, groups, flow, onReport }) {
  const [pendingKeys,setPending] = useState(() => new Set());
  const report = useCallback((key, needsInput) => {
    setPending(previous => {
      if (previous.has(key) === needsInput) return previous;
      const next = new Set(previous);
      if (needsInput) next.add(key); else next.delete(key);
      return next;
    });
  }, []);
  const needsInput = pendingKeys.size > 0;
  useEffect(() => { onReport(turn, needsInput); }, [turn, needsInput, onReport]);
  return groups.filter(group => group.kind === 'group').map(group =>
    <AttentionGroup key={group.key} groupKey={group.key} useChatGroup={flow.useChatGroup} useChatNode={flow.useChatNode} report={report}/>);
}
// Observe only this turn's tool-call data, including hidden tool rows. A Team
// send contributes only after the Host records a successful acknowledgement.
const EMPTY_TEAM_TOOLS = Object.freeze([]);
const EMPTY_TEAM_SOURCE = Object.freeze({ subscribe: () => () => {}, getSnapshot: () => EMPTY_TEAM_TOOLS });
const teamTurnKey = (sessionId, turn) => JSON.stringify([sessionId, turn]);
function TeamDispatchProbe({ sessionId, turn, nodes, onReport }) {
  const source = useMemo(() => nodes?.turnDataSource?.(turn, 'tool-call') ?? EMPTY_TEAM_SOURCE, [nodes, turn]);
  const rows = useSyncExternalStore(source.subscribe, source.getSnapshot, source.getSnapshot);
  const signature = teamDispatchSignature(rows);
  // Publish before paint, so an earlier successful child turn is not briefly
  // mistaken for completion of a later Team message on history reload.
  useLayoutEffect(() => { onReport(sessionId, turn, signature); }, [sessionId, turn, signature, onReport]);
  useEffect(() => () => { onReport(sessionId, turn, null); }, [sessionId, turn, onReport]);
  return null;
}
const EMPTY_INPUTS = Object.freeze([]), SINGLETONS = new WeakMap();
function singleton(entry) { let value = SINGLETONS.get(entry); if (!value) { value = [entry]; SINGLETONS.set(entry, value); } return value; }
function entryKey(entry) { return JSON.stringify([entry.kind,entry.key,entry.groupPart ?? null]); }
function NoRunningFlow({ NativeFlow, flow, entries, pendingInputs = EMPTY_INPUTS, usePresentation }) {
  return <NativeFlow {...flow} entries={entries} pendingInputs={pendingInputs} usePresentation={usePresentation ?? flow.usePresentation} slSuppressRunning/>;
}
// Keeps a node key resolvable for navigation without drawing a visible row.
function AnchorOnly({ entry }) {
  return <span className="sl-native-anchor" aria-hidden="true" data-chat-node-key={entry.key} data-chat-anchor-key={`sl-flow-node:${entry.key}`}/>;
}
// A process segment plus its own response. Segments are grouped by the Host, so
// the text that finishes a turn may arrive in a later segment: `turnHasText`
// keeps earlier text-less segments from drawing an empty bubble.
function MessageSurface({ plan, flow, NativeFlow, author, inlinePresentation, turnHasText, carrySummary, attention, agents }) {
  const firstEntry = plan.groups[0], groupKey = firstEntry?.kind === 'group' ? firstEntry.key : '';
  const groupTurn = flow.useChatGroup(groupKey, group => group?.data.turn);
  const memberKey = flow.useChatGroup(groupKey, group => group?.members?.[0]?.key);
  const firstKey = firstEntry?.kind === 'node' ? firstEntry.key : memberKey ?? '';
  const groupNode = flow.useChatNode(firstKey);
  const responseNode = flow.useChatNode(plan.response?.key ?? '');
  const controlNode = flow.useChatNode(plan.control?.key ?? '');
  // A different or missing group is never attributed to a guessed turn.
  if (plan.groups.length && groupTurn !== undefined && groupTurn !== plan.turn) {
    return <><NoRunningFlow NativeFlow={NativeFlow} flow={flow} entries={plan.groups}/>{plan.response && <NoRunningFlow NativeFlow={NativeFlow} flow={flow} entries={singleton(plan.response)}/>}</>;
  }
  const turn = responseNode?.location?.turn ?? groupNode?.location?.turn ?? controlNode?.location?.turn;
  const running = turn?.status === 'open';
  const hasText = Boolean(plan.response);
  // The live bubble of the running turn shows the dots even before its text
  // lands. A finished turn only keeps a text-less final segment when the whole
  // turn produced no text, so its summary is not lost.
  const live = running && plan.last;
  const statsOnly = !running && plan.last && !turnHasText;
  if (!hasText && !live && !statsOnly) return null;
  // A rendered article must hold something. When another bubble of the same turn
  // already carries the statistics, a text-less shell would show only the author
  // name, which is exactly the empty block users were seeing.
  const attentionLine = carrySummary && attention.needsInput;
  // While running, the moving line belongs to the live bubble only; the frozen
  // statistics belong to the turn's carrier bubble once it ends.
  const runningLine = running && live;
  const endedLine = !running && carrySummary && (endedText({ turn, control: controlNode }) !== '' || Boolean(agents?.length));
  if (!hasText && !runningLine && !attentionLine && !endedLine) return null;
  const key = plan.response?.key ?? plan.groups[0]?.key;
  return <div data-sl-native-message="" data-chat-turn={plan.turn} data-chat-flow-key={key} data-chat-anchor-key={`sl-native:${key}`} data-chat-paging-anchor="">
    {plan.first && plan.control && <span className="sl-native-anchor" aria-hidden="true" data-chat-node-key={plan.control.key} data-chat-anchor-key={`sl-control-node:${plan.control.key}`}/>}
    {firstKey && <span className="sl-native-anchor" aria-hidden="true" data-chat-node-key={firstKey} data-chat-anchor-key={`sl-process-node:${firstKey}`}/>}
    <MessageBubble author={author} bodyless={!hasText && !runningLine && !attentionLine} heading={runningLine
      ? <RunningHeading turn={turn} control={controlNode} agents={agents}/>
      : endedLine ? <EndedHeading turn={turn} control={controlNode} agents={agents}/> : null}>
      {attentionLine && <p className="sl-bubble-attention" role="status">有需要你操作的事项</p>}
      {hasText
        ? <NoRunningFlow NativeFlow={NativeFlow} flow={flow} entries={singleton(plan.response)} usePresentation={inlinePresentation}/>
        : runningLine ? <ThinkingDots/> : null}
    </MessageBubble>
  </div>;
}
// A turn whose loaded window holds no other material: the live bubble while it
// runs, or a statistics-only bubble once it ended without producing text.
function ControlSurface({ plan, flow, NativeFlow, author, carrySummary, attention, agents }) {
  const node = flow.useChatNode(plan.entry.key);
  if (!node) return <NoRunningFlow NativeFlow={NativeFlow} flow={flow} entries={singleton(plan.entry)}/>;
  const turn = node.location?.turn;
  const running = turn?.status === 'open';
  const attentionLine = carrySummary && attention.needsInput;
  const runningLine = running && carrySummary;
  const endedLine = !running && carrySummary && (endedText({ turn, control: node }) !== '' || Boolean(agents?.length));
  if (!runningLine && !attentionLine && !endedLine) return null;
  return <div data-chat-turn={plan.turn} data-chat-flow-kind="turn-process" data-chat-node-key={plan.entry.key} data-chat-flow-key={plan.entry.key} data-chat-anchor-key={`sl-control:${plan.entry.key}`}>
    <MessageBubble author={author} bodyless={!runningLine && !attentionLine} heading={runningLine
      ? <RunningHeading turn={turn} control={node} agents={agents}/>
      : endedLine ? <EndedHeading turn={turn} control={node} agents={agents}/> : null}>
      {attentionLine && <p className="sl-bubble-attention" role="status">有需要你操作的事项</p>}
      {runningLine ? <ThinkingDots/> : null}
    </MessageBubble>
  </div>;
}
// Rows that describe an internal mechanism rather than the conversation. They
// keep an invisible anchor so paging and navigation still resolve, but never draw
// a fragment between bubbles (user decision 2026-11-06: "要么进气泡，要么不要出现").
// Only mechanism plumbing is silenced. Rows that carry real user-visible
// information keep rendering natively: `turn-error` / `turn-max-tokens` report a
// terminal failure the bubble does not reproduce, `manual-compaction` is a command
// the user issued, and `context` is injected content.
const SILENT_ROWS = new Set(['model-retry', 'turn-tail', 'turn-trigger']);
function BubbleFlow({ NativeFlow, ...flow }) {
  const nodes = flow.useChat(snapshot => snapshot.nodes);
  // `nodes` is a stable live reader, not an immutable value. Subscribe to the
  // actual timeline boundaries so agent attribution updates when turns load,
  // close, or are prepended, even if the reader's identity never changes.
  const turnSignature = flow.useChat(snapshot => turnWindowSignature(snapshot.timeline));
  const session = flow.useSessions(snapshot => snapshot?.byId?.[flow.sessionId]);
  // Agent badges need the parent's catalog plus every child's status, which all
  // live in the same list snapshot. The selector returns one primitive signature
  // so the flow re-renders only when an agent appears or changes state — not on
  // every unrelated list rebuild.
  const agentSignature = flow.useSessions(snapshot => {
    const catalog = snapshot?.projectionsBySession?.[flow.sessionId]?.values?.subagentCatalog;
    if (!Array.isArray(catalog) || !catalog.length) return '';
    const byId = snapshot?.byId ?? {};
    return catalog.map(entry => {
      const child = byId[entry?.id];
      return [entry?.id ?? '', entry?.label ?? '', entry?.createdAt ?? '',
        child?.running === true ? 'r' : '',
        child?.projectionValues?.subagentTiming?.lastTurnCompleted === true ? 'c' : '',
        child?.projectionValues?.subagentTiming?.lastTurnCompleted === false ? 'f' : ''].join('\u0000');
    }).join('\u0001');
  });
  const teamSignature = flow.useSessions(snapshot => teamRosterSignature(snapshot, flow.sessionId));
  const [teamDispatches, setTeamDispatches] = useState(() => new Map());
  const reportTeamDispatches = useCallback((sessionId, turn, signature) => {
    const key = teamTurnKey(sessionId, turn), nextValue = signature && signature !== '[]' ? signature : undefined;
    setTeamDispatches(previous => {
      if (previous.get(key) === nextValue) return previous;
      const next = new Map(previous);
      if (nextValue === undefined) next.delete(key); else next.set(key, nextValue);
      return next;
    });
  }, []);
  const identity = session?.projectionValues?.subagent;
  const author = session?.origin === 'subagent' || identity?.mode ? identity?.label || '子智能体' : session?.title || '助手';
  const plans = useMemo(() => planNativeFlow(flow.entries, nodes), [flow.entries, nodes]);
  // Agent badges: the parent's catalog projection lists every direct child with
  // its creation time and label; each child's own summary carries running and the
  // latest-turn outcome the Host folds (subagentTiming.lastTurnCompleted).
  const agentBadgesByTurn = useMemo(() => {
    const badges = new Map();
    const catalog = agentSignature ? agentSignature.split('\u0001').map(row => {
      const [id, label, createdAt, running, completed, failed] = row.split('\u0000');
      return { id, label: label || undefined, createdAt: Number(createdAt), running: running === 'r', completed: completed === 'c', failed: failed === 'f' };
    }) : [];
    const members = teamSignature ? JSON.parse(teamSignature).map(([id, name, role, phase, running, outcome, activeSince, turnCount]) => ({
      id, name, role, phase, running, activeSince, turnCount, completed: outcome === 'c', failed: outcome === 'f',
    })) : [];
    const byId = new Map([...catalog, ...members].map(entry => [entry.id, entry]));
    const teamIds = new Set(members.map(member => member.id));
    const windows = turnWindows(turnSignature), targetsByTurn = new Map();
    if (!windows.length) return badges;
    for (const window of windows) {
      const signature = teamDispatches.get(teamTurnKey(flow.sessionId, window.turn));
      if (signature) targetsByTurn.set(window.turn, JSON.parse(signature));
    }
    const groups = agentsByTurn(catalog, windows, members, targetsByTurn);
    const windowsByTurn = new Map(windows.map(window => [window.turn, window]));
    const latestTeamTurn = new Map();
    for (const [turn, agents] of groups) {
      const from = windowsByTurn.get(turn)?.from;
      for (const agent of agents) for (const id of agent.ids) {
        if (!teamIds.has(id)) continue;
        const prior = latestTeamTurn.get(id);
        if (!prior || from > prior.from || (from === prior.from && turn > prior.turn)) latestTeamTurn.set(id, { turn, from });
      }
    }
    for (const [turn, agents] of groups) {
      // A Team acknowledgement is not completion. Also, a member working in a
      // later turn must not make its historical bubbles look active or finished.
      const window = windowsByTurn.get(turn);
      const states = agents.map(agent => ({
        label: agent.label,
        state: agentStateOf(agent.ids.map(id => {
          const entry = byId.get(id), sent = agent.sentIds?.includes(id), isTeam = teamIds.has(id);
          const older = isTeam && latestTeamTurn.get(id)?.turn !== turn;
          const activeSince = entry?.activeSince;
          const startedLater = isTeam && entry?.running && Number.isFinite(activeSince) && activeSince > window.to;
          const runningUnproven = isTeam && entry?.running && window.to !== Infinity && !Number.isFinite(activeSince);
          const running = entry?.running === true && !older && !startedLater && !runningUnproven;
          // A newly-created Team member's latest completion only proves this
          // parent turn when the Host outline confirms it had exactly one turn.
          // A later reuse may lie outside the loaded parent-history window.
          const completionUnproven = isTeam && entry?.turnCount !== 1;
          const uncertain = sent || older || startedLater || runningUnproven || completionUnproven;
          return {
            running,
            lastTurnCompleted: uncertain ? undefined : entry?.completed === true ? true : entry?.failed === true ? false : undefined,
          };
        })),
      }));
      badges.set(turn, agentBadges(states));
    }
    return badges;
  }, [agentSignature, teamSignature, turnSignature, teamDispatches, flow.sessionId]);
  // Statistics belong to the turn, not to one segment. Exactly one bubble per
  // turn carries them: the turn's last bubble with text, otherwise its last
  // bubble at all (a turn that produced no text keeps a statistics-only bubble).
  const { turnsWithText, summaryCarrier } = useMemo(() => {
    const text = new Set(), carrier = new Map();
    for (const plan of plans) {
      if (plan.kind !== 'message' && plan.kind !== 'control') continue;
      if (plan.response) { text.add(plan.turn); carrier.set(plan.turn, plan); }
      else if (!carrier.has(plan.turn) || !carrier.get(plan.turn).response) carrier.set(plan.turn, plan);
    }
    return { turnsWithText: text, summaryCarrier: carrier };
  }, [plans]);
  // A pending user prompt is collected once per turn, independent of which
  // segment happens to carry a visible bubble.
  const [pendingTurns,setPendingTurns] = useState(() => new Set());
  const reportAttention = useCallback((turn, needsInput) => {
    setPendingTurns(previous => {
      if (previous.has(turn) === needsInput) return previous;
      const next = new Set(previous);
      if (needsInput) next.add(turn); else next.delete(turn);
      return next;
    });
  }, []);
  const attentionOf = turn => ({ needsInput: pendingTurns.has(turn) });
  const probes = useMemo(() => {
    const seen = new Set(), probes = [];
    for (const plan of plans) {
      if (seen.has(plan.turn)) continue;
      seen.add(plan.turn);
      const groups = plans.filter(candidate => candidate.turn === plan.turn).flatMap(candidate => candidate.groups ?? []);
      probes.push(<TurnAttention key={`attention:${plan.turn}`} turn={plan.turn} groups={groups} flow={flow} onReport={reportAttention}/>);
    }
    return probes;
  }, [plans, reportAttention, flow]);
  const hasTeamMembers = Boolean(teamSignature && teamSignature !== '[]');
  const teamProbes = useMemo(() => {
    if (!hasTeamMembers) return [];
    const turns = new Set(plans.map(plan => plan.turn).filter(Number.isSafeInteger));
    return [...turns].map(turn => <TeamDispatchProbe key={teamTurnKey(flow.sessionId, turn)} sessionId={flow.sessionId} turn={turn} nodes={nodes} onReport={reportTeamDispatches}/>);
  }, [plans, nodes, flow.sessionId, hasTeamMembers, reportTeamDispatches]);
  const inlinePresentation = useCallback(selector => flow.usePresentation(policy => selector(inlinePolicy(policy))), [flow.usePresentation]);
  let pending = flow.pendingInputs;
  const tail = flow.entries.at(-1), tailNode = tail?.kind === 'node' ? nodes.get(tail.key) : undefined;
  const shouldPlaceBefore = tailNode?.kind === 'turn-process' && tailNode.location?.kind === 'turn' && tailNode.location.turn.status === 'open' && tailNode.location.turn.turn !== flow.lastInputTurn;
  let early = null;
  if (shouldPlaceBefore) {
    const at = pending.findIndex(item => 'requestId' in item && item.placement === 'transcript');
    if (at !== -1) { early = pending[at]; pending = pending.filter((_, index) => index !== at); }
  }
  const rows = [];
  for (const plan of plans) {
    if (plan.kind === 'native') {
      // Each original root entry keeps its own React parent/key. Grouping a
      // whole plain run by its first entry remounts that run on history prepend
      // and invalidates the Host's retained DOM paging anchor.
      for (const entry of plan.entries) {
        const node = entry.kind === 'node' ? nodes.get(entry.key) : undefined;
        rows.push(node && SILENT_ROWS.has(node.kind)
          ? <AnchorOnly key={`silent:${entryKey(entry)}`} entry={entry}/>
          : <NoRunningFlow key={`native:${entryKey(entry)}`} NativeFlow={NativeFlow} flow={flow} entries={singleton(entry)}/>);
      }
      continue;
    }
    const key = plan.kind === 'control' ? `control:${plan.entry.key}` : `message:${entryKey(plan.groups[0] ?? plan.response)}`;
    if (early && plan.kind === 'control' && plan.entry.key === tail?.key) rows.push(<NoRunningFlow key={`echo:${early.requestId}`} NativeFlow={NativeFlow} flow={flow} entries={EMPTY_INPUTS} pendingInputs={[early]}/>);
    const attention = attentionOf(plan.turn);
    rows.push(plan.kind === 'control'
      ? <ControlSurface key={key} plan={plan} flow={flow} NativeFlow={NativeFlow} author={author} carrySummary={summaryCarrier.get(plan.turn) === plan} attention={attention} agents={agentBadgesByTurn.get(plan.turn)}/>
      : <MessageSurface key={key} plan={plan} flow={flow} NativeFlow={NativeFlow} author={author} inlinePresentation={inlinePresentation} turnHasText={turnsWithText.has(plan.turn)} carrySummary={summaryCarrier.get(plan.turn) === plan} attention={attention} agents={agentBadgesByTurn.get(plan.turn)}/>);
  }
  // If an unexpected projection removed the opening controller, show its echo
  // at the tail rather than silently losing it.
  if (early && !plans.some(plan => plan.kind === 'control' && plan.entry.key === tail?.key)) pending = [early, ...pending];
  return <>{probes}{teamProbes}{rows}<NativeFlow {...flow} entries={EMPTY_INPUTS} pendingInputs={pending}/></>;
}
export function NativeFlowAdapter({ NativeFlow, ...flow }) {
  const mode = useDisplayMode();
  return mode === 'card' ? <NativeFlow {...flow}/> : <BubbleFlow NativeFlow={NativeFlow} {...flow}/>;
}
export function installNativeFlowAdapter(ctx, onAvailability = () => {}) {
  // The Host owns this optional child slot. No flow props or callbacks are
  // installed on the browser global; when absent, the Host renders natively.
  return ctx.slots.inject(FLOW_SLOT, () => {
    const stop = ctx.slots.register({ name: FLOW_SLOT, priority: -5 }, NativeFlowAdapter);
    onAvailability(true);
    return () => { stop(); onAvailability(false); };
  });
}
