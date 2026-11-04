// HTTP client for the existing Zotero MCP plugin (127.0.0.1:23120/mcp).
import { localUrl } from '../domain/library.mjs';
import packageInfo from '../../package.json' with { type: 'json' };

export class RickyClient {
  constructor(url = 'http://127.0.0.1:23120/mcp', fetcher = fetch) {
    this.url = localUrl(url, 'http://127.0.0.1:23120/mcp').href;
    this.fetcher = fetcher; this.id = 0; this.session = null; this.pending = null;
  }
  async request(method, params, notification = false, timeout = 45000) {
    const id = notification ? undefined : ++this.id;
    const response = await this.fetcher(this.url, {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(timeout),
      headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream',
        ...(this.session ? { 'Mcp-Session-Id': this.session, 'MCP-Protocol-Version': this.protocol } : {}) },
      body: JSON.stringify({ jsonrpc: '2.0', ...(notification ? {} : { id }), method, params })
    });
    if (!response.ok) {
      await response.body?.cancel();
      if (response.status === 404) { this.session = null; this.pending = null; }
      throw Object.assign(new Error(`Zotero MCP HTTP ${response.status}`), { status: response.status });
    }
    const session = response.headers.get('mcp-session-id'); if (session) this.session = session;
    if (notification || response.status === 202) { await response.body?.cancel(); return {}; }
    let result;
    if ((response.headers.get('content-type') || '').includes('text/event-stream')) {
      const reader = response.body.getReader(); const decoder = new TextDecoder(); let buffer = '';
      try {
        while (!result) {
          const { value, done } = await reader.read(); buffer += decoder.decode(value || new Uint8Array(), { stream: !done });
          buffer = buffer.replace(/\r\n/g, '\n');
          if (buffer.length > 16 * 1024 * 1024) throw new Error('Zotero MCP frame exceeds 16 MiB');
          let boundary;
          while ((boundary = buffer.indexOf('\n\n')) >= 0) {
            const frame = buffer.slice(0, boundary); buffer = buffer.slice(boundary + 2);
            const data = frame.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
            if (!data) continue; const message = JSON.parse(data); if (message.id === id) result = message;
          }
          if (done) break;
        }
      } finally { await reader.cancel().catch(() => {}); }
    } else result = await response.json();
    if (!result || result.id !== id) throw new Error('Zotero MCP did not return the matching response');
    if (result.error) throw new Error(result.error.message);
    return result.result;
  }
  async ready() {
    if (!this.pending) this.pending = (async () => {
      const init = await this.request('initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'zotero-workbench', version: packageInfo.version } });
      this.protocol = init.protocolVersion; await this.request('notifications/initialized', {}, true); return init;
    })().catch(error => { this.pending = null; throw error; });
    return this.pending;
  }
  async withSession(method, params, { readOnly = false, timeout = 45000 } = {}) {
    await this.ready();
    try { return await this.request(method, params, false, timeout); }
    catch (error) {
      // Retry only an explicitly read-only request on a conclusively expired session.
      // Never replay a write or an ambiguous network timeout.
      if (!readOnly || error.status !== 404) throw error;
      await this.ready(); return this.request(method, params, false, timeout);
    }
  }
  async call(name, args, { readOnly = false } = {}) { return this.withSession('tools/call', { name, arguments: args }, { readOnly, timeout: 180000 }); }
  async list() { return this.withSession('tools/list', {}, { readOnly: true }); }
  async close(timeout = 2000) {
    if (!this.session) return;
    try { await this.fetcher(this.url, { method: 'DELETE', redirect: 'error', signal: AbortSignal.timeout(timeout), headers: { 'Mcp-Session-Id': this.session } }); } catch {}
    this.session = null; this.pending = null;
  }
}
