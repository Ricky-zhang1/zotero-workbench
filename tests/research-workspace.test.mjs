import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import {
  ResearchWorkspace, materialRecord, noteText, validateDraft, validateFoldResult
} from '../src/domain/research-workspace.mjs';
import { installPagination } from '../src/transports/zotero-local.mjs';

const keys = {
  paper1: 'PAPER001', paper2: 'PAPER002', paper3: 'PAPER003',
  annotation: 'ANNOT001', note: 'NOTE0001', attachment: 'PDF00001'
};
const fingerprint = value => createHash('sha256').update(value).digest('hex');
const GUIDE_PROFILE = { profileId: 'social-science-general', profileVersion: '1' };

function guideFixture(pages) {
  const quote = (page, start) => ({ page, quote: pages[page - 1].text.slice(start, start + 40) });
  return {
    ...GUIDE_PROFILE,
    researchQuestion: { items: [{ kind: 'author-claim', text: 'The paper studies district differences.', evidence: [quote(1, 0)] }], gaps: [] },
    argument: { items: [{ kind: 'author-claim', text: 'The authors connect working conditions to retention.', evidence: [quote(1, 5)] }], gaps: [] },
    concepts: { items: [{ kind: 'researcher-prompt', text: 'Compare how the paper defines local constraints.', basedOn: [quote(2, 0)] }], gaps: [] },
    methods: { items: [], gaps: ['材料没有说明识别策略。'] },
    findings: { items: [{ kind: 'author-claim', text: 'Salary policies shape recruitment.', evidence: [quote(2, 0)] }], gaps: [] },
    limitations: { items: [{ kind: 'researcher-prompt', text: 'Check whether these conditions transfer to another setting.', basedOn: [quote(1, 0)] }], gaps: [] },
  };
}

function selectedSource(overrides = {}) {
  return {
    id: '0123456789abcdef', library: 'user', itemKey: keys.paper1, title: 'Study', key: keys.annotation,
    attachmentKey: keys.attachment, kind: 'highlight', text: 'A selected original passage.', comment: 'Reader note',
    pageIndex: 2, pageLabel: '3', color: '#ffff00',
    url: `zotero://open-pdf/library/items/${keys.attachment}?page=3&annotation=${keys.annotation}`,
    modified: '2026-10-29', origin: 'not-inferred', humanSelected: true,
    fingerprint: fingerprint('source'), ...overrides
  };
}

function fakeSession() {
  const rows = new Map([
    [keys.paper1, { key: keys.paper1, data: { itemType: 'journalArticle', title: 'Study One', date: '2024' } }],
    [keys.paper2, { key: keys.paper2, data: { itemType: 'book', title: 'Study Two', date: '2023' } }],
    [keys.paper3, { key: keys.paper3, data: { itemType: 'book', title: 'Study Three', date: '2022' } }]
  ]);
  const note = { key: keys.note, data: { itemType: 'note', note: '<p>Reader note &amp; thought</p>' } };
  const attachment = { key: keys.attachment, data: { itemType: 'attachment' } };
  let annotation = {
    key: keys.annotation,
    data: {
      itemType: 'annotation', annotationType: 'highlight', annotationText: 'Original quoted words.',
      annotationComment: 'Reader interpretation.', annotationPosition: JSON.stringify({ pageIndex: 2 }),
      annotationPageLabel: '3', dateModified: '2026-10-29',
      tags: [{ tag: '类型:研究方法' }, { tag: ' free tag ' }, { tag: 'unsafe\nline' }, { tag: 'x'.repeat(300) }]
    }
  };
  const session = {
    ready: async () => {},
    close() { this.closed = true; },
    library: {
      version: 7,
      async checkVersion() {},
      versionOf() { return this.version; }
    },
    client: {
      async getJson(path) {
        const item = path.match(/\/items\/([A-Z0-9]{8})(?:\/children)?(?:\?|$)/)?.[1];
        if (path.endsWith('/children?itemType=annotation')) return { data: [annotation] };
        if (path.endsWith('/children')) return { data: [note, attachment] };
        if (item && rows.has(item)) return { data: rows.get(item) };
        throw new Error('unexpected request');
      }
    },
    setAnnotation(value) { annotation = value; },
    getAnnotation() { return annotation; }
  };
  return session;
}

function metadataSession({ title = 'Institutional arrangements and local choices',
  abstractNote = 'Institutions shape how local actors use resources and produce long-term outcomes.',
  language = 'en', deleted } = {}) {
  const session = fakeSession();
  const record = {
    key: keys.paper1,
    ...(deleted === undefined ? {} : { deleted }),
    data: {
      key: keys.paper1, itemType: 'journalArticle', title, abstractNote, language,
      ...(deleted === undefined ? {} : { deleted }),
    },
  };
  const originalGetJson = session.client.getJson.bind(session.client);
  session.requestPaths = [];
  session.client.getJson = async path => {
    session.requestPaths.push(path);
    if (path === `/api/users/0/items/${keys.paper1}`) return { data: { ...record, data: { ...record.data } } };
    return originalGetJson(path);
  };
  session.getMetadataRecord = () => record;
  session.updateMetadata = patch => Object.assign(record.data, patch);
  session.pdfTextCalls = 0;
  session.pdfText = async () => { session.pdfTextCalls++; throw new Error('metadata translation must not read a PDF'); };
  return session;
}

async function newStateDir() {
  return mkdtemp(join(tmpdir(), 'zotero-research-test-'));
}

function twoColumnPdf() {
  const content = [
    'BT /F1 12 Tf 1 0 0 1 50 750 Tm (LEFT_FIRST_COLUMN_SENTENCE) Tj 0 -22 Td (LEFT_SECOND_COLUMN_SENTENCE) Tj ET',
    'BT /F1 12 Tf 1 0 0 1 320 750 Tm (RIGHT_FIRST_COLUMN_SENTENCE) Tj 0 -22 Td (RIGHT_SECOND_COLUMN_SENTENCE) Tj ET'
  ].join('\n');
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}\nendstream`
  ];
  const chunks = ['%PDF-1.4\n'];
  const offsets = [0];
  for (let index = 0; index < objects.length; index++) {
    offsets.push(Buffer.byteLength(chunks.join('')));
    chunks.push(`${index + 1} 0 obj\n${objects[index]}\nendobj\n`);
  }
  const xrefOffset = Buffer.byteLength(chunks.join(''));
  chunks.push(`xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`);
  for (const offset of offsets.slice(1)) chunks.push(`${String(offset).padStart(10, '0')} 00000 n \n`);
  chunks.push(`trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`);
  return Buffer.from(chunks.join(''), 'ascii');
}

async function waitForIdle(workspace, id) {
  for (let attempt = 0; attempt < 1000; attempt++) {
    if (!workspace.active.has(id)) return;
    await new Promise(resolve => setTimeout(resolve, 2));
  }
  throw new Error(`job did not settle: ${JSON.stringify(workspace.public(workspace.active.get(id)))}`);
}

function validDraft(source) {
  return { title: 'A short draft', paragraphs: [{ text: 'A supported paragraph.', sourceIds: [source.id] }], gaps: [] };
}

test('source fingerprints preserve annotation text, reader comments, and clickable provenance', async t => {
  const session = fakeSession();
  const dir = await newStateDir();
  t.after(() => rm(dir, { recursive: true, force: true }));
  const workspace = new ResearchWorkspace({ session, stateDir: dir });
  const packet = await workspace.materials({ keys: [keys.paper1, keys.paper2, keys.paper3], limit: 2 });
  assert.equal(packet.total, 3);
  assert.equal(packet.processed, 2);
  assert.equal(packet.nextOffset, 2);
  const next = await workspace.materials({ scopeId: packet.scopeId, offset: packet.nextOffset, limit: 2 });
  assert.equal(next.processed, 3);
  assert.equal(next.nextOffset, null);

  const records = packet.papers[0].records;
  const annotation = records.find(record => record.kind === 'highlight');
  const note = records.find(record => record.kind === 'note');
  assert.equal(annotation.text, 'Original quoted words.');
  assert.equal(annotation.comment, 'Reader interpretation.');
  assert.deepEqual(annotation.tags, [{ tag: '类型:研究方法' }, { tag: 'free tag' }],
    'Zotero string tags are safely returned in the object shape expected by the UI type helper');
  assert.equal(annotation.url, `zotero://open-pdf/library/items/${keys.attachment}?page=3&annotation=${keys.annotation}`);
  assert.equal(note.text, 'Reader note & thought');
  assert.equal(note.comment, '');
  assert.equal(note.url, `zotero://select/library/items/${keys.note}`);
  assert.match(annotation.fingerprint, /^[a-f0-9]{64}$/);

  const selected = await workspace.writingSources({
    keys: [keys.paper1], sourceIds: [annotation.id, note.id],
    sourceVersions: { [annotation.id]: annotation.fingerprint, [note.id]: note.fingerprint }
  });
  assert.deepEqual(selected.map(source => source.humanSelected), [true, true]);
  assert.ok(selected.every(source => source.url.startsWith('zotero://')));
  assert.throws(() => validateDraft({ paragraphs: [{ text: 'Unsupported', sourceIds: ['ffffffffffffffff'] }] }, selected), /范围外来源/);
  const draft = validateDraft({ paragraphs: [{ text: 'Supported', sourceIds: [annotation.id] }] }, selected);
  assert.equal(draft.paragraphs[0].sourceLinks[0].url, annotation.url);
  assert.equal(draft.reviewStatus, 'human-review-required');
  assert.equal(validateDraft({ ...validDraft(annotation), provenance: { model: 'gpt-5.4-codex' } }, selected).provenance.model, 'gpt-5.4-codex');
  assert.throws(() => validateDraft({ ...validDraft(annotation), provenance: { model: 'raw model diagnostics' } }, selected), /模型来源信息无效/);
});

test('writing rejects invalid ids and stale source fingerprints before drafting', async t => {
  const dir = await newStateDir();
  t.after(() => rm(dir, { recursive: true, force: true }));
  const session = fakeSession();
  const workspace = new ResearchWorkspace({ session, stateDir: dir });
  assert.throws(() => workspace.validateWritingArgs({
    keys: [keys.paper1], sourceIds: ['../../etc/passwd'], sourceVersions: {}
  }), /标注编号无效/);
  assert.throws(() => workspace.validateStartArgs({ kind: 'fold', library: '../../', key: keys.paper1 }), /文库/);
  assert.deepEqual(workspace.validateStartArgs({
    kind: 'fold', library: 'user', key: keys.paper1, purpose: 'paragraph', framework: ''
  }), { kind: 'fold', library: 'user', key: keys.paper1 }, 'Zod defaults are accepted and ignored for full-text folding');
  const packet = await workspace.materials({ keys: [keys.paper1], limit: 1 });
  const selected = packet.papers[0].records.find(record => record.kind === 'highlight');
  await assert.rejects(workspace.writingSources({
    keys: [keys.paper1], sourceIds: [selected.id], sourceVersions: { [selected.id]: fingerprint('stale') }
  }), /内容已变化/);
  const staleJob = await workspace.start({
    kind: 'draft', keys: [keys.paper1], sourceIds: [selected.id], sourceVersions: { [selected.id]: fingerprint('stale') }
  });
  await waitForIdle(workspace, staleJob.id);
  const staleStatus = await workspace.status(staleJob.id);
  assert.equal(staleStatus.status, 'failed');
  assert.match(staleStatus.error, /内容已变化/);
  assert.equal(noteText('<p>a<br>b &amp; c</p>'), 'a\nb & c');
});

test('local Zotero pagination reads all child pages and rejects incomplete totals', async () => {
  const requests = [];
  const client = {
    async getJson(path) {
      const url = new URL(path, 'http://127.0.0.1');
      requests.push(Number(url.searchParams.get('start') || 0));
      const start = Number(url.searchParams.get('start') || 0);
      const all = [{ key: 'A' }, { key: 'B' }, { key: 'C' }];
      const data = all.slice(start, start + 2);
      return {
        data,
        response: { headers: { get: name => ({ 'total-results': '3', 'last-modified-version': '7' }[name] ?? null) } }
      };
    }
  };
  installPagination(client);
  const result = await client.getJson('/users/0/items/PAPER001/children');
  assert.deepEqual(result.data.map(row => row.key), ['A', 'B', 'C']);
  assert.deepEqual(requests, [0, 2]);
});

test('draft job failure is safe and serialized progress cannot overwrite completion', async t => {
  const dir = await newStateDir();
  t.after(() => rm(dir, { recursive: true, force: true }));
  const session = fakeSession();
  const sourceWorkspace = new ResearchWorkspace({ session, stateDir: dir });
  const packet = await sourceWorkspace.materials({ keys: [keys.paper1], limit: 1 });
  const source = packet.papers[0].records.find(record => record.kind === 'highlight');
  const workspace = new ResearchWorkspace({
    session, stateDir: dir,
    runner: async (payload, progress) => {
      assert.deepEqual(payload.sources.map(item => item.id), [source.id]);
      void progress({ stage: 'late progress', progress: 51 });
      return validDraft(source);
    }
  });
  const started = await workspace.start({
    kind: 'draft', keys: [keys.paper1], sourceIds: [source.id],
    sourceVersions: { [source.id]: source.fingerprint }, purpose: 'paragraph', framework: ''
  });
  await waitForIdle(workspace, started.id);
  const final = await workspace.status(started.id);
  const saved = JSON.parse(await readFile(join(dir, `${started.id}.json`), 'utf8'));
  assert.equal(final.status, 'completed');
  assert.equal(final.progress, 100);
  assert.equal(saved.status, 'completed');
  assert.equal(saved.result.paragraphs[0].sourceLinks[0].url, source.url);

  const failed = new ResearchWorkspace({
    session: fakeSession(), stateDir: dir, runner: async () => { throw new Error('private CLI output and source text'); }
  });
  const failedJob = await failed.start({
    kind: 'draft', keys: [keys.paper1], sourceIds: [source.id],
    sourceVersions: { [source.id]: source.fingerprint }
  });
  await waitForIdle(failed, failedJob.id);
  const status = await failed.status(failedJob.id);
  assert.equal(status.status, 'failed');
  assert.doesNotMatch(status.error, /private CLI output|source text/);
});

test('shared model setting reaches the Python worker and worker diagnostics stay safe', async t => {
  const dir = await newStateDir();
  t.after(() => rm(dir, { recursive: true, force: true }));
  const worker = join(dir, 'mock-research-worker');
  const capturedModel = join(dir, 'captured-model');
  const previousModel = process.env.ZOTERO_WORKBENCH_RESEARCH_MODEL;
  delete process.env.ZOTERO_WORKBENCH_RESEARCH_MODEL;
  t.after(() => previousModel === undefined
    ? delete process.env.ZOTERO_WORKBENCH_RESEARCH_MODEL
    : (process.env.ZOTERO_WORKBENCH_RESEARCH_MODEL = previousModel));
  await writeFile(join(dir, 'research-settings.json'), JSON.stringify({ model: 'shared-test-model' }));
  await writeFile(worker,
    `#!/bin/sh\ncat >/dev/null\nprintf '%s' "$ZOTERO_WORKBENCH_RESEARCH_MODEL" > '${capturedModel}'\nprintf '{"errorCode":"codex_cli_missing"}\\n'\nprintf 'private diagnostic material\\n' >&2\nexit 1\n`,
    { mode: 0o700 });
  await chmod(worker, 0o700);
  const session = fakeSession();
  const sourceReader = new ResearchWorkspace({ session, stateDir: dir });
  const packet = await sourceReader.materials({ keys: [keys.paper1], limit: 1 });
  const source = packet.papers[0].records.find(record => record.kind === 'highlight');
  const workspace = new ResearchWorkspace({ session, stateDir: join(dir, 'research'), workerPython: worker });
  const started = await workspace.start({
    kind: 'draft', keys: [keys.paper1], sourceIds: [source.id], sourceVersions: { [source.id]: source.fingerprint }
  });
  await waitForIdle(workspace, started.id);
  const status = await workspace.status(started.id);
  assert.equal(status.status, 'failed');
  assert.match(status.error, /没有找到已登录的 Codex CLI/);
  assert.doesNotMatch(status.error, /private diagnostic material/);
  assert.equal(await readFile(capturedModel, 'utf8'), 'shared-test-model');
});

test('cancel and host interruption remain terminal when a runner settles later', async t => {
  const dir = await newStateDir();
  t.after(() => rm(dir, { recursive: true, force: true }));
  const source = selectedSource();
  let finish;
  let entered;
  const enteredPromise = new Promise(resolve => { entered = resolve; });
  const workspace = new ResearchWorkspace({
    session: fakeSession(), stateDir: dir,
    runner: async () => { entered(); return new Promise(resolve => { finish = resolve; }); }
  });
  workspace.writingSources = async () => [source];
  const args = { kind: 'draft', keys: [keys.paper1], sourceIds: [source.id], sourceVersions: { [source.id]: source.fingerprint } };
  const started = await workspace.start(args);
  await enteredPromise;
  await workspace.cancel(started.id);
  finish(validDraft(source));
  await waitForIdle(workspace, started.id);
  assert.equal((await workspace.status(started.id)).status, 'cancelled');

  let finishInterrupted;
  const interrupted = new ResearchWorkspace({
    session: fakeSession(), stateDir: dir,
    runner: async () => new Promise(resolve => { finishInterrupted = resolve; })
  });
  interrupted.writingSources = async () => [source];
  const pending = await interrupted.start(args);
  for (let attempt = 0; attempt < 100 && !finishInterrupted; attempt++) await new Promise(resolve => setTimeout(resolve, 2));
  await interrupted.close();
  finishInterrupted(validDraft(source));
  await waitForIdle(interrupted, pending.id);
  assert.equal((await interrupted.status(pending.id)).status, 'interrupted');
  assert.equal(interrupted.session.closed, undefined, 'a supplied shared Zotero session must remain open');
});

test('workspace closes a session it created itself', async t => {
  const dir = await newStateDir();
  t.after(() => rm(dir, { recursive: true, force: true }));
  const workspace = new ResearchWorkspace({ stateDir: dir });
  let closed = false;
  workspace.session.close = () => { closed = true; };
  await workspace.close();
  assert.equal(closed, true);
});

test('TextFold local fallback and incomplete page or unit coverage are never accepted', () => {
  const payload = { pages: [{ page: 1, text: 'Page one full original text.' }, { page: 2, text: 'Page two full original text.' }] };
  const unit = { id: 'u1', full: 'Original sentence.', sentences: ['Original sentence.'], brief: [], evidence: [] };
  const valid = {
    format: 'textfold/doc', version: 0,
    provenance: { ai_generated: true, local: false, model: 'Codex configured model', made_with: 'TextFold 0.10.40 + Zotero Workbench' },
    coverage: { pages: 2, units: 2, allUnitsAI: true },
    sections: [{ pageIndex: 0, units: [unit] }, { pageIndex: 1, units: [{ ...unit, id: 'u2' }] }],
    researchGuide: guideFixture(payload.pages)
  };
  assert.equal(validateFoldResult(valid, { ...payload, researchGuideProfile: GUIDE_PROFILE }), valid);
  assert.throws(() => validateFoldResult({ ...valid, provenance: { ...valid.provenance, ai_generated: false, local: true } }, payload), /未保存局部结果/);
  assert.throws(() => validateFoldResult({ ...valid, coverage: { ...valid.coverage, pages: 1 } }, payload), /覆盖核验/);
  assert.throws(() => validateFoldResult({ ...valid, sections: [valid.sections[0], { ...valid.sections[1], pageIndex: 0 }] }, { ...payload, researchGuideProfile: GUIDE_PROFILE }), /页码覆盖/);
  assert.throws(() => validateFoldResult({ ...valid, researchGuide: {
    ...valid.researchGuide,
    researchQuestion: { items: [{ kind: 'author-claim', text: 'A claim with a fabricated quote.', evidence: [{ page: 1, quote: 'Not present in page one.' }] }], gaps: [] }
  } }, { ...payload, researchGuideProfile: GUIDE_PROFILE }), /逐字引文未通过原文核验/);
  assert.throws(() => validateFoldResult({ ...valid, researchGuide: {
    ...valid.researchGuide,
    researchQuestion: { items: [{ kind: 'author-claim', text: 'A quote is assigned to the wrong page.', evidence: [{ page: 1, quote: payload.pages[1].text.slice(0, 40) }] }], gaps: [] }
  } }, { ...payload, researchGuideProfile: GUIDE_PROFILE }), /逐字引文未通过原文核验/);
  const withoutSupport = validateFoldResult({ ...valid, researchGuide: {
    ...valid.researchGuide, methods: { items: [], gaps: [] }
  } }, { ...payload, researchGuideProfile: GUIDE_PROFILE });
  assert.deepEqual(withoutSupport.researchGuide.methods, { items: [], gaps: [] },
    'unsupported sections may stay empty without inventing evidence');
});

test('TextFold extraction retains text from both PDF columns', async t => {
  const dir = await newStateDir();
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, 'two-column.pdf');
  await writeFile(path, twoColumnPdf());
  const session = fakeSession();
  session.pdfText = async () => ({
    item: { key: keys.paper1, title: 'Two column test' },
    attachment: { key: keys.attachment, title: 'Two column test.pdf' },
    pdf: { pages: [{}] }, path
  });
  const workspace = new ResearchWorkspace({ session, stateDir: dir });
  const fulltext = await workspace.fulltext('user', keys.paper1);
  const text = fulltext.pages[0].text;
  const positions = [
    text.indexOf('LEFT_FIRST_COLUMN_SENTENCE'),
    text.indexOf('LEFT_SECOND_COLUMN_SENTENCE'),
    text.indexOf('RIGHT_FIRST_COLUMN_SENTENCE'),
    text.indexOf('RIGHT_SECOND_COLUMN_SENTENCE')
  ];
  assert.ok(positions.every(position => position >= 0), text);
});

test('fulltext translation falls back to PDF.js only when Poppler is missing and rejects degraded pages', async t => {
  const dir = await newStateDir();
  t.after(() => rm(dir, { recursive: true, force: true }));
  const previous = process.env.PDFTOTEXT_PATH;
  process.env.PDFTOTEXT_PATH = join(dir, 'missing-pdftotext');
  t.after(() => previous === undefined ? delete process.env.PDFTOTEXT_PATH : (process.env.PDFTOTEXT_PATH = previous));
  const path = join(dir, 'fixture.pdf');
  await writeFile(path, twoColumnPdf());
  const session = fakeSession();
  session.pdfText = async () => ({
    item: { key: keys.paper1, title: 'Fallback PDF' }, attachment: { key: keys.attachment },
    pdf: { pages: [{ text: 'Teacher institutions respond to staffing constraints across local districts.' }] }, path
  });
  const workspace = new ResearchWorkspace({ session, stateDir: dir });
  const translatedSource = await workspace.fulltext('user', keys.paper1, { allowPdfJsFallback: true });
  assert.equal(translatedSource.textSource, 'pdfjs');
  assert.equal(translatedSource.pages[0].text, 'Teacher institutions respond to staffing constraints across local districts.');
  await assert.rejects(workspace.fulltext('user', keys.paper1), /全文提取失败/,
    'TextFold keeps the strict Poppler requirement');

  session.pdfText = async () => ({
    item: { key: keys.paper1, title: 'Degraded PDF' }, attachment: { key: keys.attachment },
    pdf: { pages: [{ text: '\uFFFD\uFFFD\u0001乱码' }] }, path
  });
  await assert.rejects(workspace.fulltext('user', keys.paper1, { allowPdfJsFallback: true }), /明显乱码/);
});

test('fulltext uses the Zotero wrapped item.data.title and keeps flat fixtures compatible', async t => {
  const dir = await newStateDir();
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, 'wrapped-zotero-item.pdf');
  const poppler = join(dir, 'fixture-pdftotext');
  const pageText = 'A complete fixture page with enough readable words for extraction.';
  await writeFile(path, twoColumnPdf());
  await writeFile(poppler, `#!/bin/sh\nprintf '%s' '${pageText}'\n`, { mode: 0o700 });
  await chmod(poppler, 0o700);
  const previous = process.env.PDFTOTEXT_PATH;
  process.env.PDFTOTEXT_PATH = poppler;
  t.after(() => previous === undefined ? delete process.env.PDFTOTEXT_PATH : (process.env.PDFTOTEXT_PATH = previous));
  const session = fakeSession();
  session.pdfText = async () => ({
    item: {
      key: keys.paper1, version: 12, library: { type: 'user', id: 0 }, links: {}, meta: {},
      data: { key: keys.paper1, version: 12, itemType: 'journalArticle', title: '题名来自 item.data.title' }
    },
    attachment: {
      key: keys.attachment, version: 12, data: { key: keys.attachment, title: '附件文件名.pdf', filename: 'paper.pdf' }
    },
    pdf: { pages: [{}] }, path
  });
  const workspace = new ResearchWorkspace({ session, stateDir: dir });
  const result = await workspace.fulltext('user', keys.paper1);
  assert.equal(result.title, '题名来自 item.data.title');
  assert.equal(result.itemKey, keys.paper1);
  assert.equal(result.attachmentKey, keys.attachment);
});

test('fulltext translation binds current PDF metadata, caches only verified chunks, and returns parallel pages', async t => {
  const dir = await newStateDir();
  t.after(() => rm(dir, { recursive: true, force: true }));
  const previousModel = process.env.ZOTERO_WORKBENCH_RESEARCH_MODEL;
  process.env.ZOTERO_WORKBENCH_RESEARCH_MODEL = 'gpt-5.4-codex';
  t.after(() => previousModel === undefined
    ? delete process.env.ZOTERO_WORKBENCH_RESEARCH_MODEL
    : (process.env.ZOTERO_WORKBENCH_RESEARCH_MODEL = previousModel));
  const sourceText = 'The institution shapes local choices and the consequences for district teachers.';
  const poppler = join(dir, 'fake-pdftotext');
  await writeFile(poppler, `#!/bin/sh\nprintf '%s' '${sourceText}'\n`, { mode: 0o700 });
  await chmod(poppler, 0o700);
  const previous = process.env.PDFTOTEXT_PATH;
  process.env.PDFTOTEXT_PATH = poppler;
  t.after(() => previous === undefined ? delete process.env.PDFTOTEXT_PATH : (process.env.PDFTOTEXT_PATH = previous));
  const pdfPath = join(dir, 'first.pdf');
  await writeFile(pdfPath, twoColumnPdf());
  const session = fakeSession();
  session.pdfText = async () => ({ item: { key: keys.paper1, title: 'Current title' },
    attachment: { key: keys.attachment }, pdf: { pages: [{}] }, path: pdfPath });
  let calls = 0;
  const workspace = new ResearchWorkspace({
    session, stateDir: dir,
    runner: async payload => {
      calls++;
      assert.equal(payload.kind, 'translate');
      assert.ok(payload.blocks.every(block => block.preserveOriginal === false));
      return { translations: payload.blocks.map(block => ({ id: block.id, translation: '本地制度影响选择与后果。' })) };
    }
  });
  const started = await workspace.start({ kind: 'translate', library: 'user', key: keys.paper1 });
  await waitForIdle(workspace, started.id);
  const result = (await workspace.status(started.id)).result;
  assert.equal(result.format, 'zotero-workbench/translation');
  assert.equal(result.version, 1);
  assert.equal(result.textSource, 'poppler');
  assert.equal(result.coverage.complete, true);
  assert.equal(result.pages[0].original, sourceText);
  assert.equal(result.pages[0].translation, '本地制度影响选择与后果。');
  assert.equal(result.pages[0].blocks[0].unchanged, false);
  assert.equal(result.provenance.model, 'gpt-5.4-codex');
  assert.equal(calls, 1);

  const secondPdf = join(dir, 'second.pdf');
  await writeFile(secondPdf, twoColumnPdf());
  const secondSession = fakeSession();
  secondSession.pdfText = async () => ({ item: { key: keys.paper2, title: 'Other Zotero title' },
    attachment: { key: 'PDF00002' }, pdf: { pages: [{}] }, path: secondPdf });
  const cachedWorkspace = new ResearchWorkspace({ session: secondSession, stateDir: dir,
    runner: async () => { throw new Error('cache should avoid a second model call'); } });
  const cached = await cachedWorkspace.start({ kind: 'translate', library: 'user', key: keys.paper2 });
  await waitForIdle(cachedWorkspace, cached.id);
  const cachedResult = (await cachedWorkspace.status(cached.id)).result;
  assert.equal(cachedResult.title, 'Other Zotero title');
  assert.equal(cachedResult.itemKey, keys.paper2);
  assert.equal(cachedResult.attachmentKey, 'PDF00002');
  assert.equal(cachedResult.pages[0].translation, '本地制度影响选择与后果。');
  assert.equal(cachedResult.provenance.model, 'gpt-5.4-codex', 'cache preserves the model that generated the translation');
  assert.equal(calls, 1);
});

test('annotation translation is read-only derived output, excludes comments, revalidates source and reuses text cache', async t => {
  const dir = await newStateDir();
  t.after(() => rm(dir, { recursive: true, force: true }));
  const session = fakeSession();
  const reader = new ResearchWorkspace({ session, stateDir: dir });
  const packet = await reader.materials({ keys: [keys.paper1], limit: 1 });
  const source = packet.papers[0].records.find(record => record.kind === 'highlight');
  let calls = 0;
  const workspace = new ResearchWorkspace({ session, stateDir: dir,
    runner: async payload => {
      calls++;
      assert.equal(payload.kind, 'translate_annotations');
      assert.deepEqual(Object.keys(payload.sources[0]).sort(), ['id', 'original']);
      assert.equal(JSON.stringify(payload).includes('Reader interpretation'), false);
      assert.equal(JSON.stringify(payload).includes('humanSelected'), false);
      return { translations: payload.sources.map(item => ({ id: item.id, translation: '原文翻译。' })) };
    }
  });
  const args = { kind: 'translate_annotations', library: 'user', keys: [keys.paper1],
    sourceIds: [source.id], sourceVersions: { [source.id]: source.fingerprint } };
  const started = await workspace.start(args);
  await waitForIdle(workspace, started.id);
  const translationStatus = await workspace.status(started.id);
  assert.equal(translationStatus.status, 'completed', translationStatus.error);
  const result = translationStatus.result;
  assert.equal(result.format, 'zotero-workbench/annotation-translations');
  assert.equal(result.coverage.complete, true);
  assert.equal(result.coverage.total, 1);
  assert.equal(result.translations[0].sourceId, source.id);
  assert.equal(result.translations[0].fingerprint, source.fingerprint);
  assert.equal(result.translations[0].translation, '原文翻译。');
  assert.equal(Object.hasOwn(result.translations[0], 'humanSelected'), false);

  session.offline = true;
  session.library.checkVersion = async function checkVersion() {
    if (session.offline) throw new Error('offline');
  };
  const offlineView = await workspace.status(started.id);
  assert.equal(offlineView.status, 'verification_required');
  assert.equal(Object.hasOwn(offlineView, 'result'), false);
  const persisted = JSON.parse(await readFile(join(dir, `${started.id}.json`), 'utf8'));
  assert.equal(persisted.status, 'completed');
  assert.equal(persisted.result.translations[0].sourceId, source.id,
    'temporary source unavailability must not overwrite the complete audit snapshot');
  session.offline = false;
  workspace.translationVerificationRetries.delete(started.id);
  const reconnected = await workspace.status(started.id);
  assert.equal(reconnected.status, 'completed');
  assert.equal(reconnected.result.translations[0].sourceId, source.id);

  const originalAnnotation = session.getAnnotation();
  session.setAnnotation({ ...originalAnnotation, data: {
    ...originalAnnotation.data, annotationText: 'The source changed after its translation completed.'
  } });
  const staleView = await workspace.status(started.id);
  assert.equal(staleView.status, 'verification_required');
  assert.equal(Object.hasOwn(staleView, 'result'), false);
  const stalePersisted = JSON.parse(await readFile(join(dir, `${started.id}.json`), 'utf8'));
  assert.equal(stalePersisted.status, 'completed');
  assert.equal(stalePersisted.result.translations[0].translation, '原文翻译。',
    'the old result remains in the audit snapshot but is hidden from the current verified view');
  session.setAnnotation(originalAnnotation);
  workspace.translationVerificationRetries.delete(started.id);
  assert.equal((await workspace.status(started.id)).status, 'completed');

  const cachedWorkspace = new ResearchWorkspace({ session, stateDir: dir,
    runner: async () => { throw new Error('cache should avoid a second model call'); } });
  const cached = await cachedWorkspace.start(args);
  await waitForIdle(cachedWorkspace, cached.id);
  assert.equal((await cachedWorkspace.status(cached.id)).result.translations[0].sourceId, source.id);
  assert.equal(calls, 1);

  const staleSession = fakeSession();
  staleSession.setAnnotation({ key: keys.annotation, data: {
    itemType: 'annotation', annotationType: 'highlight', annotationText: 'A distinct uncached foreign passage.',
    annotationComment: 'Private note should stay local.', annotationPosition: JSON.stringify({ pageIndex: 2 }),
    annotationPageLabel: '3', dateModified: '2026-10-30'
  } });
  const staleReader = new ResearchWorkspace({ session: staleSession, stateDir: dir });
  const stalePacket = await staleReader.materials({ keys: [keys.paper1], limit: 1 });
  const staleSource = stalePacket.papers[0].records.find(record => record.kind === 'highlight');
  const staleWorkspace = new ResearchWorkspace({ session: staleSession, stateDir: dir,
    runner: async () => {
      staleSession.setAnnotation({ key: keys.annotation, data: {
        itemType: 'annotation', annotationType: 'highlight', annotationText: 'Changed foreign passage.',
        annotationPosition: JSON.stringify({ pageIndex: 2 }), annotationPageLabel: '3'
      } });
      return { translations: [{ id: staleSource.id, translation: '不应缓存。' }] };
    }
  });
  const staleJob = await staleWorkspace.start({ ...args,
    sourceVersions: { [staleSource.id]: staleSource.fingerprint } });
  await waitForIdle(staleWorkspace, staleJob.id);
  assert.equal((await staleWorkspace.status(staleJob.id)).status, 'failed');
  assert.equal(await staleWorkspace.readTranslationCache(fingerprint('A distinct uncached foreign passage.')), null,
    'a source that changes during the model call does not create a success cache entry');
  assert.equal(calls, 1);
});

test('annotation translation allows Japanese, Korean, and mixed-language excerpts but skips Chinese-dominant text', async t => {
  const dir = await newStateDir();
  t.after(() => rm(dir, { recursive: true, force: true }));
  for (const text of [
    '制度的な配置が地方の選択を変える。',
    '조직의 자원 배분은 교사의 선택을 바꾼다.',
    '制度安排 shapes local choices and outcomes.'
  ]) {
    const session = fakeSession();
    const annotation = session.getAnnotation();
    session.setAnnotation({ ...annotation, data: { ...annotation.data, annotationText: text } });
    const workspace = new ResearchWorkspace({ session, stateDir: dir });
    const packet = await workspace.materials({ keys: [keys.paper1], limit: 1 });
    const record = packet.papers[0].records.find(item => item.kind === 'highlight');
    const result = await workspace.translationAnnotationSources({ library: 'user', keys: [keys.paper1],
      sourceIds: [record.id], sourceVersions: { [record.id]: record.fingerprint } });
    assert.equal(result.sources[0].original, text);
  }
  const chineseSession = fakeSession();
  const annotation = chineseSession.getAnnotation();
  chineseSession.setAnnotation({ ...annotation, data: { ...annotation.data, annotationText: '地方制度影响教师配置结果。' } });
  const chineseWorkspace = new ResearchWorkspace({ session: chineseSession, stateDir: dir });
  const packet = await chineseWorkspace.materials({ keys: [keys.paper1], limit: 1 });
  const record = packet.papers[0].records.find(item => item.kind === 'highlight');
  await assert.rejects(chineseWorkspace.translationAnnotationSources({ library: 'user', keys: [keys.paper1],
    sourceIds: [record.id], sourceVersions: { [record.id]: record.fingerprint } }), /中文为主/);
});

test('metadata translation reads only the current Zotero item fields and works without a PDF', async t => {
  const dir = await newStateDir();
  t.after(() => rm(dir, { recursive: true, force: true }));
  const session = metadataSession({
    title: '<span lang="en">Institutional choices</span>',
    abstractNote: '<p>Local institutions shape <strong>teacher allocation</strong> &amp; later outcomes.</p><script>secret-not-source-text</script>',
    language: 'zh',
  });
  const sourceRecordBefore = JSON.stringify(session.getMetadataRecord());
  let calls = 0;
  const workspace = new ResearchWorkspace({ session, stateDir: dir,
    runner: async payload => {
      calls++;
      assert.deepEqual(Object.keys(payload).sort(), ['fields', 'kind']);
      assert.equal(payload.kind, 'translate_metadata');
      assert.ok(payload.fields.every(field => Object.keys(field).sort().join(',') === 'id,original,preserveOriginal'));
      assert.equal(JSON.stringify(payload).includes('secret-not-source-text'), false);
      assert.equal(JSON.stringify(payload).includes('PAPER001'), false);
      assert.equal(JSON.stringify(payload).includes('Reader interpretation.'), false);
      return { translations: payload.fields.map(field => ({ id: field.id, translation: `译文${field.id}` })) };
    }
  });
  const started = await workspace.start({ kind: 'translate_metadata', library: 'user', key: keys.paper1 });
  await waitForIdle(workspace, started.id);
  const status = await workspace.status(started.id);
  assert.equal(status.status, 'completed', status.error);
  assert.equal(status.result.format, 'zotero-workbench/metadata-translation');
  assert.equal(status.result.version, 1);
  assert.equal(status.result.targetLanguage, 'zh-CN');
  assert.equal(status.result.language, 'zh', 'Zotero language metadata is preserved but does not override text recognition');
  assert.equal(status.result.library, 'user');
  assert.equal(status.result.itemKey, keys.paper1);
  assert.match(status.result.sourceFingerprint, /^[a-f0-9]{64}$/);
  assert.equal(status.result.title.original, 'Institutional choices');
  assert.equal(status.result.title.translated, true);
  assert.equal(status.result.abstract.original, 'Local institutions shape teacher allocation & later outcomes.');
  assert.equal(status.result.abstract.translated, true);
  assert.equal(status.result.coverage.complete, true);
  assert.equal(calls, 1);
  assert.equal(session.pdfTextCalls, 0);
  assert.ok(session.requestPaths.every(path => path === `/api/users/0/items/${keys.paper1}`));
  assert.equal(JSON.stringify(session.getMetadataRecord()), sourceRecordBefore, 'metadata translation never writes the Zotero item');

  const reopened = new ResearchWorkspace({ session, stateDir: dir });
  const restored = await reopened.status(started.id);
  assert.equal(restored.status, 'completed');
  assert.equal(restored.result.sourceFingerprint, status.result.sourceFingerprint,
    'restored results are shown only after the current Zotero metadata matches');
});

test('identical active metadata translation requests share one job signature', async t => {
  const dir = await newStateDir();
  t.after(() => rm(dir, { recursive: true, force: true }));
  let entered;
  let release;
  const enteredPromise = new Promise(resolve => { entered = resolve; });
  const resultPromise = new Promise(resolve => { release = resolve; });
  let calls = 0;
  const workspace = new ResearchWorkspace({ session: metadataSession(), stateDir: dir,
    runner: async payload => {
      calls++;
      entered();
      return resultPromise;
    }
  });
  const args = { kind: 'translate_metadata', library: 'user', key: keys.paper1 };
  const first = await workspace.start(args);
  await enteredPromise;
  const duplicate = await workspace.start(args);
  assert.equal(duplicate.id, first.id);
  assert.equal(calls, 1);
  release({ translations: workspace.metadataTranslationBlocks(await workspace.metadataSource('user', keys.paper1))
    .filter(block => !block.preserveOriginal)
    .map(block => ({ id: block.id, translation: `统一译文${block.id}` })) });
  await waitForIdle(workspace, first.id);
  assert.equal((await workspace.status(first.id)).status, 'completed');
});

test('metadata translation leaves a missing abstract blank and reuses matching field cache under current identity', async t => {
  const dir = await newStateDir();
  t.after(() => rm(dir, { recursive: true, force: true }));
  const session = metadataSession({ abstractNote: '' });
  let calls = 0;
  const firstWorkspace = new ResearchWorkspace({ session, stateDir: dir,
    runner: async payload => {
      calls++;
      assert.deepEqual(payload.fields.map(field => field.original), ['Institutional arrangements and local choices']);
      return { translations: payload.fields.map(field => ({ id: field.id, translation: '制度安排与地方选择' })) };
    }
  });
  const first = await firstWorkspace.start({ kind: 'translate_metadata', library: 'user', key: keys.paper1 });
  await waitForIdle(firstWorkspace, first.id);
  const firstResult = (await firstWorkspace.status(first.id)).result;
  assert.deepEqual(firstResult.abstract, { original: '', translation: '', translated: false, available: false });

  const secondSession = metadataSession({ abstractNote: '' });
  const secondKey = keys.paper2;
  const itemForSecond = secondSession.getMetadataRecord();
  itemForSecond.key = secondKey;
  itemForSecond.data.key = secondKey;
  secondSession.client.getJson = async path => {
    if (path === `/api/users/0/items/${secondKey}`) return { data: { ...itemForSecond, data: { ...itemForSecond.data } } };
    throw new Error('unexpected metadata request');
  };
  secondSession.library.checkVersion = async () => {};
  const cachedWorkspace = new ResearchWorkspace({ session: secondSession, stateDir: dir,
    runner: async () => { throw new Error('matching metadata field cache should avoid another model call'); } });
  const second = await cachedWorkspace.start({ kind: 'translate_metadata', library: 'user', key: secondKey });
  await waitForIdle(cachedWorkspace, second.id);
  const secondResult = (await cachedWorkspace.status(second.id)).result;
  assert.equal(secondResult.itemKey, secondKey);
  assert.notEqual(secondResult.sourceFingerprint, firstResult.sourceFingerprint);
  assert.equal(secondResult.title.original, firstResult.title.original);
  assert.equal(secondResult.title.translation, firstResult.title.translation);
  assert.equal(calls, 1);
});

test('metadata source changes hide old results and use only current field cache keys', async t => {
  const dir = await newStateDir();
  t.after(() => rm(dir, { recursive: true, force: true }));
  const session = metadataSession();
  let calls = 0;
  const workspace = new ResearchWorkspace({ session, stateDir: dir,
    runner: async payload => {
      calls++;
      return { translations: payload.fields.map(field => ({
        id: field.id,
        translation: calls === 1 ? '旧译文' : `新译文${calls}`,
      })) };
    }
  });
  const args = { kind: 'translate_metadata', library: 'user', key: keys.paper1 };
  const first = await workspace.start(args);
  await waitForIdle(workspace, first.id);
  const firstResult = (await workspace.status(first.id)).result;
  session.updateMetadata({ tags: [{ tag: 'unrelated-tag' }], dateModified: '2099-01-01', language: 'EN' });
  session.library.version = 99;
  workspace.translationVerificationRetries.delete(first.id);
  assert.equal((await workspace.status(first.id)).status, 'completed',
    'tags, dates, and a changed library version do not alter the metadata source fingerprint');
  session.updateMetadata({ title: 'A different institutional title', abstractNote: 'A changed abstract about another result.' });
  workspace.translationVerificationRetries.delete(first.id);
  const stale = await workspace.status(first.id);
  assert.equal(stale.status, 'verification_required');
  assert.equal(Object.hasOwn(stale, 'result'), false);

  const second = await workspace.start(args);
  await waitForIdle(workspace, second.id);
  const current = (await workspace.status(second.id)).result;
  assert.notEqual(current.sourceFingerprint, firstResult.sourceFingerprint);
  assert.equal(current.title.original, 'A different institutional title');
  assert.equal(current.abstract.original, 'A changed abstract about another result.');
  assert.equal(current.title.translation, '新译文2');
  assert.equal(current.abstract.translation, '新译文2');
  assert.equal(calls, 2, 'changed field text has a distinct cache key and must be translated');
});

test('metadata translation skips Chinese prose and does not cache partial model failures', async t => {
  const dir = await newStateDir();
  t.after(() => rm(dir, { recursive: true, force: true }));
  const chineseSession = metadataSession({
    title: 'AI与教育',
    abstractNote: '<p>制度安排影响行动者选择与跨期结果。</p>',
    language: 'en',
  });
  const chineseWorkspace = new ResearchWorkspace({ session: chineseSession, stateDir: dir,
    runner: async () => { throw new Error('Chinese fields should not be sent for translation'); } });
  const chinese = await chineseWorkspace.start({ kind: 'translate_metadata', library: 'user', key: keys.paper1 });
  await waitForIdle(chineseWorkspace, chinese.id);
  const chineseResult = (await chineseWorkspace.status(chinese.id)).result;
  assert.equal(chineseResult.title.original, 'AI与教育');
  assert.equal(chineseResult.title.translation, chineseResult.title.original);
  assert.equal(chineseResult.title.translated, false);
  assert.equal(chineseResult.abstract.translated, false);
  assert.equal(chineseSession.pdfTextCalls, 0);

  const failedSession = metadataSession();
  const failedWorkspace = new ResearchWorkspace({ session: failedSession, stateDir: dir,
    runner: async () => { throw new Error('private model output and source text'); } });
  const failed = await failedWorkspace.start({ kind: 'translate_metadata', library: 'user', key: keys.paper1 });
  await waitForIdle(failedWorkspace, failed.id);
  const failedStatus = await failedWorkspace.status(failed.id);
  assert.equal(failedStatus.status, 'failed');
  assert.doesNotMatch(failedStatus.error, /private model output|source text/);
  assert.equal(await failedWorkspace.readTranslationCache(fingerprint('Institutional arrangements and local choices')), null);
  assert.equal(await failedWorkspace.readTranslationCache(fingerprint('Institutions shape how local actors use resources and produce long-term outcomes.')), null);
});

test('metadata heuristic handles mixed title and abstract fields independently of Zotero language', async t => {
  const dir = await newStateDir();
  t.after(() => rm(dir, { recursive: true, force: true }));
  const shortChineseTitle = 'AI与教育';
  const englishAbstract = 'Local institutions shape choices and long-term outcomes.';
  const firstSession = metadataSession({ title: shortChineseTitle, abstractNote: englishAbstract, language: 'en' });
  const firstWorkspace = new ResearchWorkspace({ session: firstSession, stateDir: dir,
    runner: async payload => {
      assert.deepEqual(payload.fields.map(field => field.original), [englishAbstract]);
      return { translations: payload.fields.map(field => ({ id: field.id, translation: '地方制度影响选择与长期结果。' })) };
    }
  });
  const first = await firstWorkspace.start({ kind: 'translate_metadata', library: 'user', key: keys.paper1 });
  await waitForIdle(firstWorkspace, first.id);
  const firstResult = (await firstWorkspace.status(first.id)).result;
  assert.equal(firstResult.title.translation, shortChineseTitle);
  assert.equal(firstResult.title.translated, false);
  assert.equal(firstResult.abstract.translated, true);

  const englishTitle = 'Institutional change and local school staffing';
  const longChineseAbstract = '地方制度安排经由组织资源配置影响学校行动者的选择，并在连续的时间过程中形成后续配置结果。';
  const secondSession = metadataSession({ title: englishTitle, abstractNote: longChineseAbstract, language: 'zh' });
  const secondWorkspace = new ResearchWorkspace({ session: secondSession, stateDir: dir,
    runner: async payload => {
      assert.deepEqual(payload.fields.map(field => field.original), [englishTitle]);
      assert.equal(JSON.stringify(payload).includes(longChineseAbstract), false);
      return { translations: payload.fields.map(field => ({ id: field.id, translation: '制度变迁与地方学校教师配置' })) };
    }
  });
  const second = await secondWorkspace.start({ kind: 'translate_metadata', library: 'user', key: keys.paper1 });
  await waitForIdle(secondWorkspace, second.id);
  const secondResult = (await secondWorkspace.status(second.id)).result;
  assert.equal(secondResult.title.translated, true);
  assert.equal(secondResult.abstract.translation, longChineseAbstract);
  assert.equal(secondResult.abstract.translated, false);
});

test('metadata changed during the model call cannot yield a result or successful translation cache', async t => {
  const dir = await newStateDir();
  t.after(() => rm(dir, { recursive: true, force: true }));
  const session = metadataSession({ title: 'A distinct source title for race checking', abstractNote: '' });
  const original = 'A distinct source title for race checking';
  const workspace = new ResearchWorkspace({ session, stateDir: dir,
    runner: async payload => {
      session.updateMetadata({ title: 'The Zotero title changed while translation was running.' });
      return { translations: payload.fields.map(field => ({ id: field.id, translation: '过期标题译文' })) };
    }
  });
  const started = await workspace.start({ kind: 'translate_metadata', library: 'user', key: keys.paper1 });
  await waitForIdle(workspace, started.id);
  const status = await workspace.status(started.id);
  assert.equal(status.status, 'failed');
  assert.match(status.error, /翻译期间发生变化/);
  assert.equal(Object.hasOwn(status, 'result'), false);
  assert.equal(await workspace.readTranslationCache(fingerprint(original)), null);
});

test('metadata reads reject deleted and indeterminate Zotero item states', async t => {
  const dir = await newStateDir();
  t.after(() => rm(dir, { recursive: true, force: true }));
  for (const deleted of [true, 1, '1', 'unknown', null]) {
    const session = metadataSession({ deleted });
    const workspace = new ResearchWorkspace({ session, stateDir: dir });
    await assert.rejects(workspace.metadataSource('user', keys.paper1), /无法确认所选 Zotero 文献/);
  }
  const missingIdentitySession = metadataSession();
  const originalGetJson = missingIdentitySession.client.getJson;
  missingIdentitySession.client.getJson = async path => {
    const response = await originalGetJson(path);
    if (path === `/api/users/0/items/${keys.paper1}`) delete response.data.key;
    return response;
  };
  const missingIdentityWorkspace = new ResearchWorkspace({ session: missingIdentitySession, stateDir: dir });
  await assert.rejects(missingIdentityWorkspace.metadataSource('user', keys.paper1), /无法确认所选 Zotero 文献/);
});
