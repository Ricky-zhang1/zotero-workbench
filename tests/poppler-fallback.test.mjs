/**
 * poppler 回退解析器离线测试（node:test，无 Zotero、无网络）。
 *
 * 运行：`node tests/poppler-fallback.test.mjs`（或 `node --test tests/*.test.mjs`）
 *
 * 覆盖：pdftotext -bbox XHTML 解析（实体解码/坏页面）、compact 逐字匹配（跨词/跨行）、
 * PDF 用户空间 rect 转换（y 翻转 + 3 位小数）、找不到/poppler 缺失错误、
 * pdfjs 页文本退化判定，以及用假 pdftotext 脚本跑通 verifyQuoteWithPoppler 的进程调用链。
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  buildPageText,
  extractPageTextWithPoppler,
  isPdfjsPageTextDegraded,
  matchQuoteInPopplerPage,
  parsePagesSpec,
  parsePopplerBbox,
  verifyQuoteWithPoppler,
} from '../src/server.mjs'

const SAMPLE_XHTML = `<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.0 Transitional//EN" "http://www.w3.org/TR/xhtml1/DTD/xhtml1-transitional.dtd">
<html xmlns="http://www.w3.org/1999/xhtml"><head><title></title></head><body><doc>
  <page width="600.123456" height="800.500000">
    <word xMin="100.123456" yMin="100.000000" xMax="200.000000" yMax="112.000000">公办和民办学校</word>
    <word xMin="200.000000" yMin="100.000000" xMax="300.000000" yMax="112.000000">教师流动现象探析</word>
    <word xMin="100.000000" yMin="120.000000" xMax="260.000000" yMax="132.000000">第二行 &amp; 实体 &#x7B2C; 测试</word>
  </page>
</doc></body></html>`

test('parsePopplerBbox 解析页面尺寸/词坐标/HTML 实体', () => {
  const page = parsePopplerBbox(SAMPLE_XHTML)
  assert.equal(page.width, 600.123456)
  assert.equal(page.height, 800.5)
  assert.equal(page.words.length, 3)
  assert.deepEqual(
    page.words.map((word) => word.text),
    ['公办和民办学校', '教师流动现象探析', '第二行 & 实体 第 测试'],
  )
  assert.equal(page.words[0].xMin, 100.123456)
  assert.equal(page.words[0].yMax, 112)
})

test('parsePopplerBbox 对缺少 page/尺寸的坏输入报 quote_unverifiable', () => {
  assert.throws(() => parsePopplerBbox('<html><body></body></html>'), (error) => error.code === 'quote_unverifiable')
  assert.throws(
    () => parsePopplerBbox('<page width="oops" height="800"></page>'),
    (error) => error.code === 'quote_unverifiable',
  )
})

test('matchQuoteInPopplerPage 跨词逐字匹配，rect 转 PDF 用户空间并保留 3 位小数', () => {
  const page = parsePopplerBbox(SAMPLE_XHTML)
  const matched = matchQuoteInPopplerPage(page, '公办和民办学校教师流动现象探析')
  assert.equal(matched.quoteExact, '公办和民办学校教师流动现象探析')
  // pdftotext y 轴向下 → PDF 用户空间 y 轴向上：y = H - yMax / H - yMin。
  assert.deepEqual(matched.rects, [[100.123, 800.5 - 112, 300, 800.5 - 100]])
})

test('matchQuoteInPopplerPage 跨行匹配返回逐行矩形，并支持实体/间隔写法', () => {
  const page = parsePopplerBbox(SAMPLE_XHTML)
  const crossLine = matchQuoteInPopplerPage(page, '教师流动现象探析 第二行')
  assert.equal(crossLine.rects.length, 2)
  assert.deepEqual(crossLine.rects[0], [200, 688.5, 300, 700.5])
  assert.deepEqual(crossLine.rects[1], [100, 668.5, 260, 680.5])
  assert.match(crossLine.quoteExact, /第二行/)

  const withEntity = matchQuoteInPopplerPage(page, '第二行 & 实体 第 测试')
  assert.equal(withEntity.quoteExact, '第二行 & 实体 第 测试')
  assert.equal(withEntity.rects.length, 1)

  // 全角/NFKC 归一化：全角数字与半角数字等价。
  const fullwidthPage = parsePopplerBbox(SAMPLE_XHTML.replace('第二行', '２０２１年第二行'))
  const nfkc = matchQuoteInPopplerPage(fullwidthPage, '2021年第二行')
  assert.ok(nfkc.rects.length >= 1)
})

test('matchQuoteInPopplerPage 找不到时报 quote_not_found', () => {
  const page = parsePopplerBbox(SAMPLE_XHTML)
  assert.throws(
    () => matchQuoteInPopplerPage(page, '这句话在页面上绝对不存在 qwertyuiop'),
    (error) => error.code === 'quote_not_found',
  )
  assert.throws(
    () => matchQuoteInPopplerPage(parsePopplerBbox('<page width="600" height="800"></page>'), '任意引文内容'),
    (error) => error.code === 'quote_not_found',
  )
})

test('isPdfjsPageTextDegraded 识别丢字页与正常页', () => {
  // 7Q7377UF 这类页：只剩标点/全角数字与少量页眉英文。
  const degraded = '６０ ４ （ ） ２０２１ ７\nＶｏｌ．６０ Ｎｏ．４ Ｊｏｕｒｎａｌｏｆ\n（１． ， １０２６１７；２． 、 ， １００８７５）\n， 。 “ ” 、\n； ， ，\n。 ， ，\n'
  assert.equal(isPdfjsPageTextDegraded(degraded), true)
  assert.equal(isPdfjsPageTextDegraded(''), true)
  assert.equal(isPdfjsPageTextDegraded('短文本'), true)
  const normal = '教师流动是义务教育政策和实践中的重要议题，已有研究主要聚焦政策驱动下的教师交流和城乡之间的教师流动，而对公办和民办学校之间的教师流动研究较少。'
  assert.equal(isPdfjsPageTextDegraded(normal), false)
})

test('verifyQuoteWithPoppler 通过 pdftotext 进程调用链返回 poppler 结果', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'zotero-wb-fake-pdftotext-'))
  const previous = process.env.PDFTOTEXT_PATH
  try {
    const binary = join(dir, 'pdftotext')
    await writeFile(binary, `#!/bin/sh\ncat <<'XML'\n${SAMPLE_XHTML}\nXML\n`, 'utf8')
    await chmod(binary, 0o755)
    process.env.PDFTOTEXT_PATH = binary
    const matched = await verifyQuoteWithPoppler({ path: join(dir, 'fake.pdf'), page: 3, quote: '公办和民办学校教师流动现象探析' })
    assert.equal(matched.textSource, 'poppler')
    assert.equal(matched.pageIndex, 2)
    assert.equal(matched.pageLabel, '3')
    assert.equal(matched.pageWidth, 600.123456)
    assert.equal(matched.pageHeight, 800.5)
    assert.ok(matched.rects.length >= 1)

    await assert.rejects(
      () => verifyQuoteWithPoppler({ path: join(dir, 'fake.pdf'), page: 1, quote: '不存在的内容 abcdefgh' }),
      (error) => error.code === 'quote_not_found',
    )
  } finally {
    if (previous === undefined) delete process.env.PDFTOTEXT_PATH
    else process.env.PDFTOTEXT_PATH = previous
    await rm(dir, { recursive: true, force: true })
  }
})

test('verifyQuoteWithPoppler 在 poppler 缺失时报 quote_unverifiable 并附原因', async () => {
  const previous = process.env.PDFTOTEXT_PATH
  process.env.PDFTOTEXT_PATH = '/nonexistent/pdftotext-for-tests'
  try {
    await assert.rejects(
      () => verifyQuoteWithPoppler({ path: '/nonexistent/fake.pdf', page: 1, quote: '任意逐字引文内容' }),
      (error) => error.code === 'quote_unverifiable' && /poppler|pdftotext/.test(error.message),
    )
  } finally {
    if (previous === undefined) delete process.env.PDFTOTEXT_PATH
    else process.env.PDFTOTEXT_PATH = previous
  }
})

// ---------------------------------------------------------------------------
// read_page_text 辅助函数
// ---------------------------------------------------------------------------

test('parsePagesSpec 解析 1 / 2-5 / 1,4-6 等 pages 规格', () => {
  assert.deepEqual(parsePagesSpec('1', 7), [1])
  assert.deepEqual(parsePagesSpec('2-5', 7), [2, 3, 4, 5])
  assert.deepEqual(parsePagesSpec('1,4-6', 10), [1, 4, 5, 6])
  assert.deepEqual(parsePagesSpec('3-3', 7), [3])
  assert.deepEqual(parsePagesSpec(' 1 , 4-5 ', 7), [1, 4, 5])
  assert.deepEqual(parsePagesSpec('5,2-3,2', 7), [2, 3, 5])
})

test('parsePagesSpec 对非法/越界/过多页报 invalid_input', () => {
  const expectInvalid = (spec, pageCount) => assert.throws(
    () => parsePagesSpec(spec, pageCount),
    (error) => error.code === 'invalid_input',
  )
  expectInvalid('', 7)
  expectInvalid('  ', 7)
  expectInvalid('0', 7)
  expectInvalid('5-3', 7)
  expectInvalid('a', 7)
  expectInvalid('1,,2', 7)
  expectInvalid('1-', 7)
  expectInvalid('8', 7)
  expectInvalid('1-60', 100)
})

test('buildPageText 拼接 --- page N --- 段落并支持 maxChars 截断', () => {
  const entries = [
    { page: 1, pageLabel: '1', text: '第一页文本' },
    { page: 2, pageLabel: 'ii', text: '第二页文本' },
  ]
  const full = buildPageText(entries, 10000)
  assert.equal(full.truncated, false)
  assert.match(full.text, /^--- page 1 ---\n第一页文本\n\n--- page 2 ---\n第二页文本$/)
  assert.deepEqual(full.pages, [
    { page: 1, pageLabel: '1', chars: 5 },
    { page: 2, pageLabel: 'ii', chars: 5 },
  ])

  const cut = buildPageText(entries, 30)
  assert.equal(cut.truncated, true)
  assert.ok(cut.text.length <= 30)
  // 第二页只包含了一部分，但它确实出现在 text 里，所以 pages 里也列出。
  assert.equal(cut.pages.length, 2)

  const zero = buildPageText(entries, 5)
  assert.equal(zero.truncated, true)
  assert.ok(zero.text.length <= 5)
})

test('extractPageTextWithPoppler 使用 -layout 提取并清理行尾空白，缺失时报 quote_unverifiable', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'zotero-wb-layout-pdftotext-'))
  const previous = process.env.PDFTOTEXT_PATH
  try {
    const binary = join(dir, 'pdftotext')
    await writeFile(
      binary,
      "#!/bin/sh\ncase \"$*\" in *-layout*) printf '公办和民办学校教师流动现象探析   \\n第二行文本\\n\\n\\n';; *) printf 'WRONG ARGS';; esac\n",
      'utf8',
    )
    await chmod(binary, 0o755)
    process.env.PDFTOTEXT_PATH = binary
    const text = await extractPageTextWithPoppler({ path: join(dir, 'fake.pdf'), page: 1 })
    assert.match(text, /^公办和民办学校教师流动现象探析\n第二行文本$/)
    assert.ok(!text.includes('WRONG ARGS'))

    process.env.PDFTOTEXT_PATH = join(dir, 'missing-pdftotext')
    await assert.rejects(
      () => extractPageTextWithPoppler({ path: join(dir, 'fake.pdf'), page: 1 }),
      (error) => error.code === 'quote_unverifiable' && /poppler/.test(error.message),
    )
  } finally {
    if (previous === undefined) delete process.env.PDFTOTEXT_PATH
    else process.env.PDFTOTEXT_PATH = previous
    await rm(dir, { recursive: true, force: true })
  }
})
