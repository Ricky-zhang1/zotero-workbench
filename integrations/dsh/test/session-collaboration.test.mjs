import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import vm from 'node:vm'

const clientSource = await readFile(new URL('../client.js', import.meta.url), 'utf8')

function createHarness({ snapshot, input = null } = {}) {
  const listeners = new Map()
  const replies = []
  const inserted = []
  const calls = { setDraft: [], submit: 0, selectedPanel: [] }
  const components = {}
  const frameSources = {}
  const style = { setAttribute() {}, remove() {} }
  const document = {
    head: { appendChild() {} },
    createElement() { return style },
    querySelectorAll() { return [] },
  }
  const window = {
    location: { origin: 'http://dsh.test' },
    __ModuleLoader__: { load(value) { window.loadedModule = value } },
    addEventListener(type, handler) {
      const entries = listeners.get(type) || []
      entries.push(handler)
      listeners.set(type, entries)
    },
    removeEventListener(type, handler) {
      listeners.set(type, (listeners.get(type) || []).filter((entry) => entry !== handler))
    },
    setTimeout,
    clearTimeout,
  }
  const sessionCtx = {
    emit(type, payload) { inserted.push({ type, payload }) },
  }
  if (snapshot) snapshot.ctx = sessionCtx
  let activeSnapshot = snapshot
  const ctx = {
    slots: {
      inject(_name, callback) { callback(); return () => {} },
      register(descriptor, component) {
        if (descriptor?.name === 'main') components.workspace = component
        return () => {}
      },
    },
    effect(run) { return run() },
    plugin(spec) {
      if (spec.inject?.includes('slots')) {
        spec.apply(ctx)
        return
      }
      spec.apply({
        betterSidebar: { registerTab(tab) { components.reader = tab.component }, openTab() {} },
        effect: ctx.effect,
        plugin: ctx.plugin,
      })
    },
    get(name) {
      if (name === 'uiSession') return { adapter: { current: { getSnapshot: () => activeSnapshot } } }
      if (name === 'conversation') return input ? { input: { for: () => input } } : null
      if (name === 'sessions') return null
      if (name === 'layout') return { selectPanel: (value) => calls.selectedPanel.push(value) }
      if (name === 'betterSidebar') return { registerTab() {}, openTab() {} }
      return null
    },
  }

  const react = {
    createElement: (...args) => args,
    useRef: () => ({ current: null }),
    useEffect: (run) => run(),
  }
  vm.runInNewContext(clientSource, { window, document, URL, Math, Date, setTimeout, clearTimeout })
  const plugin = window.loadedModule.factory((name) => {
    if (name !== 'react') throw new Error(`unexpected require: ${name}`)
    return react
  })
  plugin.apply(ctx)

  function findIframe(node) {
    if (!Array.isArray(node)) return null
    if (node[0] === 'iframe') return node[1]
    for (const child of node.slice(2)) {
      if (Array.isArray(child)) {
        const found = findIframe(child)
        if (found) return found
      }
    }
    return null
  }

  function mountFrame(component, name, props = {}) {
    const tree = component(props)
    const iframe = findIframe(tree)
    assert.ok(iframe?.ref, `${name} iframe ref should be registered`)
    const source = { postMessage(message) { replies.push(message) } }
    iframe.ref.current = { contentWindow: source }
    iframe.onLoad?.()
    frameSources[name] = source
  }

  mountFrame(components.workspace, 'workspace')
  mountFrame(components.reader, 'reader', { visible: true, tab: { path: 'zotero-workbench:reader' } })

  function sendFrom(source, data) {
    for (const handler of listeners.get('message') || []) {
      handler({ origin: window.location.origin, data: { source: 'zotero-workbench', ...data }, source })
    }
    return replies.at(-1)
  }

  function send(data) { return sendFrom(frameSources.workspace, data) }

  return {
    calls,
    inserted,
    replies,
    send,
    sendFrom,
    frameSources,
    setActiveSnapshot(value) { if (value) value.ctx = sessionCtx; activeSnapshot = value },
  }
}

function makeSnapshot(key, calls) {
  return {
    key,
    title: `会话 ${key}`,
    props: { inputActions: { submit() { calls.submit += 1 } } },
    ctx: { emit() {} },
  }
}

function makeInput(state, calls) {
  return {
    state: { getSnapshot: () => state },
    setDraft(value) { calls.setDraft.push(value); state.draft = value },
  }
}

test('current-session handshake exposes the explicit DSH target', () => {
  const calls = { submit: 0, setDraft: [] }
  const harness = createHarness({ snapshot: makeSnapshot('session-17', calls) })

  const hello = harness.send({ type: 'ready', id: 'ready-1' })
  assert.ok(hello.capabilities.includes('current-session'))
  assert.ok(hello.capabilities.includes('collaboration-submit'))
  const result = harness.send({ type: 'current-session', id: 'session-1' })

  assert.equal(result.ok, true)
  assert.equal(result.payload.session.key, 'session-17')
  assert.equal(result.payload.session.label, '会话 session-17')
})

test('current-session and collaboration-submit ignore same-origin messages outside the registered app iframes', () => {
  const calls = { submit: 0, setDraft: [] }
  const state = { draft: '用户已有草稿', occurrences: [], phase: 'editing', draftRev: 5 }
  const harness = createHarness({ snapshot: makeSnapshot('session-17', calls), input: makeInput(state, calls) })
  const before = harness.replies.length
  const forgedSource = { postMessage(message) { harness.replies.push(message) } }

  harness.sendFrom(forgedSource, { type: 'current-session', id: 'forged-read' })
  harness.sendFrom(forgedSource, {
    type: 'collaboration-submit', id: 'forged-submit',
    payload: { targetSessionKey: 'session-17', text: '伪造来源不能写入' },
  })

  assert.equal(harness.replies.length, before)
  assert.equal(state.draft, '用户已有草稿')
  assert.equal(calls.submit, 0)
  assert.equal(calls.setDraft.length, 0)
  const readerResult = harness.sendFrom(harness.frameSources.reader, { type: 'current-session', id: 'reader-read' })
  assert.equal(readerResult.payload.session.key, 'session-17')
})

test('collaboration-submit appends to existing text and sends only to the confirmed current session', () => {
  const calls = { submit: 0, setDraft: [] }
  const state = { draft: '已有草稿', occurrences: [], phase: 'editing', draftRev: 9 }
  const harness = createHarness({ snapshot: makeSnapshot('session-17', calls), input: makeInput(state, calls) })

  const result = harness.send({
    type: 'collaboration-submit',
    id: 'submit-1',
    payload: { targetSessionKey: 'session-17', text: '协作任务与材料' },
  })

  assert.equal(result.ok, true)
  assert.equal(state.draft, '已有草稿 协作任务与材料')
  assert.equal(calls.setDraft.length, 1)
  assert.equal(calls.submit, 1)
})

test('collaboration-submit preserves citation chips through the revision-aware insertion event', () => {
  const calls = { submit: 0, setDraft: [] }
  const state = {
    draft: '已有文字citationlink后文',
    occurrences: [{ offset: 4, length: 12 }],
    phase: 'editing',
    draftRev: 12,
  }
  const harness = createHarness({ snapshot: makeSnapshot('session-21', calls), input: makeInput(state, calls) })

  const result = harness.send({
    type: 'collaboration-submit',
    id: 'submit-chip',
    payload: { targetSessionKey: 'session-21', text: '反馈任务' },
  })

  assert.equal(result.ok, true)
  assert.equal(harness.inserted.length, 1)
  assert.equal(harness.inserted[0].type, 'slash/input-insert-text')
  assert.equal(harness.inserted[0].payload.text, ' 反馈任务')
  assert.equal(harness.inserted[0].payload.span.draftRev, 12)
  assert.equal(harness.inserted[0].payload.span.start, 7)
  assert.equal(harness.inserted[0].payload.span.end, 7)
  assert.equal(calls.setDraft.length, 0)
  assert.equal(calls.submit, 1)
})

test('a switched session rejects a stale target before touching its draft', () => {
  const calls = { submit: 0, setDraft: [] }
  const state = { draft: '另一个会话的草稿', occurrences: [], phase: 'editing', draftRev: 4 }
  const harness = createHarness({ snapshot: makeSnapshot('session-new', calls), input: makeInput(state, calls) })

  const result = harness.send({
    type: 'collaboration-submit',
    id: 'stale-target',
    payload: { targetSessionKey: 'session-old', text: '不能发送到这里' },
  })

  assert.equal(result.ok, false)
  assert.match(result.message, /会话已变化/)
  assert.equal(state.draft, '另一个会话的草稿')
  assert.equal(calls.setDraft.length, 0)
  assert.equal(calls.submit, 0)
})

test('unsupported input APIs never use setDraft(text) as an overwrite fallback', () => {
  const calls = { submit: 0, setDraft: [] }
  const snapshot = makeSnapshot('session-unsupported', calls)
  const harness = createHarness({ snapshot, input: null })
  // The legacy action exists, but the safe conversation input projection does not.
  snapshot.props.inputActions.setDraft = (value) => calls.setDraft.push(value)

  const result = harness.send({
    type: 'collaboration-submit',
    id: 'unsupported-input',
    payload: { targetSessionKey: 'session-unsupported', text: '不可覆盖输入框' },
  })

  assert.equal(result.ok, false)
  assert.match(result.message, /未提供安全的会话输入框接口/)
  assert.equal(calls.setDraft.length, 0)
  assert.equal(calls.submit, 0)
})

test('unversioned citation chips are left untouched when safe insertion is unavailable', () => {
  const calls = { submit: 0, setDraft: [] }
  const snapshot = makeSnapshot('session-chip-legacy', calls)
  const state = { draft: '已有引用chip', occurrences: [{ offset: 4, length: 4 }], phase: 'claimed' }
  const harness = createHarness({ snapshot, input: makeInput(state, calls) })

  const result = harness.send({
    type: 'collaboration-submit',
    id: 'legacy-chip',
    payload: { targetSessionKey: 'session-chip-legacy', text: '不要压扁chip' },
  })

  assert.equal(result.ok, false)
  assert.match(result.message, /无法安全保留引用 chip/)
  assert.equal(state.draft, '已有引用chip')
  assert.equal(calls.setDraft.length, 0)
  assert.equal(calls.submit, 0)
})

test('missing chip position metadata is treated as unsupported instead of rewriting the draft', () => {
  const calls = { submit: 0, setDraft: [] }
  const snapshot = makeSnapshot('session-chip-unknown', calls)
  const state = { draft: '已有草稿', phase: 'editing', draftRev: 3 }
  const harness = createHarness({ snapshot, input: makeInput(state, calls) })

  const result = harness.send({
    type: 'collaboration-submit',
    id: 'unknown-chip-state',
    payload: { targetSessionKey: 'session-chip-unknown', text: '不确定是否有 chip' },
  })

  assert.equal(result.ok, false)
  assert.match(result.message, /未提供有效的引用 chip 位置/)
  assert.equal(state.draft, '已有草稿')
  assert.equal(calls.setDraft.length, 0)
  assert.equal(calls.submit, 0)
})

test('ordinary add-to-chat remains append-only and does not auto-submit', () => {
  const calls = { submit: 0, setDraft: [] }
  const state = { draft: '我的原有草稿', occurrences: [], phase: 'editing', draftRev: 3 }
  const harness = createHarness({ snapshot: makeSnapshot('session-add', calls), input: makeInput(state, calls) })

  const result = harness.send({ type: 'add-to-chat', id: 'add-only', payload: { text: '补充材料' } })

  assert.equal(result.ok, true)
  assert.equal(state.draft, '我的原有草稿 补充材料')
  assert.equal(calls.submit, 0)
})

test('HostBridge returns the current-session payload and refuses undeclared capabilities', async () => {
  const previousWindow = globalThis.window
  const listeners = new Map()
  const sent = []
  const testWindow = {
    location: { origin: 'http://dsh.test' },
    parent: { postMessage(message) { sent.push(message) } },
    crypto: { randomUUID: () => 'uuid-1' },
    addEventListener(type, handler) {
      const entries = listeners.get(type) || []
      entries.push(handler)
      listeners.set(type, entries)
    },
    removeEventListener(type, handler) {
      listeners.set(type, (listeners.get(type) || []).filter((entry) => entry !== handler))
    },
  }
  globalThis.window = testWindow
  try {
    const { HostBridge } = await import('../web/lib/host-bridge.js')
    const bridge = new HostBridge()
    bridge.start()
    const handle = (data) => {
      for (const handler of listeners.get('message') || []) handler({ origin: testWindow.location.origin, data })
    }
    handle({ source: 'zotero-workbench-host', type: 'hello', capabilities: ['current-session'] })

    await assert.rejects(bridge.submitCollaboration({ targetSessionKey: 'session-1', text: '任务' }), /宿主未声明能力/)
    const pending = bridge.currentSession()
    const request = sent.at(-1)
    assert.equal(request.type, 'current-session')
    handle({
      source: 'zotero-workbench-host', type: 'ack', id: request.id, ok: true,
      payload: { session: { key: 'session-1', label: '当前会话' } },
    })
    const result = await pending
    assert.equal(result.payload.session.key, 'session-1')

    handle({ source: 'zotero-workbench-host', type: 'hello', capabilities: ['current-session', 'collaboration-submit'] })
    const submission = bridge.submitCollaboration({ targetSessionKey: 'session-1', text: '提交任务' })
    const submitRequest = sent.at(-1)
    assert.equal(submitRequest.type, 'collaboration-submit')
    assert.equal(submitRequest.payload.targetSessionKey, 'session-1')
    handle({ source: 'zotero-workbench-host', type: 'ack', id: submitRequest.id, ok: true, message: 'sent' })
    assert.equal((await submission).ok, true)
    bridge.stop()
  } finally {
    if (previousWindow === undefined) delete globalThis.window
    else globalThis.window = previousWindow
  }
})
