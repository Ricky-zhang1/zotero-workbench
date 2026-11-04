import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  configuredResearchModel, RESEARCH_MODEL_ENV, ResearchModelConfigError
} from '../src/domain/research-model-config.mjs';

async function tempState(t) {
  const stateRoot = await mkdtemp(join(tmpdir(), 'research-model-config-'));
  t.after(() => rm(stateRoot, { recursive: true, force: true }));
  return stateRoot;
}

test('operation environment model takes precedence over the shared settings file', async t => {
  const stateRoot = await tempState(t);
  await writeFile(join(stateRoot, 'research-settings.json'), JSON.stringify({ model: 'file-model' }));
  assert.equal(await configuredResearchModel({
    stateRoot, env: { [RESEARCH_MODEL_ENV]: 'env-model' }
  }), 'env-model');
});

test('missing shared settings file leaves the existing CLI model route unchanged', async t => {
  const stateRoot = await tempState(t);
  assert.equal(await configuredResearchModel({ stateRoot, env: {} }), null);
});

test('valid shared model setting is read without modifying it', async t => {
  const stateRoot = await tempState(t);
  const path = join(stateRoot, 'research-settings.json');
  const contents = '{"model":"test-provider-model"}\n';
  await writeFile(path, contents);
  assert.equal(await configuredResearchModel({ stateRoot, env: {} }), 'test-provider-model');
  assert.equal(await readFile(path, 'utf8'), contents);
});

test('invalid environment model and invalid settings are rejected without fallback', async t => {
  const stateRoot = await tempState(t);
  await writeFile(join(stateRoot, 'research-settings.json'), JSON.stringify({ model: 'valid-file-model' }));
  await assert.rejects(configuredResearchModel({
    stateRoot, env: { [RESEARCH_MODEL_ENV]: 'bad model' }
  }), ResearchModelConfigError);
  await writeFile(join(stateRoot, 'research-settings.json'), JSON.stringify({ model: 'not a model' }));
  await assert.rejects(configuredResearchModel({ stateRoot, env: {} }), ResearchModelConfigError);
  await writeFile(join(stateRoot, 'research-settings.json'), JSON.stringify({ model: 'valid-model', other: true }));
  await assert.rejects(configuredResearchModel({ stateRoot, env: {} }), ResearchModelConfigError);
});
