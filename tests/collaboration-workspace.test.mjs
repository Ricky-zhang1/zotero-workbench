import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CollaborationWorkspace } from '../src/domain/collaboration-workspace.mjs';

const hash = value => createHash('sha256').update(Buffer.isBuffer(value) || typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');
const sourceFields = { library: 'user', itemKey: 'PARENT01', key: 'ANNOT001', attachmentKey: 'PDF00001' };
const sourceId = hash([sourceFields.library, sourceFields.itemKey, sourceFields.key]).slice(0, 16);

function fakeResearchWorkspace() {
  let current = {
    id: sourceId, ...sourceFields, title: 'Selected study', kind: 'highlight',
    text: 'The user selected this exact passage.', comment: 'Reader note attached to the passage.',
    pageIndex: 3, pageLabel: '4', color: '#ffff00',
    url: `zotero://open-pdf/library/items/${sourceFields.attachmentKey}?page=4&annotation=${sourceFields.key}`,
    fingerprint: hash('source-v1'), humanSelected: false
  };
  let pdf = {
    title: 'Selected study', itemKey: sourceFields.itemKey, attachmentKey: sourceFields.attachmentKey,
    library: 'user', sha256: hash('pdf-v1'), sourcePath: '/private/local/selected.pdf',
    pages: [
      { page: 1, text: 'Page one full extracted text.' },
      { page: 2, text: 'Page two full extracted text.' },
      { page: 3, text: 'Page three full extracted text.' }
    ]
  };
  const calls = { paper: 0, writingSources: 0, fulltext: 0 };
  const workspace = {
    calls,
    setSource(value) { current = { ...value }; },
    setPdf(value) { pdf = { ...value }; },
    getPdf() { return { ...pdf, pages: pdf.pages.map(page => ({ ...page })) }; },
    async paper(library, itemKey) {
      calls.paper++;
      if (library !== current.library || itemKey !== current.itemKey) return { records: [], errors: [] };
      return { records: [{ ...current }], errors: [] };
    },
    async writingSources(args) {
      calls.writingSources++;
      if (args.library !== current.library || !args.keys.includes(current.itemKey) || !args.sourceIds.includes(current.id))
        throw new Error('Zotero 来源身份校验失败。');
      if (args.sourceVersions[current.id] !== current.fingerprint) throw new Error('所选标注内容已变化，请刷新后重新勾选。');
      return [{ ...current, humanSelected: true }];
    },
    async fulltext(library, key) {
      calls.fulltext++;
      if (library !== pdf.library || key !== pdf.itemKey) throw new Error('PDF 不存在。');
      return { ...pdf, pages: pdf.pages.map(page => ({ ...page })) };
    }
  };
  return workspace;
}

async function tempDir() { return mkdtemp(join(tmpdir(), 'zotero-collaboration-test-')); }

async function createWorkspace(t, researchWorkspace = fakeResearchWorkspace()) {
  const dir = await tempDir();
  t.after(() => rm(dir, { recursive: true, force: true }));
  let timestamp = 1_800_000_000_000;
  return { dir, researchWorkspace, collaboration: new CollaborationWorkspace({
    stateDir: dir, researchWorkspace, now: () => ++timestamp
  }) };
}

const selectedDescriptor = (overrides = {}) => ({
  library: 'user', itemKey: sourceFields.itemKey, attachmentKey: sourceFields.attachmentKey,
  annotationKey: sourceFields.key, fingerprint: hash('source-v1'), ...overrides
});

test('session sources are read from Zotero, drafts retain provenance, and feedback stays bound to one text version', async t => {
  const { dir, collaboration, researchWorkspace } = await createWorkspace(t);
  const project = join(dir, 'project');
  await mkdir(project);
  const manuscript = join(project, 'draft.md');
  const manuscriptBytes = Buffer.from('# Working draft\n\nAuthor-year citation stays unchanged.\n');
  await writeFile(manuscript, manuscriptBytes);

  const created = await collaboration.session({ action: 'create', title: 'Teacher policy project', projectPath: project });
  const id = created.session.id;
  assert.equal(created.session.revision, 1);
  assert.equal(created.session.sources.length, 0);
  const dirInfo = await stat(join(dir, 'collaboration', 'sessions'));
  assert.equal(dirInfo.mode & 0o777, 0o700);
  const added = await collaboration.sources({ action: 'add', id, expectedRevision: 1, sources: [selectedDescriptor()] });
  assert.equal(added.session.revision, 2);
  assert.equal(added.session.sources[0].humanSelected, true);
  assert.equal(added.session.sources[0].text, 'The user selected this exact passage.');
  assert.match(added.session.sources[0].url, /^zotero:\/\//);
  assert.equal(researchWorkspace.calls.writingSources, 1);
  const stateFile = join(dir, 'collaboration', 'sessions', `${id}.json`);
  assert.equal((await stat(stateFile)).mode & 0o777, 0o600);

  await assert.rejects(collaboration.sources({ action: 'add', id, expectedRevision: 2,
    sources: [selectedDescriptor({ fingerprint: hash('stale') })] }), /内容已变化/);
  await assert.rejects(collaboration.sources({ action: 'clear', id, expectedRevision: 1 }), /revision=2/);
  assert.equal(JSON.parse(await readFile(stateFile, 'utf8')).revision, 2, 'rejected writes leave the session unchanged');

  const paragraph = { id: 'para1', text: 'A claim grounded in the selected passage.', sourceIds: [sourceId],
    claims: [{ id: 'claim1', text: 'The passage reports a policy mechanism.', sourceIds: [sourceId] }] };
  const firstDraftResult = await collaboration.draft({ id, expectedRevision: 2, title: 'First draft',
    paragraphs: [paragraph], docPath: manuscript });
  const firstDraft = firstDraftResult.session.drafts[0];
  assert.equal(firstDraft.paragraphs[0].id, 'para1');
  assert.equal(firstDraft.paragraphs[0].claims[0].id, 'claim1');
  assert.equal(firstDraft.sources[0].text, 'The user selected this exact passage.');
  assert.equal(firstDraft.paragraphs[0].sourceLinks[0].url, added.session.sources[0].url);
  assert.equal(firstDraft.docBinding.relativePath, 'draft.md');
  assert.equal(firstDraft.docBinding.sha256, hash(manuscriptBytes));
  assert.equal(firstDraftResult.session.sourceCount, 1);
  assert.equal(firstDraftResult.session.sources.length, 0, 'large source and draft payloads are not duplicated');

  const firstFeedback = await collaboration.feedback({ action: 'record', id, expectedRevision: 3,
    draftId: firstDraft.id, claimId: 'claim1', sourceIds: [sourceId], decision: 'needs_revision', comment: 'Narrow the causal wording.' });
  assert.equal(firstFeedback.feedbackEntry.actor, 'user');
  assert.equal(firstFeedback.feedbackEntry.origin, 'app-only-user-action');
  assert.equal(firstFeedback.feedbackEntry.targetTextSha256, hash(paragraph.claims[0].text));
  await assert.rejects(collaboration.feedback({ action: 'record', id, expectedRevision: 4, draftId: firstDraft.id,
    claimId: 'claim1', decision: 'supports', actor: 'agent' }), /不支持的字段/);

  const secondDraftResult = await collaboration.draft({ id, expectedRevision: 4, title: 'Revised draft',
    paragraphs: [{ ...paragraph, text: 'An extensively revised paragraph.', claims: [{ ...paragraph.claims[0], text: 'A revised interpretation.' }] }] });
  assert.notEqual(secondDraftResult.session.drafts[0].id, firstDraft.id);
  const defaultGet = await collaboration.session({ action: 'get', id });
  assert.equal(defaultGet.session.drafts.length, 1);
  assert.equal(defaultGet.session.drafts[0].contentIncluded, false);
  assert.equal(defaultGet.session.feedback.at(-1).appliesToLatestDraft, false);
  const historical = await collaboration.session({ action: 'get', id, draftId: firstDraft.id });
  assert.equal(historical.session.drafts[0].paragraphs[0].text, paragraph.text);
  assert.equal(historical.session.drafts[0].sources[0].text, added.session.sources[0].text);
  assert.equal(historical.session.drafts[0].sources[0].stale, false);

  const feedbackPage = await collaboration.feedback({ action: 'list', id, draftId: firstDraft.id, limit: 20 });
  assert.equal(feedbackPage.feedback.length, 1);
  assert.equal(feedbackPage.feedback[0].targetStillMatches, true);
  assert.equal(feedbackPage.feedback[0].appliesToLatestDraft, false);
  assert.equal(feedbackPage.feedback[0].draftRevision, firstDraft.revision);

  await collaboration.sources({ action: 'remove', id, expectedRevision: 5, sourceIds: [sourceId] });
  const afterRemove = await collaboration.session({ action: 'get', id, draftId: firstDraft.id });
  assert.equal(afterRemove.session.sources.length, 0);
  assert.equal(afterRemove.session.drafts[0].sources[0].id, sourceId, 'historical source snapshot survives source removal');
  assert.equal(afterRemove.session.drafts[0].sources[0].stale, false);
  researchWorkspace.setSource({ ...added.session.sources[0], fingerprint: hash('source-v2'), text: 'Changed in Zotero.' });
  const currentStaleSummary = await collaboration.session({ action: 'get', id });
  assert.equal(currentStaleSummary.session.latestDraftStaleSourceCount, 1,
    'ordinary session restore warns when a latest-draft source changed or disappeared');
  await collaboration.sources({ action: 'add', id, expectedRevision: 6,
    sources: [selectedDescriptor({ fingerprint: hash('source-v2') })] });
  const currentVersion = await collaboration.session({ action: 'get', id });
  assert.equal(currentVersion.session.sources[0].fingerprint, hash('source-v2'));
  assert.equal(currentVersion.session.sources[0].stale, false,
    'the newly selected current fingerprint remains current');
  const staleHistory = await collaboration.session({ action: 'get', id, draftId: firstDraft.id });
  assert.equal(staleHistory.session.drafts[0].sources[0].stale, true);
  assert.equal(staleHistory.session.drafts[0].sources[0].staleReason, 'fingerprint_changed');

  const other = await collaboration.session({ action: 'create', title: 'Another project' });
  await assert.rejects(collaboration.draft({ id: other.session.id, expectedRevision: 1,
    paragraphs: [{ text: 'Cross-session forgery.', sourceIds: [sourceId] }] }), /尚未选择/);
});

test('full-text continuation persists only complete page delivery and rejects stale or oversized pages', async t => {
  const researchWorkspace = fakeResearchWorkspace();
  const { collaboration } = await createWorkspace(t, researchWorkspace);
  const session = await collaboration.session({ action: 'create', title: 'Full-text continuation' });
  const first = await collaboration.read({ action: 'read', id: session.session.id, expectedRevision: 1,
    library: 'user', key: sourceFields.itemKey, maxPages: 1 });
  assert.deepEqual(first.deliveredPages, [1]);
  assert.deepEqual(first.notProcessedPages, [2, 3]);
  assert.equal(first.nextPage, 2);
  assert.equal(first.understanding, 'not_assessed');
  assert.equal(JSON.stringify(first).includes('/private/local/selected.pdf'), false, 'local PDF path is never returned');
  const progress = await collaboration.read({ action: 'get', id: session.session.id, library: 'user' });
  assert.deepEqual(progress.readings[0].deliveredRanges, [[1, 1]]);
  assert.equal(progress.readings[0].nextPage, 2);
  await assert.rejects(collaboration.read({ action: 'read', id: session.session.id, expectedRevision: 2,
    library: 'user', key: sourceFields.itemKey, cursor: 3 }), /游标必须是下一未交付页 2/);
  const last = await collaboration.read({ action: 'read', id: session.session.id, expectedRevision: 2,
    library: 'user', key: sourceFields.itemKey, cursor: 2, maxPages: 2 });
  assert.deepEqual(last.deliveredPages, [2, 3]);
  assert.deepEqual(last.notProcessedPages, []);
  assert.equal(last.nextPage, null);
  assert.deepEqual(last.session.readings[0].deliveredRanges, [[1, 3]]);
  await assert.rejects(collaboration.read({ action: 'read', id: session.session.id, expectedRevision: 3,
    library: 'user', key: sourceFields.itemKey }), /已全部交付/);

  const changedPdfSession = await collaboration.session({ action: 'create', title: 'Changed PDF' });
  await collaboration.read({ action: 'read', id: changedPdfSession.session.id, expectedRevision: 1,
    library: 'user', key: sourceFields.itemKey, maxPages: 1 });
  researchWorkspace.setPdf({ ...researchWorkspace.getPdf(), sha256: hash('pdf-v2') });
  await assert.rejects(collaboration.read({ action: 'read', id: changedPdfSession.session.id, expectedRevision: 2,
    library: 'user', key: sourceFields.itemKey }), /指纹、附件或页数/);
  assert.equal((await collaboration.read({ action: 'get', id: changedPdfSession.session.id })).session.revision, 2);

  const oversized = await collaboration.session({ action: 'create', title: 'Oversized page' });
  researchWorkspace.setPdf({ ...researchWorkspace.getPdf(), pages: [{ page: 1, text: 'x'.repeat(32_001) }] });
  await assert.rejects(collaboration.read({ action: 'read', id: oversized.session.id, expectedRevision: 1,
    library: 'user', key: sourceFields.itemKey }), /超过 32,000 字符/);
  assert.equal((await collaboration.read({ action: 'get', id: oversized.session.id })).session.revision, 1,
    'oversized page rejection does not mark any page delivered');
});

test('direct validation rejects unknown fields before Zotero reads and concurrent writes cannot clobber revisions', async t => {
  const researchWorkspace = fakeResearchWorkspace();
  const { collaboration } = await createWorkspace(t, researchWorkspace);
  const session = await collaboration.session({ action: 'create', title: 'Validation' });
  await assert.rejects(collaboration.sources({ action: 'add', id: session.session.id, expectedRevision: 1,
    sources: [selectedDescriptor()], unexpected: true }), /不支持的字段/);
  await assert.rejects(collaboration.sources({ action: 'add', id: session.session.id, expectedRevision: 1,
    sources: [selectedDescriptor()], sourceIds: [sourceId] }), /不能同时提交/);
  assert.equal(researchWorkspace.calls.paper, 0, 'invalid shapes are rejected before network-backed reads');

  const outcomes = await Promise.allSettled([
    collaboration.sources({ action: 'add', id: session.session.id, expectedRevision: 1, sources: [selectedDescriptor()] }),
    collaboration.sources({ action: 'add', id: session.session.id, expectedRevision: 1, sources: [selectedDescriptor()] })
  ]);
  assert.equal(outcomes.filter(outcome => outcome.status === 'fulfilled').length, 1);
  assert.equal(outcomes.filter(outcome => outcome.status === 'rejected').length, 1);
  const saved = await collaboration.session({ action: 'get', id: session.session.id });
  assert.equal(saved.session.revision, 2);
  assert.equal(saved.session.sourceCount, 1);
});

test('document binding stays inside the selected Markdown project and does not read oversized files first', async t => {
  const { dir, collaboration } = await createWorkspace(t);
  const project = join(dir, 'project'); await mkdir(project);
  const outside = join(dir, 'outside.md'); await writeFile(outside, 'outside');
  const wrongExtension = join(project, 'draft.docx'); await writeFile(wrongExtension, 'not a word document');
  const session = await collaboration.session({ action: 'create', title: 'Bound project', projectPath: project });
  const researchWorkspace = fakeResearchWorkspace();
  const collaborationWithZotero = new CollaborationWorkspace({ stateDir: dir, researchWorkspace });
  await collaborationWithZotero.sources({ action: 'add', id: session.session.id, expectedRevision: 1, sources: [selectedDescriptor()] });
  await assert.rejects(collaborationWithZotero.draft({ id: session.session.id, expectedRevision: 2, docPath: outside,
    paragraphs: [{ text: 'A claim with a selected source.', sourceIds: [sourceId] }] }), /必须位于.*目录内/);
  await assert.rejects(collaborationWithZotero.draft({ id: session.session.id, expectedRevision: 2, docPath: wrongExtension,
    paragraphs: [{ text: 'A claim with a selected source.', sourceIds: [sourceId] }] }), /只支持 \.md/);
});
