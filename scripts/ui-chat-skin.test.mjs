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
  if (type === React.Fragment) return renderNodes(props?.children, context, `${pathName}.fragment`);
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

function nativeEntry(key, priority, inject, locale = 'chat') {
  return {
    options: { key, priority },
    component: function NativeMarker() {
      return React.createElement('div', { 'data-native-marker': key });
    },
    inject,
    locale,
    children: { [`${key}-child`]: { kind: 'single', scope: 'session' } },
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

function installFixture(entries = makeNativeEntries().entries) {
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
        const cleanup = callback();
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
        getSnapshot: () => ({ byId: { 'sess-1': { title: '设计评审' } } }),
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
  const header = findOne(article, (node) => host(node, 'header') && hasProp(node, 'data-sl-author'), 'author header');
  const bubbles = findAll(article, (node) => hasProp(node, 'data-sl-bubble'));
  assert.equal(bubbles.length, 1, 'exactly one bubble');
  assert.equal(header.parent, article, 'author header is a direct child of the message row');
  assert.equal(bubbles[0].parent, article, 'bubble is a direct child of the message row');
  assert.ok(article.children.indexOf(header) >= 0);
  assert.ok(article.children.indexOf(bubbles[0]) > article.children.indexOf(header), 'header sits above the bubble');
  assert.match(textOf(header), new RegExp(author));
  return { article, header, bubble: bubbles[0] };
}

/* ── Tests ───────────────────────────────────────────────────────────────── */

test('bundles chat-skin.jsx and chat-ui.jsx in memory with CSS text and a primitive stub', () => {
  assert.deepEqual(Object.keys(skin).sort(), ['TurnProcessSkin', 'createAssistantSkin', 'createUserSkin', 'installChatSkin']);
  assert.equal(typeof ui.MessageBubble, 'function');
  assert.equal(typeof ui.MessageText, 'function');
  assert.equal(typeof skin.installChatSkin, 'function');
});

test('install registers keyed wrappers with native key, priority-5 and no redeclared children', () => {
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

  assert.equal(fixture.injections.length, 1);
  assert.equal(fixture.injections[0].name, 'conversation.chat.flow');
  assert.deepEqual(fixture.registers.map(({ options }) => options.key), ['user', 'steering', 'assistant-step', 'turn-process']);
  const expectedPriority = { user: 5, steering: 2, 'assistant-step': -2, 'turn-process': -4 };
  for (const { options, component } of fixture.registers) {
    assert.equal(options.name, 'conversation.chat.node');
    assert.equal(options.priority, expectedPriority[options.key]);
    assert.equal(options.locale, 'chat');
    assert.equal(typeof options.inject, 'function');
    assert.equal(typeof component, 'function');
    assert.equal(Object.hasOwn(options, 'children'), false, `${options.key} must not redeclare native children`);
  }

  const userComponent = fixture.registers.find(({ options }) => options.key === 'user').component;
  const nativeView = mount(userComponent, {
    renderFactorySlot: () => null,
    node: { data: { content: { text: 'short', attachments: [] } } },
  });
  assert.equal(findAll(nativeView.tree, (node) => hasProp(node, 'data-native-marker')).length, 1, 'the registered user wrapper keeps the native component');

  fixture.injections[0].cleanup();
  assert.deepEqual(fixture.stops, ['turn-process', 'assistant-step', 'steering', 'user']);
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
  assert.deepEqual(assistant.inject('sess-1'), { hooks: { assistant: true }, skinAuthor: '设计评审' });
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

test('user skin keeps Native and original props, folds the content factory, and copies the original text', () => {
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
  assert.equal(contentCalls[0].input.content.text, 'x'.repeat(600), 'display factory receives the preview');
  assert.equal(contentCalls[0].input.content.attachments, fixture.props.node.data.content.attachments);
  assert.equal(contentCalls[0].rest[0], 'native-rest', 'extra factory arguments are forwarded');

  const copyButton = findOne(view.tree, (node) => host(node, 'button') && hasProp(node, 'data-copy-original'), 'original copy button');
  assert.equal(copyButton.props['data-copy-original'], long);
  copyButton.props.onClick();
  assert.deepEqual(fixture.copied, [long], 'copy uses the untouched original text');

  const { article, bubble } = assertSingleBubbleSibling(view.tree, '王墨');
  const nativeNode = findOne(article, (node) => hasProp(node, 'data-native'), 'native renderer');
  assert.ok(hasAncestor(nativeNode, (node) => node === bubble), 'Native stays below the single bubble');

  const foldButton = findOne(view.tree, (node) => host(node, 'button') && textOf(node).includes('显示全部'), 'fold button');
  assert.equal(foldButton.props['aria-expanded'], false);
  foldButton.props.onClick();
  view.render();

  const expandedCalls = fixture.factoryCalls.filter((call) => call.name === 'conversation.chat.user.content');
  assert.equal(expandedCalls.at(-1).input.content.text, long, 'expanded display passes the original text');
  const collapseButton = findOne(view.tree, (node) => host(node, 'button') && textOf(node).includes('收起'), 'collapse button');
  assert.equal(collapseButton.props['aria-expanded'], true);
  assert.equal(fixture.nativeProps.at(-1).node, fixture.props.node, 'Native keeps the original props after expansion');
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

test('assistant text folds through MessageText, never through the native factory', () => {
  const long = 'y'.repeat(1600);
  markdownCalls.length = 0;
  const fixture = makeAssistantFixture({ blocks: [{ kind: 'text', text: long }], status: 'closed', skinAuthor: '设计评审' });
  const view = mount(skin.createAssistantSkin(), fixture.props);

  assert.equal(fixture.factoryCalls.length, 0, 'text must not go back through the native factory');
  assert.equal(markdownCalls.length, 1);
  assert.equal(markdownCalls[0].text, 'y'.repeat(600));
  assert.equal(markdownCalls[0].streaming, false);
  assertSingleBubbleSibling(view.tree, '设计评审');

  const foldButton = findOne(view.tree, (node) => host(node, 'button') && textOf(node).includes('显示全部'), 'assistant fold button');
  foldButton.props.onClick();
  view.render();
  assert.equal(markdownCalls.at(-1).text, long);
  assert.equal(findAll(view.tree, (node) => host(node, 'button') && textOf(node).includes('收起')).length, 1);
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

  const openView = mount(skin.TurnProcessSkin, { node: makeTurnNode({ status: 'running' }), turnProcess: makeTurnProcess() });
  assert.deepEqual(openView.tree, []);

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
