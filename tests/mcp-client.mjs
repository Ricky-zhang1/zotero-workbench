import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
export class StdioClient {
  constructor(env = {}) {
    const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
    this.process = spawn(process.execPath, [resolve(root, 'src/server.mjs')], { cwd: root, env: { ...process.env, ...env }, stdio: ['pipe', 'pipe', 'pipe'] });
    this.id = 0; this.pending = new Map(); this.stderr = '';
    this.process.stderr.on('data', data => { this.stderr += data.toString(); });
    createInterface({ input: this.process.stdout }).on('line', line => {
      let reply; try { reply = JSON.parse(line); } catch { return; }
      const pending = this.pending.get(reply.id); if (!pending) return;
      clearTimeout(pending.timer); this.pending.delete(reply.id);
      reply.error ? pending.reject(new Error(JSON.stringify(reply.error))) : pending.resolve(reply.result);
    });
    this.process.on('exit', code => { for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(new Error(`Server exited ${code}: ${this.stderr}`)); } this.pending.clear(); });
  }
  request(method, params = {}, timeout = 45000) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {this.pending.delete(id);reject(new Error(`Timeout: ${method}`));}, timeout);
      this.pending.set(id, { resolve, reject, timer });
      this.process.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
  }
  async ready() {
    const result = await this.request('initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'workbench-test', version: '1.0.0' } });
    this.process.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
    return result;
  }
  call(name, args = {}, timeout) { return this.request('tools/call', { name, arguments: args }, timeout); }
  read(uri) { return this.request('resources/read', { uri }); }
  close() { this.process.stdin.end(); const timer = setTimeout(() => this.process.kill('SIGTERM'), 1000); timer.unref(); }
}
