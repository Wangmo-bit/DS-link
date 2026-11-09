// Mechanical regression for the public React Slot chat skin. The JSX is bundled
// in memory; React is real, but hooks are driven by a test dispatcher so a
// component can be invoked without a browser renderer. The Markdown primitive
// is a local stub. No Host, browser, network or profile is used.
// Run: node --test scripts/ui-chat-skin.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import React from 'react';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const markdownCalls = [];
function MarkdownText(props) {
  markdownCalls.push(props);
  return React.createElement('span', { 'data-markdown': '' }, props.text);
}
const primitives = { MarkdownText };

async function loadClientEntry(entry) {
  const bundle = await build({
    absWorkingDir: root,
    entryPoints: [entry],
    bundle: true,
    write: false,
    format: 'cjs',
    platform: 'browser',
    target: 'es2022',
    jsx: 'transform',
    loader: { '.css': 'text' },
    external: ['react', '@deepseek-ai/dsh-client-ui-primitives'],
    logLevel: 'silent',
  });
  const loaded = { exports: {} };
  const requireStub = (name) => {
    if (name === 'react') return React;
    if (name === '@deepseek-ai/dsh-client-ui-primitives') return primitives;
    throw new Error(`unexpected bundle require: ${name}`);
  };
  new Function('require', 'module', 'exports', bundle.outputFiles[0].text)(requireStub, loaded, loaded.exports);
  return loaded.exports;
}

const skin = await loadClientEntry('src/client/chat-skin.jsx');
const ui = await loadClientEntry('src/client/chat-ui.jsx');
const imageSkin = await loadClientEntry('src/client/image-skin.jsx');

/* ── Hook dispatcher ─────────────────────────────────────────────────────── */

const dispatcherRef = React.__SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED?.ReactCurrentDispatcher;
assert.ok(dispatcherRef, 'test requires ReactCurrentDispatcher');

const sameDeps = (a, b) => Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((value, index) => Object.is(value, b[index]));

function makeDispatcher(store) {
  const useState = (initial) => {
    const index = store.cursor++;
    if (store.slots.length <= index) store.slots[index] = typeof initial === 'function' ? initial() : initial;
    return [store.slots[index], (next) => {
      store.slots[index] = typeof next === 'function' ? next(store.slots[index]) : next;
    }];
  };
  return {
    useState,
    useRef(initial) {
      const index = store.cursor++;
      if (store.slots.length <= index) store.slots[index] = { current: initial };
      return store.slots[index];
    },
    useEffect() {
      store.cursor += 1;
    },
    useLayoutEffect() {
      store.cursor += 1;
    },
    useInsertionEffect() {
      store.cursor += 1;
    },
    useMemo(compute, deps) {
      const index = store.cursor++;
      const previous = store.slots[index];
      if (!previous || !sameDeps(previous.deps, deps)) store.slots[index] = { value: compute(), deps };
      return store.slots[index].value;
    },
    useCallback(callback, deps) {
      const index = store.cursor++;
      const previous = store.slots[index];
      if (!previous || !sameDeps(previous.deps, deps)) store.slots[index] = { value: callback, deps };
      return store.slots[index].value;
    },
    useReducer(reducer, initialArg, init) {
      const [state, setState] = useState(init ? init(initialArg) : initialArg);
      return [state, (action) => setState((previous) => reducer(previous, action))];
    },
    useContext() {
      return undefined;
    },
    useDebugValue() {},
    useDeferredValue(value) {
      return value;
    },
    useTransition() {
      return [false, (callback) => callback()];
    },
    useId() {
      const index = store.cursor++;
      if (store.slots.length <= index) store.slots[index] = `test-id-${index}`;
      return store.slots[index];
    },
    useSyncExternalStore(_subscribe, getSnapshot) {
      return getSnapshot();
    },
    useImperativeHandle() {},
  };
}

function invoke(Component, props, store) {
  const previous = dispatcherRef.current;
  store.cursor = 0;
  dispatcherRef.current = makeDispatcher(store);
  try {
    return Component(props);
  } finally {
    dispatcherRef.current = previous;
  }
}

/* ── Tiny render tree ────────────────────────────────────────────────────── */

function renderNodes(element, context, pathName) {
  if (element === null || element === undefined || typeof element === 'boolean') return [];
  if (Array.isArray(element)) return element.flatMap((child, index) => renderNodes(child, context, `${pathName}.${index}`));
  if (typeof element === 'string' || typeof element === 'number') return [{ kind: 'text', text: String(element), parent: null }];
  if (!React.isValidElement(element)) throw new Error(`unsupported test node at ${pathName}`);

  const { type, props } = element;
  if (type === React.Fragment || type?.$$typeof === Symbol.for('react.provider')) return renderNodes(props?.children, context, `${pathName}.fragment`);
  if (typeof type === 'function') {
    let store = context.stores.get(pathName);
    if (!store) {
      store = { slots: [], cursor: 0 };
      context.stores.set(pathName, store);
    }
    return renderNodes(invoke(type, props ?? {}, store), context, `${pathName}.rendered`);
  }
  if (typeof type !== 'string') throw new Error(`unsupported element type at ${pathName}`);

  const node = { kind: 'host', type, props: props ?? {}, parent: null, children: [] };
  node.children = renderNodes(props?.children, context, `${pathName}.children`);
  for (const child of node.children) child.parent = node;
  return [node];
}

function mount(Component, props) {
  const context = { stores: new Map() };
  const element = React.createElement(Component, props);
  let tree = renderNodes(element, context, 'root');
  return {
    get tree() {
      return tree;
    },
    render() {
      tree = renderNodes(element, context, 'root');
      return tree;
    },
  };
}

function walk(node, visit) {
  if (Array.isArray(node)) {
    for (const child of node) walk(child, visit);
    return;
  }
  if (!node) return;
  visit(node);
  for (const child of node.children ?? []) walk(child, visit);
}

function findAll(node, predicate) {
  const found = [];
  walk(node, (child) => {
    if (predicate(child)) found.push(child);
  });
  return found;
}

function findOne(node, predicate, label) {
  const found = findAll(node, predicate);
  assert.equal(found.length, 1, `${label}: expected exactly one match, got ${found.length}`);
  return found[0];
}

function textOf(node) {
  if (Array.isArray(node)) return node.map(textOf).join('');
  if (!node) return '';
  if (node.kind === 'text') return node.text;
  return (node.children ?? []).map(textOf).join('');
}

const host = (node, type) => node?.kind === 'host' && node.type === type;
const hasProp = (node, name) => node?.kind === 'host' && Object.hasOwn(node.props, name);
const hasAncestor = (node, predicate) => {
  for (let parent = node?.parent; parent; parent = parent.parent) if (predicate(parent)) return true;
  return false;
};

/* ── Slot fixtures ───────────────────────────────────────────────────────── */

function nativeEntry(key, priority, inject, locale = 'chat', children) {
  return {
    options: { key, priority },
    component: function NativeMarker() {
      return React.createElement('div', { 'data-native-marker': key });
    },
    inject,
    locale,
    ...(children === undefined ? {} : { children }),
  };
}

function makeNativeEntries() {
  const hooks = { turnData: () => 'native-hook' };
  const keyedHooks = { chatNode: () => 'native-keyed-hook' };
  const injectArgs = [];
  const entries = [
    nativeEntry('user', 20, () => ({ hooks: { ignored: true } })),
    nativeEntry('user', 10, (...args) => {
      injectArgs.push(args);
      return { hooks, keyedHooks, extra: 'kept' };
    }),
    nativeEntry('steering', 7),
    nativeEntry('assistant-step', 3, () => ({ hooks: { assistant: true } })),
    nativeEntry('turn-process', 1),
    nativeEntry('unrelated', 0),
  ];
  return { entries, hooks, keyedHooks, injectArgs };
}

function installFixture(entries = makeNativeEntries().entries, { adapter = false } = {}) {
  const registers = [];
  const stops = [];
  const effects = [];
  const injections = [];
  const ctx = {
    effect(handler) {
      effects.push(handler);
      return () => {};
    },
    slots: {
      inject(name, callback) {
        // This fixture tests the chat-node seat. Image-viewer declaration is
        // not mounted here and is exercised by its own independent tests.
        const cleanup = name === 'conversation.chat.user.images' || (name === 'conversation.chat.flow.adapter' && !adapter) ? () => {} : callback();
        injections.push({ name, cleanup });
        return cleanup;
      },
      entries(name) {
        assert.equal(name, 'conversation.chat.node');
        return entries;
      },
      register(options, component) {
        registers.push({ options, component });
        return () => stops.push(options.key);
      },
    },
    sessions: {
      list: {
        getSnapshot: () => ({ byId: { 'sess-1': { title: '设计评审' }, 'child-1': { title: '这是一次全新独立的总体冷审', origin: 'subagent', projectionValues: { subagent: { mode: 'continuable', label: '冷审' } } }, 'child-2': { title: '很长的任务内容', origin: 'subagent' } } }),
      },
    },
  };
  skin.installChatSkin(ctx);
  return { ctx, registers, stops, effects, injections };
}

function restoreDocument(descriptor) {
  if (descriptor) Object.defineProperty(globalThis, 'document', descriptor);
  else delete globalThis.document;
}

/* ── User/assistant fixtures ─────────────────────────────────────────────── */

function makeUserFixture(text) {
  const nativeProps = [];
  const factoryCalls = [];
  const copied = [];
  const loadImage = () => {};
  const originalFactory = (name, input, ...rest) => {
    factoryCalls.push({ name, input, rest });
    return React.createElement('span', { 'data-factory': name }, input.content?.text ?? '');
  };
  function Native(props) {
    nativeProps.push(props);
    const originalText = props.node.data.content.text;
    const content = props.renderFactorySlot(
      'conversation.chat.user.content',
      {
        content: { text: originalText, attachments: props.node.data.content.attachments },
        loadImage: props.loadImage,
        facts: { nativeFact: true },
        interactive: true,
      },
      'native-rest',
    );
    return React.createElement(
      'div',
      { 'data-native': '' },
      content,
      React.createElement(
        'button',
        { type: 'button', 'data-copy-original': originalText, onClick: () => copied.push(originalText) },
        'copy original',
      ),
    );
  }
  const props = {
    node: { data: { content: { text, attachments: [] } } },
    loadImage,
    other: { keep: true },
    renderFactorySlot: originalFactory,
  };
  return { Native, props, nativeProps, factoryCalls, copied, loadImage, originalFactory };
}

function makeAssistantFixture({ blocks, status = 'closed', skinAuthor = '助手' } = {}) {
  const factoryCalls = [];
  const loadImage = () => {};
  const renderFactorySlot = (name, input) => {
    factoryCalls.push({ name, input });
    return React.createElement('span', { 'data-factory': name });
  };
  const props = {
    node: { data: { blocks, status }, location: {} },
    renderFactorySlot,
    loadImage,
    skinAuthor,
    useTurnData: () => undefined,
  };
  return { props, factoryCalls, loadImage };
}

function makeTurnNode({ status = 'closed', elapsedMs = 125000, reason, messageCount = 9, toolCallCount = 8, reasoningCount = 9 } = {}) {
  const turn = status === 'closed'
    ? {
        status,
        start: { time: 1000 },
        steps: Array.from({ length: reasoningCount + 1 }, (_, index) => ({ data: { get: () => ({ blocks: [{ kind: index < reasoningCount ? 'reasoning' : 'text', text: '真实步骤' }] }) } })),
        end: {
          time: 1000 + elapsedMs,
          ...(reason === undefined ? {} : { data: { reason: { kind: reason } } }),
        },
      }
    : { status };
  return {
    data: { turn: 7, messageCount, toolCallCount },
    location: { turn },
  };
}

function makeTurnProcess({ open = false, foldable = true, hasContent = true } = {}) {
  let current = open;
  const calls = [];
  return {
    foldable,
    hasContent,
    get open() {
      return current;
    },
    setOpen(value) {
      calls.push(value);
      current = value;
    },
    calls,
  };
}

function turnButton(tree) {
  return findOne(tree, (node) => host(node, 'button') && hasProp(node, 'data-turn-process'), 'turn process button');
}

function articleOf(tree) {
  return findOne(tree, (node) => host(node, 'article') && hasProp(node, 'data-sl-message'), 'message article');
}

function assertSingleBubbleSibling(tree, author) {
  const article = articleOf(tree);
  const label = findOne(article, (node) => hasProp(node, 'data-sl-author'), 'author label');
  const header = label.type === 'header' ? label : label.parent;
  const bubbles = findAll(article, (node) => hasProp(node, 'data-sl-bubble'));
  assert.equal(bubbles.length, 1, 'exactly one bubble');
  assert.equal(header.parent, article, 'author header is a direct child of the message row');
  assert.ok(!hasAncestor(label, node => node === bubbles[0]), 'author is outside the message bubble');
  assert.match(textOf(label), new RegExp(author));
  return { article, header, bubble: bubbles[0] };
}

/* ── Tests ───────────────────────────────────────────────────────────────── */

test('bundles chat-skin.jsx and chat-ui.jsx in memory with CSS text and a primitive stub', () => {
  assert.deepEqual(Object.keys(skin).sort(), ['TurnProcessSkin', 'createAssistantSkin', 'createUserSkin', 'installChatSkin']);
  assert.equal(typeof ui.MessageBubble, 'function');
  assert.equal(typeof ui.MessageText, 'function');
  assert.equal(typeof skin.installChatSkin, 'function');
});

test('install registers keyed wrappers with native key, priority-5 and no invented children', () => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'document');
  let fixture;
  try {
    Object.defineProperty(globalThis, 'document', {
      configurable: true,
      get() {
        throw new Error('install registration must not touch the DOM');
      },
    });
    fixture = installFixture();
  } finally {
    restoreDocument(descriptor);
  }

  assert.deepEqual(fixture.injections.map(item => item.name), ['conversation.chat.user.images', 'conversation.chat.flow.adapter', 'conversation.chat.flow']);
  assert.deepEqual(fixture.registers.map(({ options }) => options.key), ['user', 'steering', 'assistant-step', 'turn-process']);
  const expectedPriority = { user: 5, steering: 2, 'assistant-step': -2, 'turn-process': -4 };
  for (const { options, component } of fixture.registers) {
    assert.equal(options.name, 'conversation.chat.node');
    assert.equal(options.priority, expectedPriority[options.key]);
    assert.equal(options.locale, 'chat');
    assert.equal(typeof options.inject, 'function');
    assert.equal(typeof component, 'function');
    assert.equal(Object.hasOwn(options, 'children'), false, `${options.key} must not invent a children declaration rc.5 does not have`);
  }
  const rc5UserProps = fixture.registers.find(({ options }) => options.key === 'user').options.inject('sess-1');
  assert.equal(Object.hasOwn(rc5UserProps, 'renderSlotChain'), false, 'rc.5 entries declare no child chain, so no injection is added');

  const userComponent = fixture.registers.find(({ options }) => options.key === 'user').component;
  const nativeView = mount(userComponent, {
    renderFactorySlot: () => null,
    node: { data: { content: { text: 'short', attachments: [] } } },
  });
  assert.equal(findAll(nativeView.tree, (node) => hasProp(node, 'data-native-marker')).length, 1, 'the registered user wrapper keeps the native component');

  fixture.injections.find(item => item.name === 'conversation.chat.flow').cleanup();
  assert.deepEqual(fixture.stops, ['turn-process', 'assistant-step', 'steering', 'user']);
});

test('rc.1 user seat injects the empty child-chain renderer without redeclaring the slot', () => {
  const children = { 'conversation.chat.user.before': { kind: 'chain', scope: 'session' } };
  const steeringInject = () => ({ renderSlotChain: () => null });
  const fixture = installFixture([
    nativeEntry('user', 10, undefined, 'chat', children),
    nativeEntry('steering', 7, steeringInject),
  ]);
  const user = fixture.registers.find(({ options }) => options.key === 'user');
  const steering = fixture.registers.find(({ options }) => options.key === 'steering');
  assert.equal(Object.hasOwn(user.options, 'children'), false, 'the child slot is declared once by the official entry');
  const userProps = user.options.inject('sess-1');
  assert.equal(typeof userProps.renderSlotChain, 'function', 'rc.1 UserStyleBubble requires an injected chain renderer');
  assert.equal(userProps.renderSlotChain('conversation.chat.user.before', {}, { fallback: null }), null);
  const steeringProps = steering.options.inject('sess-1');
  assert.equal(typeof steeringProps.renderSlotChain, 'function', 'the official steering injection survives the merge');
  fixture.injections.find(item => item.name === 'conversation.chat.flow').cleanup();
});

test('when the scoped flow adapter exists, native assistant and process renderers stay authoritative', () => {
  const fixture=installFixture(makeNativeEntries().entries,{adapter:true});
  assert.deepEqual(fixture.registers.map(({options})=>[options.name,options.key]),[
    ['conversation.chat.flow.adapter',undefined],['conversation.chat.node','user'],['conversation.chat.node','steering'],
  ]);
  fixture.injections.find(item=>item.name==='conversation.chat.flow').cleanup();
  fixture.injections.find(item=>item.name==='conversation.chat.flow.adapter').cleanup();
});

test('card mode keeps every native chat node unwrapped', () => {
  const saved = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  try {
    Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: { getItem: () => 'card' } });
    const fixture = installFixture(makeNativeEntries().entries, { adapter: true });
    const nodeEntries = fixture.registers.filter(({ options }) => options.name === 'conversation.chat.node');
    assert.deepEqual(nodeEntries, []);
    fixture.injections.find(item => item.name === 'conversation.chat.flow').cleanup();
    fixture.injections.find(item => item.name === 'conversation.chat.flow.adapter').cleanup();
  } finally {
    if (saved) Object.defineProperty(globalThis, 'localStorage', saved); else delete globalThis.localStorage;
  }
});

test('native inject receives the session id string and its hooks survive', () => {
  const { entries, hooks, keyedHooks, injectArgs } = makeNativeEntries();
  const fixture = installFixture(entries);
  const user = fixture.registers.find(({ options }) => options.key === 'user').options;

  const injected = user.inject('sess-1');
  assert.deepEqual(injectArgs[0], ['sess-1']);
  assert.equal(typeof injectArgs[0][0], 'string', 'the top-level inject argument is a session id string');
  assert.equal(injected.skinAuthor, '设计评审');
  assert.equal(injected.hooks, hooks, 'native hooks keep their identity');
  assert.equal(injected.keyedHooks, keyedHooks, 'native keyed hooks keep their identity');
  assert.equal(injected.extra, 'kept');

  assert.equal(user.inject('missing-session').skinAuthor, '助手');
  assert.equal(user.inject(undefined).skinAuthor, '助手');
  assert.equal(injectArgs.at(-1)[0], undefined);

  const assistant = fixture.registers.find(({ options }) => options.key === 'assistant-step').options;
  const assistantFace = assistant.inject('sess-1');
  assert.deepEqual(assistantFace.hooks, { assistant: true });
  assert.equal(assistantFace.skinAuthor, '设计评审');
  assert.equal(typeof assistantFace.keyedHooks.turnSteps, 'function');
  assert.equal(typeof assistantFace.keyedHooks.turnTools, 'function');
  assert.deepEqual(assistantFace.keyedHooks.turnSteps('1').getSnapshot(), []);
  assert.equal(assistant.inject('child-1').skinAuthor, '冷审');
  assert.equal(assistant.inject('child-2').skinAuthor, '子智能体');
});

test('install effect owns one removable style node and never decorates chat rows', () => {
  const fixture = installFixture();
  assert.equal(fixture.effects.length, 1);
  const appended = [];
  let removed = 0;
  const style = { tagName: 'style', dataset: {}, textContent: '', remove() { removed += 1; } };
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'document');
  try {
    Object.defineProperty(globalThis, 'document', {
      configurable: true,
      value: {
        createElement(tag) {
          assert.equal(tag, 'style');
          return style;
        },
        head: { append(node) { appended.push(node); } },
        get body() {
          throw new Error('chat row DOM must not be touched');
        },
        querySelector() {
          throw new Error('chat row DOM must not be queried');
        },
        querySelectorAll() {
          throw new Error('chat row DOM must not be queried');
        },
      },
    });
    const cleanup = fixture.effects[0]();
    assert.deepEqual(appended, [style]);
    assert.equal(style.tagName, 'style');
    assert.equal(typeof style.textContent, 'string');
    assert.equal(typeof cleanup, 'function');
    cleanup();
    assert.equal(removed, 1);
  } finally {
    restoreDocument(descriptor);
  }
});

test('MessageBubble keeps the author header as a sibling of exactly one bubble', () => {
  markdownCalls.length = 0;
  const view = mount(ui.MessageBubble, { author: '王墨', direction: 'sent', text: 'hello' });
  const { bubble } = assertSingleBubbleSibling(view.tree, '王墨');
  assert.match(textOf(bubble), /hello/);
  assert.equal(findAll(view.tree, (node) => hasProp(node, 'data-sl-bubble')).length, 1);
});

test('user skin keeps Host actions outside the bubble and preserves the full original text', () => {
  const long = 'x'.repeat(1600);
  const fixture = makeUserFixture(long);
  const view = mount(skin.createUserSkin(fixture.Native), fixture.props);

  assert.equal(fixture.nativeProps.length, 1);
  const forwarded = fixture.nativeProps[0];
  assert.equal(forwarded.node, fixture.props.node, 'Native receives the original node');
  assert.equal(forwarded.loadImage, fixture.loadImage);
  assert.equal(forwarded.other, fixture.props.other);
  assert.notEqual(forwarded.renderFactorySlot, fixture.originalFactory, 'the content factory is the only override');

  const contentCalls = fixture.factoryCalls.filter((call) => call.name === 'conversation.chat.user.content');
  assert.equal(contentCalls.length, 1);
  assert.equal(contentCalls[0].input.content.text, long, 'display factory receives the full text');
  assert.deepEqual(contentCalls[0].input.content.attachments, []);
  assert.equal(contentCalls[0].rest[0], 'native-rest', 'extra factory arguments are forwarded');

  const copyButton = findOne(view.tree, (node) => host(node, 'button') && hasProp(node, 'data-copy-original'), 'original copy button');
  assert.equal(copyButton.props['data-copy-original'], long);
  copyButton.props.onClick();
  assert.deepEqual(fixture.copied, [long], 'copy uses the untouched original text');

  const { article, bubble } = assertSingleBubbleSibling(view.tree, '我');
  const nativeNode = findOne(article, (node) => hasProp(node, 'data-native'), 'native renderer');
  assert.ok(hasAncestor(bubble, (node) => node === nativeNode), 'text bubble stays inside the native renderer');
  assert.ok(!hasAncestor(copyButton, (node) => node === bubble), 'native copy action stays outside the text surface');
  assert.equal(findAll(view.tree, (node) => host(node, 'button') && textOf(node).includes('显示全部')).length, 0);
});

test('user image is separate from text and Host receives each attachment exactly once', () => {
  const fixture = makeUserFixture('随图文字');
  const image = { type:'image', image:{preview:{url:'blob:one',width:800,height:400}} };
  fixture.props.node.data.content.attachments = [image];
  const view = mount(skin.createUserSkin(fixture.Native), fixture.props);
  const parts = fixture.factoryCalls.filter(call => call.name === 'conversation.chat.user.content');
  assert.equal(parts.length,2);
  assert.deepEqual(parts[0].input.content.attachments,[image]);
  assert.equal(parts[0].input.content.text,'');
  assert.deepEqual(parts[1].input.content.attachments,[]);
  assert.equal(parts[1].input.content.text,'随图文字');
  const attachment = findOne(view.tree,node=>host(node,'div') && node.props.className==='sl-user-attachments','attachment area');
  const bubble = findOne(view.tree,node=>hasProp(node,'data-sl-bubble'),'text bubble');
  assert.ok(!hasAncestor(attachment,node=>node===bubble));
  const copy = findOne(view.tree,node=>host(node,'button') && hasProp(node,'data-copy-original'),'copy');
  assert.ok(!hasAncestor(copy,node=>node===bubble));
});

test('short user text stays original and has no fold control', () => {
  const fixture = makeUserFixture('hello');
  const view = mount(skin.createUserSkin(fixture.Native), fixture.props);
  const contentCalls = fixture.factoryCalls.filter((call) => call.name === 'conversation.chat.user.content');
  assert.equal(contentCalls.length, 1);
  assert.equal(contentCalls[0].input.content.text, 'hello');
  assert.equal(findAll(view.tree, (node) => host(node, 'button') && textOf(node).includes('显示全部')).length, 0);
  const copyButton = findOne(view.tree, (node) => host(node, 'button') && hasProp(node, 'data-copy-original'), 'original copy button');
  copyButton.props.onClick();
  assert.deepEqual(fixture.copied, ['hello']);
});

test('assistant text remains full through MessageText, never through the native factory', () => {
  const long = 'y'.repeat(1600);
  markdownCalls.length = 0;
  const fixture = makeAssistantFixture({ blocks: [{ kind: 'text', text: long }], status: 'closed', skinAuthor: '设计评审' });
  const view = mount(skin.createAssistantSkin(), fixture.props);

  assert.equal(fixture.factoryCalls.length, 0, 'text must not go back through the native factory');
  assert.equal(markdownCalls.length, 1);
  assert.equal(markdownCalls[0].text, long);
  assert.equal(markdownCalls[0].streaming, false);
  assertSingleBubbleSibling(view.tree, '设计评审');

  assert.equal(findAll(view.tree, (node) => host(node, 'button') && textOf(node).includes('显示全部')).length, 0);
  assert.equal(fixture.factoryCalls.length, 0);

  markdownCalls.length = 0;
  const streaming = makeAssistantFixture({ blocks: [{ kind: 'text', text: long }], status: 'running', skinAuthor: '设计评审' });
  const streamingView = mount(skin.createAssistantSkin(), streaming.props);
  assert.equal(markdownCalls[0].text, long, 'streaming text is never folded');
  assert.equal(markdownCalls[0].streaming, true);
  assert.equal(findAll(streamingView.tree, (node) => host(node, 'button') && textOf(node).includes('显示全部')).length, 0);
  assert.match(textOf(streamingView.tree), /思考中/);
});

test('assistant images and reasoning are rendered only through factories', () => {
  const blocks = [
    { kind: 'image', attachment: { id: 'img-1' } },
    { kind: 'reasoning', text: 'because' },
  ];
  markdownCalls.length = 0;
  const fixture = makeAssistantFixture({ blocks, status: 'closed', skinAuthor: '设计评审' });
  const view = mount(skin.createAssistantSkin(), fixture.props);

  const imageCall = fixture.factoryCalls.find((call) => call.name === 'conversation.images.content');
  assert.ok(imageCall, 'assistant image has a factory call');
  assert.deepEqual(imageCall.input.images, [{ attachment: { id: 'img-1' } }]);
  assert.equal(imageCall.input.loadImage, fixture.loadImage);
  assert.equal(imageCall.input.align, 'start');
  assert.equal(findAll(view.tree, (node) => host(node, 'img')).length, 0, 'no raw image element');
  assert.equal(markdownCalls.length, 0, 'image/reasoning blocks do not become Markdown text');

  const reasoningCall = fixture.factoryCalls.find((call) => call.name === 'conversation.chat.reasoning.content');
  assert.ok(reasoningCall, 'reasoning has a factory call');
  assert.equal(reasoningCall.input.text, 'because');
  assert.equal(reasoningCall.input.running, false);
  assert.equal(typeof reasoningCall.input.labels, 'object');
  const details = findOne(view.tree, (node) => host(node, 'details'), 'reasoning details');
  assert.match(textOf(details), /思考过程/);
  assertSingleBubbleSibling(view.tree, '设计评审');
});

test('answer header owns one summary and expands real process inside the bubble', () => {
  const calls = [];
  const turnProcess = { ...makeTurnProcess(), spec: { answerStep: 2, toolCallCount: 1 } };
  const { props } = makeAssistantFixture({ blocks: [{ kind: 'text', text: '完整答复' }], status: 'settled', skinAuthor: '开发伙伴' });
  props.node.data.turn = 7; props.node.data.step = 2;
  props.node.location = { turn: makeTurnNode({ reasoningCount: 1 }).location.turn };
  props.turnProcess = turnProcess;
  props.useTurnSteps = () => [{ step: 1, time: 10, blocks: [{ kind: 'reasoning', text: '先检查' }] }];
  props.useTurnTools = () => [{ root: { kind:'tool-result',callId:'call1',name:'read',isError:false,callTime:20,time:30 } }];
  props.inspectCall = id => calls.push(id);
  const view = mount(skin.createAssistantSkin(), props);
  const button = findOne(view.tree, node => host(node,'button') && node.props.className?.includes('sl-heading-process'), 'header process');
  const { article, bubble } = assertSingleBubbleSibling(view.tree, '开发伙伴');
  assert.ok(!hasAncestor(button,node => node === bubble), 'summary is outside and beside the author');
  assert.equal(button.props['aria-expanded'],false);
  button.props.onClick(); view.render();
  const details = findOne(view.tree,node => host(node,'div') && node.props.className === 'sl-inline-process','process details');
  assert.ok(hasAncestor(details,node => node.props?.['data-sl-bubble'] === ''),'expanded details are inside the same bubble');
  assert.match(textOf(details),/思考过程/); assert.match(textOf(details),/读取文件/);
  const inspect=findOne(details,node => host(node,'button') && textOf(node)==='查看详情','inspect'); inspect.props.onClick(); assert.deepEqual(calls,['call1']);
  assert.match(textOf(article),/完整答复/);
  const relocated = mount(skin.TurnProcessSkin,{node:{...makeTurnNode(),data:{...makeTurnNode().data,answerStep:2,answerAnchorSeq:12}},turnProcess});
  assert.equal(findAll(relocated.tree,node=>hasProp(node,'data-sl-process-relocated')).length,1);
  assert.equal(findAll(relocated.tree,node=>host(node,'button')).length,0);
});

test('long turn reasoning seats do not subscribe to whole-turn step and tool arrays', () => {
  const Skin=skin.createAssistantSkin();
  let steps=0, tools=0;
  for (let i=0;i<167;i++) {
    const {props}=makeAssistantFixture({blocks:[{kind:'reasoning',text:'思考'}],status:'settled'});
    props.groupPart='reasoning';
    props.useTurnSteps=()=>{steps++;return [];};
    props.useTurnTools=()=>{tools++;return [];};
    mount(Skin,props);
  }
  assert.equal(steps,0); assert.equal(tools,0);
});

test('live placeholder yields to the streaming response without an empty or duplicate bubble', () => {
  const node=makeTurnNode({status:'running'}); node.data.turn=7;
  node.location.turn.steps=[{step:2}];
  const steps=[{step:2,status:'running',blocks:[{kind:'text',text:'开始回答'}]}];
  const process=makeTurnProcess(); process.spec={answerStep:null,toolCallCount:0};
  const placeholder=mount(skin.TurnProcessSkin,{node,turnProcess:process,useTurnSteps:()=>steps});
  assert.equal(findAll(placeholder.tree,n=>hasProp(n,'data-sl-message')).length,0);
  const {props}=makeAssistantFixture({blocks:steps[0].blocks,status:'running',skinAuthor:'助手'});
  props.node.data.turn=7;props.node.data.step=2;props.node.location={turn:node.location.turn};
  props.turnProcess=process;
  const response=mount(skin.createAssistantSkin(),props);
  assert.equal(findAll(response.tree,n=>hasProp(n,'data-sl-message')).length,1);
  const heading=findOne(response.tree,n=>host(n,'button') && n.props.className?.includes('sl-heading-process'),'streaming status');
  assert.match(textOf(heading),/思考中/);
  assert.equal(heading.props['data-sl-running'],true);
  props.node.data.blocks=[];
  const empty=mount(skin.createAssistantSkin(),props);
  assert.equal(findAll(empty.tree,n=>hasProp(n,'data-sl-message')).length,0);
});

test('live process renders one expandable bubble while retaining a safe original-process escape', () => {
  const node=makeTurnNode({status:'running'}); node.data.turn=7;
  const props={node,skinAuthor:'助手',turnProcess:makeTurnProcess(),useTurnSteps:()=>[{step:1,time:10,blocks:[{kind:'reasoning',text:'思考'}]}],useTurnTools:()=>[{root:{kind:'tool-result',callId:'x',name:'read',time:20}}],renderFactorySlot:()=>null};
  const view=mount(skin.TurnProcessSkin,props);
  const heading=findOne(view.tree,n=>host(n,'button') && n.props.className?.includes('sl-heading-process'),'live heading');
  assert.match(textOf(heading),/思考中/);
  assert.equal(heading.props['data-sl-running'],'');
  const style=findOne(view.tree,n=>host(n,'style'),'scoped native grouping');
  assert.match(textOf(style),/data-state\]:not\(\[data-state="ok"\]\)/);
  assert.match(textOf(style),/data-approval/);
  assert.match(textOf(style),/data-chat-turn="7"/);
  heading.props.onClick();view.render();
  const original=findOne(view.tree,n=>host(n,'button') && textOf(n)==='查看原有过程','original process');
  original.props.onClick();view.render();
  assert.equal(findAll(view.tree,n=>host(n,'style')).length,0,'user can reveal native tool details');
});

test('TurnProcess renders one summary line and toggles its disclosure', () => {
  const turnProcess = makeTurnProcess();
  const view = mount(skin.TurnProcessSkin, { node: makeTurnNode(), turnProcess });
  let button = turnButton(view.tree);
  assert.equal(button.props['data-turn-process'], 7);
  assert.equal(button.props['aria-expanded'], false);
  assert.equal(button.props.disabled, false);
  const label = textOf(button);
  assert.match(label, /耗时 2 分 5 秒 · 9 次思考 · 8 次工具/);
  assert.doesNotMatch(label, /\n/);
  const distinct = mount(skin.TurnProcessSkin, { node: makeTurnNode({ messageCount: 99, reasoningCount: 2 }), turnProcess: makeTurnProcess() });
  assert.match(textOf(turnButton(distinct.tree)), /2 次思考/);
  assert.doesNotMatch(textOf(turnButton(distinct.tree)), /99 次思考/);

  button.props.onClick();
  view.render();
  button = turnButton(view.tree);
  assert.equal(button.props['aria-expanded'], true);
  assert.equal(turnProcess.calls[0], true);
  button.props.onClick();
  assert.deepEqual(turnProcess.calls, [true, false]);

  const errorView = mount(skin.TurnProcessSkin, { node: makeTurnNode({ reason: 'error' }), turnProcess: makeTurnProcess() });
  assert.match(textOf(turnButton(errorView.tree)), /^执行失败 · 耗时 2 分 5 秒/);

  const openView = mount(skin.TurnProcessSkin, { node: makeTurnNode({ status: 'running' }), turnProcess: makeTurnProcess(), skinAuthor:'助手' });
  assert.match(textOf(openView.tree), /思考中/);
  assert.equal(findAll(openView.tree, node => hasProp(node, 'data-sl-message')).length, 1);

  const disabledView = mount(skin.TurnProcessSkin, {
    node: makeTurnNode(),
    turnProcess: makeTurnProcess({ foldable: false, hasContent: false }),
  });
  const disabledButton = turnButton(disabledView.tree);
  assert.equal(disabledButton.props.disabled, true);
  assert.equal(disabledButton.props['aria-expanded'], undefined);
});

test('renderers and slot registration do not touch the DOM', () => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'document');
  try {
    Object.defineProperty(globalThis, 'document', {
      configurable: true,
      get() {
        throw new Error('rendering must not touch the DOM');
      },
    });
    installFixture();
    const user = makeUserFixture('short');
    const userView = mount(skin.createUserSkin(user.Native), user.props);
    const assistant = makeAssistantFixture({ blocks: [{ kind: 'text', text: 'short' }], skinAuthor: '设计评审' });
    const assistantView = mount(skin.createAssistantSkin(), assistant.props);
    const messageView = mount(ui.MessageBubble, { author: '王墨', text: 'short' });
    const turnView = mount(skin.TurnProcessSkin, { node: makeTurnNode(), turnProcess: makeTurnProcess() });
    assert.ok(userView.tree.length > 0);
    assert.ok(assistantView.tree.length > 0);
    assert.ok(messageView.tree.length > 0);
    assert.ok(turnView.tree.length > 0);
  } finally {
    restoreDocument(descriptor);
  }
});
