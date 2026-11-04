import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeVenue, parseExtraLevels, recognizedRankTags, journalLevelsForItem, levelsFromEasyScholar, fetchEasyScholarRank } from '../src/domain/journal-levels.mjs';

test('venue normalization removes whitespace, fullwidth punctuation and case', () => {
  assert.equal(normalizeVenue('《经 济　研究》 Economic Research, 2020!'), '经济研究economicresearch2020');
  assert.equal(normalizeVenue('  Journal of  Education  '), 'journalofeducation');
  assert.equal(normalizeVenue(null), '');
});

test('extra parsing keeps multiple ranks on one line and ignores unrelated lines', () => {
  const levels = parseExtraLevels('北大核心；CSSCI扩展版\n中科院2区 JCR:Q1 IF=2.3\nGSCC: 0000000 2026-06-30 0.00\n中文标题: 测试');
  assert.deepEqual(levels.map(l => l.label), ['CSSCI 扩展版', '北大核心', '中科院二区', 'JCR Q1', 'IF 2.3']);
  assert.deepEqual(parseExtraLevels(''), []);
  assert.deepEqual(parseExtraLevels(null), []);
});

test('extra parsing recognizes plain and abbreviated rank tokens', () => {
  const labels = parseExtraLevels('CSSCI\nSSCI\nSCIE\nESCI\nA&HCI\nAMI\n中文核心').map(l => l.label);
  assert.deepEqual(labels, ['CSSCI', 'SSCI', 'SCI', 'ESCI', 'A&HCI', 'AMI', '北大核心']);
});

test('CSSCI does not trigger the SSCI substring', () => {
  assert.deepEqual(parseExtraLevels('CSSCI').map(l => l.label), ['CSSCI']);
  assert.deepEqual(recognizedRankTags(['cssci', 'GIF 2.1']).map(l => l.label), ['CSSCI']);
});

test('rank parsing rejects negative values per separated rank and preserves unrelated positive grades', () => {
  const extra = [
    'CSSCI/南大核心: 否',
    'SSCI: 未收录',
    'AMI: no',
    'SCI: false',
    'ESCI: 0',
    '中文核心期刊/北大核心: 否',
    'CSSCI否；北大核心是',
    '中文核心期刊/北大核心: 是',
    'CSSCI扩展版；SSCI: 未收录',
    'JCR: Q2; IF: 10'
  ].join('\n');
  assert.deepEqual(parseExtraLevels(extra).map(level => level.label), [
    '北大核心', 'CSSCI 扩展版', 'JCR Q2', 'IF 10'
  ]);
  assert.deepEqual(parseExtraLevels('IF: 0; SCI: 10; CSSCI: false').map(level => level.label), ['SCI']);
  assert.deepEqual(parseExtraLevels('中文标题: CSSCI期刊研究'), [], 'title prose is not a rank declaration');
  assert.deepEqual(recognizedRankTags(['CSSCI/南大核心:否', '北大核心:是', 'SSCI no']).map(level => level.label), ['北大核心']);
});

test('tag recognition dedupes and accepts {tag} objects or strings', () => {
  assert.deepEqual(recognizedRankTags(['SSCI', { tag: 'ssci' }, '随便一个标签', '中科院一区']).map(l => l.label), ['SSCI', '中科院一区']);
  assert.deepEqual(recognizedRankTags(undefined), []);
});

test('item levels merge extra and tags with zotero provenance', () => {
  const fromFields = journalLevelsForItem({ fields: { extra: 'CSSCI' }, tags: ['北大核心'] });
  assert.deepEqual(fromFields.levels.map(l => l.label), ['CSSCI', '北大核心']);
  assert.equal(fromFields.source, 'zotero');
  const fromRaw = journalLevelsForItem({ data: { extra: 'JCR: Q2', tags: [{ tag: 'SSCI' }] } });
  assert.deepEqual(fromRaw.levels.map(l => l.label), ['JCR Q2', 'SSCI']);
});

test('easyScholar rank mapping keeps known keys and preserves unknown ones', () => {
  const levels = levelsFromEasyScholar({ cssci: 'Y', pku: 'Y', scie: 'Q1', someNewRank: '3', empty: '' });
  assert.deepEqual(levels.map(l => l.label), ['CSSCI', '北大核心', 'SCI', 'someNewRank 3']);
  assert.equal(levelsFromEasyScholar(null).length, 0);
});

test('easyScholar query fails cleanly without key and maps auth errors', async () => {
  await assert.rejects(fetchEasyScholarRank('经济研究', ''), /secretKey/);
  await assert.rejects(fetchEasyScholarRank(' ', 'k'.repeat(8)), /期刊名/);
  const forbidden = new Response('denied', { status: 403 });
  await assert.rejects(fetchEasyScholarRank('经济研究', 'k'.repeat(8), () => Promise.resolve(forbidden)), /secretKey/);
  const badCode = new Response(JSON.stringify({ code: 40100, msg: 'invalid key' }), { status: 200 });
  await assert.rejects(fetchEasyScholarRank('经济研究', 'k'.repeat(8), () => Promise.resolve(badCode)), /invalid key/);
  const ok = new Response(JSON.stringify({ code: 0, data: { rank: { cssci: 'Y' } } }), { status: 200 });
  const result = await fetchEasyScholarRank('经济研究', 'k'.repeat(8), () => Promise.resolve(ok));
  assert.equal(result.source, 'easyscholar');
  assert.deepEqual(result.levels.map(l => l.label), ['CSSCI']);
});
