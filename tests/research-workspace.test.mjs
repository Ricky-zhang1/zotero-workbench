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
      annotationPageLabel: '3', dateModified: '2026-10-29'
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
    setAnnotation(value) { annotation = value; }
  };
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

test('worker diagnostic codes retain safe setup guidance without exposing stderr', async t => {
  const dir = await newStateDir();
  t.after(() => rm(dir, { recursive: true, force: true }));
  const worker = join(dir, 'mock-research-worker');
  await writeFile(worker,
    '#!/bin/sh\ncat >/dev/null\nprintf \'{"errorCode":"codex_cli_missing"}\\n\'\nprintf \'private diagnostic material\\n\' >&2\nexit 1\n',
    { mode: 0o700 });
  await chmod(worker, 0o700);
  const session = fakeSession();
  const sourceReader = new ResearchWorkspace({ session, stateDir: dir });
  const packet = await sourceReader.materials({ keys: [keys.paper1], limit: 1 });
  const source = packet.papers[0].records.find(record => record.kind === 'highlight');
  const workspace = new ResearchWorkspace({ session, stateDir: dir, workerPython: worker });
  const started = await workspace.start({
    kind: 'draft', keys: [keys.paper1], sourceIds: [source.id], sourceVersions: { [source.id]: source.fingerprint }
  });
  await waitForIdle(workspace, started.id);
  const status = await workspace.status(started.id);
  assert.equal(status.status, 'failed');
  assert.match(status.error, /没有找到已登录的 Codex CLI/);
  assert.doesNotMatch(status.error, /private diagnostic material/);
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
    sections: [{ pageIndex: 0, units: [unit] }, { pageIndex: 1, units: [{ ...unit, id: 'u2' }] }]
  };
  assert.equal(validateFoldResult(valid, payload), valid);
  assert.throws(() => validateFoldResult({ ...valid, provenance: { ...valid.provenance, ai_generated: false, local: true } }, payload), /未保存局部结果/);
  assert.throws(() => validateFoldResult({ ...valid, coverage: { ...valid.coverage, pages: 1 } }, payload), /覆盖核验/);
  assert.throws(() => validateFoldResult({ ...valid, sections: [valid.sections[0], { ...valid.sections[1], pageIndex: 0 }] }, payload), /页码覆盖/);
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
