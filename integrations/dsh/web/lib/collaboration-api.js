const ACTIONS = new Set(['session', 'sources', 'draft', 'feedback', 'read']);

export function collaborationRequestEnvelope(action, args = {}) {
  if (!ACTIONS.has(action)) throw new Error(`不支持的协作操作：${action}`);
  if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error('协作参数必须是对象。');
  return { action, args };
}
