import assert from 'node:assert/strict';
import test from 'node:test';
import { translationCliFailureMessage } from '../src/domain/translation-cli-error.mjs';

test('unsupported ChatGPT account model errors become specific and safe translation guidance', () => {
  const message = translationCliFailureMessage(
    "The 'gpt-6.1-sol' model is not supported when using Codex with a ChatGPT account."
  );
  assert.match(message, /Codex ChatGPT 账号不支持/);
  assert.match(message, /gpt-6\.1-sol/);
  assert.match(message, /不会自动更换模型或服务/);
});

test('unknown model route failures are identified without returning raw CLI output', () => {
  const message = translationCliFailureMessage('model_not_found: requested model was not found');
  assert.match(message, /路由未找到所选模型/);
  assert.equal(translationCliFailureMessage('arbitrary CLI output'), null);
  assert.equal(translationCliFailureMessage('Authorization: Bearer hidden-value'), null);
});
