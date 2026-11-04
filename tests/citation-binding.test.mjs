/**
 * 引文-稿件绑定与稿件审计的离线测试（node:test，无第三方依赖、无 Zotero）。
 *
 * 运行：`node tests/citation-binding.test.mjs`（或 `node --test tests/*.test.mjs`）
 *
 * 覆盖：角标抽取（含无题名/多角标/非法格式）、指纹稳定性、绑定读写、
 * issue 分类（citation_missing / malformed_marker / unbound / doc_changed /
 * fingerprint_missing / binding_orphaned / duplicate_number）、通过态、并发追加。
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { appendFile, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import {
  auditDocument,
  bindCitation,
  bindingsFile,
  clearBindingCache,
  documentFingerprint,
  extractCitationMarkers,
  listBindingsByDoc,
} from '../src/domain/citation-binding.mjs'

async function withStateDir(run) {
  const dir = await mkdtemp(join(tmpdir(), 'zotero-wb-bindings-'))
  const previous = process.env.ZOTERO_WORKBENCH_STATE_DIR
  process.env.ZOTERO_WORKBENCH_STATE_DIR = dir
  clearBindingCache()
  try {
    return await run(dir)
  } finally {
    if (previous === undefined) delete process.env.ZOTERO_WORKBENCH_STATE_DIR
    else process.env.ZOTERO_WORKBENCH_STATE_DIR = previous
    clearBindingCache()
    await rm(dir, { recursive: true, force: true })
  }
}

const DOC = '/tmp/vault/20_项目/论文草稿.md'
const ID_A = 'aaaaaaaaaaaa'
const ID_B = 'bbbbbbbbbbbb'

function marker(n, id, title = '题名') {
  return `[${n}](https://zotero-wb.invalid/c/${id} "${title}")`
}

/** 不带题名的角标（题名可选）。 */
function markerNoTitle(n, id) {
  return `[${n}](https://zotero-wb.invalid/c/${id})`
}

test('extractCitationMarkers 抽取编号、citationId、题名与偏移', () => {
  const text = `前言。编外教师流动性较大${marker(1, ID_A, '编外用师问题治理')}。另见${markerNoTitle(2, ID_B)}。`
  const markers = extractCitationMarkers(text)
  assert.equal(markers.length, 2)
  assert.equal(markers[0].number, 1)
  assert.equal(markers[0].citationId, ID_A)
  assert.equal(markers[0].title, '编外用师问题治理')
  assert.equal(markers[1].number, 2)
  assert.equal(markers[1].citationId, ID_B)
  assert.equal(markers[1].title, '')
  // offset 能定位回原文
  assert.equal(text.slice(markers[0].offset, markers[0].offset + 2), '[1')
})

test('extractCitationMarkers 忽略非角标链接与非法 id', () => {
  const text = [
    '[普通链接](https://example.com)',
    '[1](https://zotero-wb.invalid/c/SHORT)',      // 10 位，不是 12 位
    '[2](https://zotero-wb.invalid/c/ABCDEF123456)', // 大写
    '[3](https://other.invalid/c/aaaaaaaaaaaa)',   // 域名不对
  ].join('\n')
  assert.deepEqual(extractCitationMarkers(text), [])
})

test('extractCitationMarkers 同一 id 重复出现各算一条', () => {
  const text = `${marker(1, ID_A)} 正文 ${marker(1, ID_A)}`
  const markers = extractCitationMarkers(text)
  assert.equal(markers.length, 2)
  assert.equal(markers[0].citationId, markers[1].citationId)
})

test('extractCitationMarkers 排除围栏代码、行内代码与 HTML 注释并保留原文偏移', () => {
  const live = marker(1, ID_A, '正文引文')
  const fencedBackticks = [
    '````md',
    marker(2, ID_B, '代码示例'),
    '```', // 闭合长度不足，仍在围栏内
    marker(3, ID_B, '仍是代码'),
    '````',
  ].join('\n')
  const fencedTildes = ['~~~text', marker(4, ID_B), '~~~~'].join('\n')
  const inline = `示例：\`${marker(5, ID_B, '行内代码')}\`。`
  const commented = `<!-- ${marker(6, ID_B, '注释')} -->`
  const source = [live, fencedBackticks, fencedTildes, inline, commented, marker(7, ID_A, '正文末尾')].join('\n')

  const markers = extractCitationMarkers(source)
  assert.deepEqual(markers.map(({ number }) => number), [1, 7])
  assert.equal(source.slice(markers[0].offset, markers[0].offset + live.length), live)
})

test('行内代码中的 HTML 注释起始符不屏蔽后续正文角标', () => {
  const live = marker(1, ID_A, 'A')
  const source = `例子：\`<!--\`。正文${live}`
  const markers = extractCitationMarkers(source)

  assert.equal(markers.length, 1)
  assert.equal(markers[0].number, 1)
  assert.equal(source.slice(markers[0].offset, markers[0].offset + live.length), live)
})

test('extractCitationMarkers 解析题名中的转义引号', () => {
  const source = `[8](https://zotero-wb.invalid/c/${ID_A} "他说 \\"向前\\"")`
  const markers = extractCitationMarkers(source)
  assert.equal(markers.length, 1)
  assert.equal(markers[0].title, '他说 "向前"')
})

test('documentFingerprint 对相同内容稳定、不同内容不同', () => {
  assert.equal(documentFingerprint('abc'), documentFingerprint('abc'))
  assert.notEqual(documentFingerprint('abc'), documentFingerprint('abd'))
  assert.equal(documentFingerprint(undefined), documentFingerprint(''))
  assert.match(documentFingerprint('abc'), /^[a-f0-9]{64}$/)
})

test('bindCitation 校验必填字段与 citationId 格式', async () => {
  await withStateDir(async () => {
    await assert.rejects(() => bindCitation({ docPath: DOC }), /citationId/)
    await assert.rejects(() => bindCitation({ citationId: ID_A }), /docPath/)
    await assert.rejects(() => bindCitation({ citationId: 'not-hex', docPath: DOC }), /12 位/)
    await assert.rejects(() => bindCitation(null), /必须是对象/)
  })
})

test('bindCitation 落盘后可按稿件读回，同一 id 以最后一条为准', async () => {
  await withStateDir(async () => {
    await bindCitation({ citationId: ID_A, docPath: DOC, claim: '旧论断', docHash: 'h1' })
    await bindCitation({ citationId: ID_A, docPath: DOC, claim: '新论断', docHash: 'h2' })
    await bindCitation({ citationId: ID_B, docPath: '/tmp/other.md' })
    const bindings = await listBindingsByDoc(DOC)
    assert.equal(bindings.length, 1)
    assert.equal(bindings[0].claim, '新论断')
    assert.equal(bindings[0].docHash, 'h2')
    assert.equal(bindings[0].version, 1)
    assert.ok(Number.isFinite(bindings[0].createdAt))
  })
})

test('listBindingsByDoc 对不同路径写法归一化', async () => {
  await withStateDir(async () => {
    await bindCitation({ citationId: ID_A, docPath: DOC })
    const viaRelative = await listBindingsByDoc(resolve(DOC))
    assert.equal(viaRelative.length, 1)
  })
})

test('listBindingsByDoc 空路径返回空数组', async () => {
  await withStateDir(async () => {
    assert.deepEqual(await listBindingsByDoc(''), [])
    assert.deepEqual(await listBindingsByDoc(undefined), [])
  })
})

test('审计通过态：角标存在、引文存在、绑定同指纹', async () => {
  await withStateDir(async () => {
    const text = `编外教师流动性较大${marker(1, ID_A)}。`
    const docHash = documentFingerprint(text)
    await bindCitation({ citationId: ID_A, docPath: DOC, docHash, claim: '编外教师流动性较大' })
    const report = await auditDocument({
      docPath: DOC,
      text,
      lookupCitation: async (id) => (id === ID_A ? { id: ID_A } : null),
    })
    assert.equal(report.total, 1)
    assert.equal(report.unique, 1)
    assert.deepEqual(report.issues, [])
    assert.equal(report.summary.ok, true)
    assert.equal(report.summary.blocking, 0)
  })
})

test('审计报 citation_missing：引文已被清理或伪造', async () => {
  await withStateDir(async () => {
    const text = `论断${marker(1, ID_A)}。`
    await bindCitation({ citationId: ID_A, docPath: DOC })
    const report = await auditDocument({
      docPath: DOC,
      text,
      lookupCitation: async () => null,
    })
    assert.equal(report.summary.ok, false)
    assert.equal(report.issues.length, 1)
    assert.equal(report.issues[0].code, 'citation_missing')
    assert.match(report.issues[0].message, /重新 register_citation/)
  })
})

test('审计报 unbound：有登记但未绑定到稿件', async () => {
  await withStateDir(async () => {
    const text = `论断${marker(1, ID_A)}。`
    const report = await auditDocument({
      docPath: DOC,
      text,
      lookupCitation: async (id) => (id === ID_A ? { id: ID_A } : null),
    })
    assert.equal(report.summary.ok, true) // unbound 是警告，不阻断
    assert.equal(report.issues[0].code, 'unbound')
    assert.equal(report.summary.warnings, 1)
    assert.equal(report.summary.blocking, 0)
  })
})

test('审计对缺少 docHash 的旧绑定报告 fingerprint_missing', async () => {
  await withStateDir(async () => {
    const text = `论断${marker(1, ID_A)}。`
    await bindCitation({ citationId: ID_A, docPath: DOC })
    const report = await auditDocument({
      docPath: DOC,
      text,
      lookupCitation: async (id) => (id === ID_A ? { id: ID_A } : null),
    })
    const issue = report.issues.find(({ code }) => code === 'fingerprint_missing')
    assert.ok(issue, '缺少指纹的绑定必须明确标记为未能核对漂移')
    assert.equal(issue.citationId, ID_A)
    assert.equal(report.summary.warnings, 1)
    assert.equal(report.summary.ok, true)
  })
})

test('审计将损坏的工作台角标标为阻断项并忽略代码与注释示例', async () => {
  await withStateDir(async () => {
    const malformedId = '[2](https://zotero-wb.invalid/c/SHORT "坏 ID")'
    const malformedFormat = `[3](https://zotero-wb.invalid/c/${ID_B} "题名未闭合`
    const rawPrefix = 'https://zotero-wb.invalid/c/not-a-marker'
    const source = [
      marker(1, ID_A),
      malformedId,
      malformedFormat,
      rawPrefix,
      `\`${malformedId}\``,
      `<!-- ${malformedFormat} -->`,
      '```md',
      malformedId,
      '```',
    ].join('\n')
    const report = await auditDocument({
      docPath: DOC,
      text: source,
      lookupCitation: async (id) => (id === ID_A ? { id: ID_A } : null),
    })
    const malformed = report.issues.filter(({ code }) => code === 'malformed_marker')
    assert.equal(malformed.length, 3)
    assert.deepEqual(malformed.map(({ number }) => number), [2, 3, null])
    assert.equal(report.summary.ok, false)
    assert.equal(report.summary.blocking, 3)
    assert.equal(report.total, 4)
  })
})

test('bindCitationFromDocument 从指定稿件计算指纹并拒绝调用方伪造值', async () => {
  const module = await import('../src/domain/citation-binding.mjs')
  assert.equal(typeof module.bindCitationFromDocument, 'function', '服务端绑定 helper 应可隔离测试')

  await withStateDir(async () => {
    const source = `论文正文${marker(1, ID_A)}。\n`
    const expectedPath = resolve(DOC)
    const calls = []
    const openDocument = async (path, flags) => {
      assert.equal(path, expectedPath)
      assert.equal(flags, 'r')
      return {
        stat: async () => { calls.push('stat'); return { size: Buffer.byteLength(source), isFile: () => true } },
        readFile: async () => { calls.push('read'); return Buffer.from(source, 'utf8') },
        close: async () => {},
      }
    }

    const binding = await module.bindCitationFromDocument(
      { citationId: ID_A, docPath: DOC },
      { openDocument },
    )
    assert.equal(binding.docPath, expectedPath)
    assert.equal(binding.docHash, documentFingerprint(source))
    assert.deepEqual(calls, ['stat', 'read'])

    await assert.rejects(
      () => module.bindCitationFromDocument(
        { citationId: ID_B, docPath: DOC, docHash: '0'.repeat(64) },
        { openDocument },
      ),
      /docHash.*不匹配|指纹.*不匹配/,
    )
    assert.equal((await listBindingsByDoc(DOC)).length, 1)
  })
})

test('bindCitationFromDocument 对指定稿件缺失给出明确错误', async () => {
  const module = await import('../src/domain/citation-binding.mjs')
  assert.equal(typeof module.bindCitationFromDocument, 'function', '服务端绑定 helper 应可隔离测试')
  const openDocument = async () => {
    const error = new Error('ENOENT')
    error.code = 'ENOENT'
    throw error
  }
  await assert.rejects(
    () => module.bindCitationFromDocument(
      { citationId: ID_A, docPath: DOC },
      { openDocument },
    ),
    (error) => error.code === 'document_not_found' && /稿件不存在/.test(error.message),
  )
})

test('readMarkdownDocument 校验绝对 Markdown 常规文件并在读取前限制字节数', async () => {
  const module = await import('../src/domain/citation-binding.mjs')
  assert.equal(typeof module.readMarkdownDocument, 'function')
  await assert.rejects(() => module.readMarkdownDocument('relative.md'), /绝对路径/)
  await assert.rejects(() => module.readMarkdownDocument('/tmp/document.txt'), /\.md.*\.markdown/)

  let nonRegularReadCalled = false
  await assert.rejects(
    () => module.readMarkdownDocument('/tmp/directory.markdown', {
      openDocument: async () => ({
        stat: async () => ({ size: 0, isFile: () => false }),
        readFile: async () => { nonRegularReadCalled = true; return Buffer.alloc(0) },
        close: async () => {},
      }),
    }),
    (error) => error.code === 'document_not_regular',
  )
  assert.equal(nonRegularReadCalled, false)

  let readCalled = false
  await assert.rejects(
    () => module.readMarkdownDocument(DOC, {
      maxBytes: 4,
      openDocument: async () => ({
        stat: async () => ({ size: 5, isFile: () => true }),
        readFile: async () => { readCalled = true; return Buffer.from('12345') },
        close: async () => {},
      }),
    }),
    (error) => error.code === 'document_too_large',
  )
  assert.equal(readCalled, false, 'fstat 字节上限应在读入文件内容之前生效')
})

test('审计报 doc_changed：绑定后稿件内容漂移', async () => {
  await withStateDir(async () => {
    const original = `旧论断${marker(1, ID_A)}。`
    await bindCitation({
      citationId: ID_A,
      docPath: DOC,
      docHash: documentFingerprint(original),
    })
    const edited = `完全改写过的论断${marker(1, ID_A)}。`
    const report = await auditDocument({
      docPath: DOC,
      text: edited,
      lookupCitation: async (id) => (id === ID_A ? { id: ID_A } : null),
    })
    assert.equal(report.issues[0].code, 'doc_changed')
    assert.match(report.issues[0].message, /内容指纹已变化/)
    assert.equal(report.summary.blocking, 0)
  })
})

test('审计报 binding_orphaned：绑定还在但角标被删', async () => {
  await withStateDir(async () => {
    await bindCitation({ citationId: ID_A, docPath: DOC })
    const report = await auditDocument({
      docPath: DOC,
      text: '这段已经没有角标了。',
      lookupCitation: async (id) => (id === ID_A ? { id: ID_A } : null),
    })
    assert.equal(report.summary.ok, false)
    assert.equal(report.issues[0].code, 'binding_orphaned')
    assert.equal(report.summary.blocking, 1)
  })
})

test('审计报 duplicate_number：同一编号指向不同引文', async () => {
  await withStateDir(async () => {
    const text = `甲${marker(1, ID_A)}。乙${marker(1, ID_B)}。`
    await bindCitation({ citationId: ID_A, docPath: DOC })
    await bindCitation({ citationId: ID_B, docPath: DOC })
    const report = await auditDocument({
      docPath: DOC,
      text,
      lookupCitation: async (id) => (id === ID_A || id === ID_B ? { id } : null),
    })
    const dup = report.issues.find((issue) => issue.code === 'duplicate_number')
    assert.ok(dup !== undefined)
    assert.deepEqual(dup.citationIds.sort(), [ID_A, ID_B])
    assert.equal(report.summary.ok, false)
  })
})

test('审计空稿件：无角标无绑定时通过', async () => {
  await withStateDir(async () => {
    const report = await auditDocument({
      docPath: DOC,
      text: '',
      lookupCitation: async () => null,
    })
    assert.equal(report.total, 0)
    assert.deepEqual(report.issues, [])
    assert.equal(report.summary.ok, true)
  })
})

test('坏行容错：半行与非 JSON 不影响其它绑定', async () => {
  await withStateDir(async () => {
    await bindCitation({ citationId: ID_A, docPath: DOC })
    await appendFile(bindingsFile(), '{半行\nnot json\n', 'utf8')
    clearBindingCache()
    const bindings = await listBindingsByDoc(DOC)
    assert.equal(bindings.length, 1)
    assert.equal(bindings[0].citationId, ID_A)
  })
})

test('并发追加（O_APPEND 单行写）不丢绑定', async () => {
  await withStateDir(async () => {
    const ids = Array.from({ length: 20 }, (_, index) =>
      index.toString(16).padStart(12, '0'),
    )
    await Promise.all(ids.map((id) => bindCitation({ citationId: id, docPath: DOC })))
    clearBindingCache()
    const bindings = await listBindingsByDoc(DOC)
    assert.equal(bindings.length, 20)
    assert.deepEqual(bindings.map((record) => record.citationId).sort(), [...ids].sort())
  })
})
