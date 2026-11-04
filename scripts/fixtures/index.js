// Test-only host fixture: no production credentials, no external LLM/network calls.
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { installStressFixture } from './stress.js';
import { installV02Fixture } from './v02.js';
import { installV03Fixture } from './v03.js';
import { installV04Fixture } from './v04.js';
const home = process.env.DSH_HOME;
if (process.env.SESSION_LINK_TEST !== '1' || !home?.startsWith('/tmp/dsh-session-link-')) throw new Error('Fixture is restricted to a dedicated /tmp/dsh-session-link-* home.');
const installation = process.env.SL_HARNESS_INSTALL;
if (!installation) throw new Error('SL_HARNESS_INSTALL is required.');
const { LlmAdapter, createUserMessage } = await import(pathToFileURL(path.join(installation, 'node_modules/@deepseek-ai/dsh-llm/lib/index.js')).href);
export const name = 'session-link-test-fixture';
export const inject = ['llm', 'sessionController', 'workspaceRegistry', 'sessionQuery', 'agents', 'sessions', 'tools', 'connection', 'agentDefaultModel', 'permissionPresets'];
class FixtureAdapter extends LlmAdapter {
  async listModels(provider) { return [{ provider, id: 'fixture', name: 'Local scripted model (no API cost)', inputModalities: ['text'] }]; }
  async resolveModel(provider, model) { return { provider, model, id: model, name: 'Local scripted fixture', context: { contextWindow: 262144 }, inputModalities: ['text'] }; }
  async *stream(options) {
    options.signal?.throwIfAborted();
    const messages = options.messages ?? [];
    let inbound = -1, inboundText = '';
    for (let i = messages.length - 1; i >= 0; i--) {
      const item = messages[i];
      const body = (item.content ?? []).filter(block => block.type === 'text').map(block => block.text).join('\n');
      if (item.role === 'user' && body.includes('[session-link request') && body.includes('SL_TEST_AUTOREPLY')) { inbound = i; inboundText = body; break; }
    }
    const calls = messages.slice(inbound + 1).flatMap(item => (item.content ?? []).filter(block => block.type === 'tool-call'));
    let next;
    if (inbound >= 0 && !calls.some(call => call.name === 'session_link_reply')) {
      const operationCall = calls.find(call => call.name === 'session_link_operation');
      if (!operationCall) next = { name: 'session_link_operation', arguments: '{}' };
      else {
        const results = messages.slice(inbound + 1).filter(item => item.role === 'tool').flatMap(item => item.content ?? []).filter(block => block.type === 'text').map(block => block.text).join('\n');
        const operationId = results.match(/slop:\d+:[a-f0-9-]+/)?.[0];
        const messageId = inboundText.match(/message: ([a-f0-9-]+)/)?.[1];
        if (operationId && messageId) next = { name: 'session_link_reply', arguments: JSON.stringify({ operationId, messageId, text: 'SL_TEST_REPLY: explicit model tool reply' }) };
      }
    }
    if (next && options.tools?.some(tool => tool.name === next.name)) {
      const block = { type: 'tool-call', id: randomUUID(), ...next };
      yield { type: 'block-start', index: 0, blockType: 'tool-call' };
      yield { type: 'tool-call-delta', index: 0, id: block.id, name: block.name, argumentsDelta: block.arguments };
      yield { type: 'block-end', index: 0, block };
      yield { type: 'finish', reason: { kind: 'tool-calls' } }; return;
    }
    const text = 'FIXTURE_ACK: local scripted model processed the input.';
    yield { type: 'block-start', index: 0, blockType: 'text' };
    yield { type: 'text-delta', index: 0, text };
    yield { type: 'block-end', index: 0, block: { type: 'text', text } };
    yield { type: 'finish', reason: { kind: 'stop' } };
  }
}
export async function apply(ctx) {
  const adapter = ctx.llm.registerAdapter(['session-link-fixture'], new FixtureAdapter());
  ctx.effect(() => () => typeof adapter === 'function' ? adapter() : adapter.dispose?.());
  const dataFile = path.join(home, 'fixture-sessions.json');
  const fixture = {
    async init() {
      try { return JSON.parse(await readFile(dataFile, 'utf8')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
      const directory = path.join(home, 'project-a'); await mkdir(directory, { recursive: true });
      const other = path.join(home, 'project-b'); await mkdir(other, { recursive: true });
      const workA = await ctx.workspaceRegistry.create(directory, '隔离项目A');
      const workB = await ctx.workspaceRegistry.create(other, '隔离项目B');
      const output = {};
      for (const [key, workspace] of [['a', workA], ['b', workB], ['archived', workB]]) {
        const result = await ctx.sessionController.create({ workspaceId: workspace.id });
        const sessionId = result.sessionId;
        await ctx.sessionController.selectModel({ sessionId, provider: 'session-link-fixture', model: 'fixture' });
        // selectModel does not necessarily materialize a blank; a deterministic input makes each session unique.
        const resolved = await ctx.sessionController.resolveAgent(sessionId);
        if (!resolved.agent) throw new Error(JSON.stringify(resolved.error));
        const { createUserMessage } = await import(pathToFileURL(path.join(installation, 'node_modules/@deepseek-ai/dsh-llm/lib/index.js')).href);
        resolved.agent.followup(createUserMessage({ content: [{ type: 'text', text: `fixture init ${key}` }], source: { kind: 'user' } }));
        await resolved.agent.whenIdle(); await ctx.sessions.flush(resolved.agent.session);
        await ctx.sessionController.rename({ sessionId, title: key === 'a' ? '主会话 A' : key === 'b' ? '协作会话 B' : '已归档 C' });
        output[key] = sessionId;
      }
      await ctx.workspaceRegistry.archiveSession(output.archived);
      await writeFile(dataFile, JSON.stringify(output), { mode: 0o600 }); return output;
    },
    async invoke(payload) {
      if (typeof payload.name !== 'string' || !payload.name.startsWith('session_link_')) throw new Error('Only session_link fixture tools allowed');
      const sessions = await fixture.init();
      if (!Object.values(sessions).includes(payload.sessionId)) throw new Error('Unknown fixture session');
      const found = await ctx.sessionController.resolveAgent(payload.sessionId);
      if (!found.agent) throw new Error(JSON.stringify(found.error));
      const definition = ctx.tools.get(payload.name);
      if (!definition) throw new Error(`Tool not registered: ${payload.name}`);
      return await definition.execute(payload.args ?? {}, { agent: found.agent, signal: AbortSignal.timeout(10000), callId: randomUUID() });
    },
    async fork() {
      const sessions = await fixture.init();
      if (sessions.fork) return { sessionId: sessions.fork };
      const result = await ctx.sessionController.fork({ sessionId: sessions.a });
      const workspace = ctx.workspaceRegistry.list().find(item => item.sessionIds.includes(sessions.a));
      await workspace.attachSession(result.sessionId);
      sessions.fork = result.sessionId;
      await writeFile(dataFile, JSON.stringify(sessions), { mode: 0o600 }); return result;
    },
    async compact(payload) {
      const sessions = await fixture.init();
      if (!Object.values(sessions).includes(payload.sessionId)) throw new Error('Unknown fixture session');
      const resolved = await ctx.sessionController.resolveAgent(payload.sessionId);
      if (!resolved.agent) throw new Error(JSON.stringify(resolved.error));
      await resolved.agent.whenIdle();
      const before = await ctx.sessionQuery.readSession(payload.sessionId);
      const messages = before.events.filter(event => event.type === 'user/message' || event.type === 'assistant/message');
      if (messages.length < 2) throw new Error('Not enough fixture history to compact');
      const compaction = resolved.agent.ctx.get('compaction') ?? ctx.get('compaction');
      if (!compaction) throw new Error('Agent preset did not provide compaction');
      const result = await compaction.compactNow(resolved.agent, AbortSignal.timeout(15000));
      if (!result) throw new Error('Real compaction returned no useful range');
      await ctx.sessions.flush(resolved.agent.session);
      return { compacted: true, result };
    },
    async owner_gate() {
      const peer = ctx.connection.createPeer({ principal: { kind: 'session-link-test-guest' }, interactions: 'none' });
      const response = await ctx.connection.createSharedFetchHandler('/api').fetch(new Request('http://127.0.0.1:3098/api/session-link/api', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'snapshot', payload: {} }) }), peer);
      return { status: response.status, body: await response.text() };
    },
    async evidence(payload) {
      const sessions = await fixture.init();
      if (!Object.values(sessions).includes(payload.sessionId)) throw new Error('Unknown fixture session');
      const snapshot = await ctx.sessionQuery.readSession(payload.sessionId);
      return { header: snapshot.session, inheritedEventCount: snapshot.inheritedEventCount, events: snapshot.events };
    }
  };
  const dispose = ctx.connection.fetch.register({ path: '/api/session-link-fixture', methods: ['POST'], requestBody: 'buffered', async fetch(request) {
    try { const input = await request.json(); if (!Object.hasOwn(fixture, input.action)) return Response.json({ ok: false, error: 'Unknown fixture action' }, { status: 400 }); const value = await fixture[input.action](input.payload ?? {}); return Response.json({ ok: true, value }); }
    catch (error) { return Response.json({ ok: false, error: { message: error.message, code: error.code } }); }
  } });
  ctx.effect(() => dispose);
  const stress = await installStressFixture(ctx, { home, createUserMessage });
  ctx.effect(() => () => stress.dispose());
  const v02 = await installV02Fixture(ctx, { home, createUserMessage });
  ctx.effect(() => () => v02.dispose());
  const v03 = await installV03Fixture(ctx, { home, createUserMessage, LlmAdapter });
  ctx.effect(() => () => v03.dispose());
  const v04 = await installV04Fixture(ctx, { home, createUserMessage, LlmAdapter });
  ctx.effect(() => () => v04.dispose());
}
