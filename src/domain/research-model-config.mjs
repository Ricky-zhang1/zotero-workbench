import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';

export const RESEARCH_MODEL_ENV = 'ZOTERO_WORKBENCH_RESEARCH_MODEL';
export const RESEARCH_SETTINGS_FILENAME = 'research-settings.json';

const modelPattern = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,99}$/;
const isRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value);

export class ResearchModelConfigError extends Error {
  constructor(message = '研究模型设置无效；请检查 research-settings.json 中的 model 字段。') {
    super(message);
    this.name = 'ResearchModelConfigError';
  }
}

export function validateResearchModel(value) {
  if (typeof value !== 'string') throw new ResearchModelConfigError();
  const model = value.trim();
  if (!model || !modelPattern.test(model)) throw new ResearchModelConfigError();
  return model;
}

/** Resolve the per-operation model without changing the process or Codex configuration. */
export async function configuredResearchModel({ stateRoot, env = process.env } = {}) {
  const environmentModel = typeof env?.[RESEARCH_MODEL_ENV] === 'string'
    ? env[RESEARCH_MODEL_ENV].trim()
    : '';
  if (environmentModel) return validateResearchModel(environmentModel);

  const configuredRoot = typeof stateRoot === 'string' && stateRoot.trim()
    ? stateRoot
    : typeof env?.ZOTERO_WORKBENCH_STATE_DIR === 'string' && env.ZOTERO_WORKBENCH_STATE_DIR.trim()
      ? env.ZOTERO_WORKBENCH_STATE_DIR.trim()
      : join(homedir(), '.local/share/zotero-workbench');
  let raw;
  try {
    raw = await readFile(join(configuredRoot, RESEARCH_SETTINGS_FILENAME), 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw new ResearchModelConfigError('无法读取 research-settings.json；研究任务未启动。');
  }

  let settings;
  try { settings = JSON.parse(raw); }
  catch { throw new ResearchModelConfigError(); }
  if (!isRecord(settings) || Object.keys(settings).some(key => key !== 'model'))
    throw new ResearchModelConfigError();
  if (!Object.hasOwn(settings, 'model')) return null;
  return validateResearchModel(settings.model);
}
