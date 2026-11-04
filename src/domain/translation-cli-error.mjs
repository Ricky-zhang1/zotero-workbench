const UNSUPPORTED_CHATGPT_MODEL = /The\s+['"]([A-Za-z0-9][A-Za-z0-9._/-]{0,99})['"]\s+model\s+is not supported when using Codex with a ChatGPT account/i;

/** Return a safe, user-facing diagnosis for known CLI model-routing failures. */
export function translationCliFailureMessage(stderr) {
  const text = typeof stderr === 'string' ? stderr : '';
  const unsupported = UNSUPPORTED_CHATGPT_MODEL.exec(text);
  if (unsupported) {
    const model = unsupported[1];
    return `当前 Codex ChatGPT 账号不支持已配置模型“${model}”，本次翻译未完成。请先确认该账号可用的 Codex 模型，再重试；工作台不会自动更换模型或服务。`;
  }

  if (/\bmodel_not_found\b|unknown model|model (?:is )?not found/i.test(text)) {
    return '当前 Codex 路由未找到所选模型，本次翻译未完成。请核对 Codex 当前模型与 OpenCodex 模型目录；工作台不会自动更换服务。';
  }

  return null;
}
