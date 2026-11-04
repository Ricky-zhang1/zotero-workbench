import assert from 'node:assert/strict'
import test from 'node:test'

import {
  buildCollaborationPrompt,
  collaborationSourceSelector,
  collaborationSourceStatus,
  openCollaborationSource,
  submitToCurrentSession,
} from '../web/lib/collaboration-view.js'
import { collaborationRequestEnvelope } from '../web/lib/collaboration-api.js'

const annotation = {
  id: '0123456789abcdef',
  library: 'user',
  itemKey: 'ABCDEFGH',
  attachmentKey: 'IJKLMNOP',
  key: 'QRSTUVWX',
  kind: 'highlight',
  fingerprint: 'a'.repeat(64),
  title: '示例论文',
  text: '原文引句',
  comment: '研究者批注',
  pageIndex: 3,
  pageLabel: '4',
  stale: false,
}

test('collaboration source selectors preserve annotation and note identity plus live fingerprint', () => {
  assert.deepEqual(collaborationSourceSelector(annotation), {
    library: 'user', itemKey: 'ABCDEFGH', attachmentKey: 'IJKLMNOP', annotationKey: 'QRSTUVWX', fingerprint: 'a'.repeat(64),
  })
  assert.deepEqual(collaborationSourceSelector({ ...annotation, kind: 'note', attachmentKey: null, key: 'ZYXWVUTS' }), {
    library: 'user', itemKey: 'ABCDEFGH', noteKey: 'ZYXWVUTS', fingerprint: 'a'.repeat(64),
  })
  assert.throws(() => collaborationSourceSelector({ ...annotation, fingerprint: '' }), /指纹/)
})

test('collaboration API adapter sends action and args to the shared endpoint contract', () => {
  const args = { action: 'list', limit: 10 }
  assert.deepEqual(collaborationRequestEnvelope('session', args), { action: 'session', args })
  assert.throws(() => collaborationRequestEnvelope('unknown', args), /不支持/)
  assert.throws(() => collaborationRequestEnvelope('session', []), /对象/)
})

test('collaboration prompt includes selected material verbatim and stores ordinary citation text with sourceIds out of band', () => {
  const prompt = buildCollaborationPrompt({
    session: { id: 'b'.repeat(24), revision: 4, sources: [annotation] },
    task: '比较两项研究的结论。',
  })
  assert.match(prompt, /比较两项研究的结论。/)
  assert.match(prompt, /原文引句/)
  assert.match(prompt, /研究者批注/)
  assert.match(prompt, /"pdfPhysicalPage": 4/)
  assert.match(prompt, /"printedPageLabel": "4"/)
  assert.match(prompt, /collaboration_draft/)
  assert.match(prompt, /0123456789abcdef/)
  assert.match(prompt, /常规文内引用格式/)
  assert.match(prompt, /开始工作前先调用 collaboration_session/)
  assert.match(prompt, /不要声称草稿已经保存/)
  assert.throws(() => buildCollaborationPrompt({ session: { ...{ id: 'b'.repeat(24), revision: 4 }, sources: [{ ...annotation, stale: true }] }, task: '开始写。' }), /过期/)
  assert.throws(() => buildCollaborationPrompt({ session: { id: 'b'.repeat(24), revision: 4, sources: [annotation] }, task: ' ' }), /任务/)
})

test('collaboration submit binds delivery to the freshly read current DSH session', async () => {
  const calls = []
  const bridge = {
    async currentSession() { calls.push('current'); return { payload: { session: { key: 'dsh-session-9', label: '当前对话' } } } },
    async submitCollaboration(payload) { calls.push(payload); return { ok: true, message: '已发送' } },
  }
  const result = await submitToCurrentSession(bridge, '协作任务')
  assert.deepEqual(calls, ['current', { targetSessionKey: 'dsh-session-9', text: '协作任务' }])
  assert.equal(result.session.label, '当前对话')
  assert.equal(result.message, '已发送')
})

test('missing host collaboration capabilities fail explicitly without fallback delivery', async () => {
  const bridge = { async currentSession() { const error = new Error('host unavailable'); error.code = 'host-capability-missing'; throw error } }
  await assert.rejects(submitToCurrentSession(bridge, '不要转交其他模型'), /宿主未提供|host unavailable/)
})

test('source navigation opens the exact selected Zotero material through the host callback', async () => {
  const calls = []
  await openCollaborationSource(annotation, async (source) => calls.push(source))
  assert.equal(calls.length, 1)
  assert.equal(calls[0].itemKey, 'ABCDEFGH')
  assert.equal(calls[0].key, 'QRSTUVWX')
  assert.equal(calls[0].attachmentKey, 'IJKLMNOP')
  await assert.rejects(openCollaborationSource(annotation, null), /原文跳转/)
})

test('historical draft sources show explicit changed or unreadable status', () => {
  assert.equal(collaborationSourceStatus({ stale: false }), '')
  assert.match(collaborationSourceStatus({ stale: true, staleReason: 'fingerprint_changed' }), /原摘录已变化/)
  assert.match(collaborationSourceStatus({ stale: true, staleReason: 'read_failed' }), /不可读取/)
  assert.match(collaborationSourceStatus({ stale: true, staleReason: 'source_missing' }), /已删除或无法定位/)
})
