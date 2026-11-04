// Transport hardening for the pinned vendor local-API client (read path).
// The client/probe itself ships in dist/runtime.mjs (fixed upstream, P7).
// The upstream UI assumes unbounded collection/annotation requests are complete.
// Zotero can paginate those responses: follow Total-Results and reject inconsistent pages.
export function installPagination(client) {
  const original = client.getJson.bind(client);
  client.getJson = async (path, options = {}) => {
    const url = new URL(path, 'http://127.0.0.1');
    const eligible = !url.searchParams.has('limit') && !url.searchParams.has('start') &&
      /\/(collections|searches|children|items|items\/top|groups)$/.test(url.pathname);
    if (!eligible) return original(path, options);
    url.searchParams.set('limit', '100');
    const first = await original(url.pathname + url.search, options);
    if (!Array.isArray(first.data)) return first;
    const header = first.response.headers.get('total-results');
    if (header === null) throw new Error('Zotero omitted Total-Results; completeness cannot be confirmed');
    const total = Number(header);
    if (!Number.isInteger(total) || total < first.data.length || total > 100000) throw new Error('Invalid Zotero pagination total');
    const data = [...first.data];
    const version = first.response.headers.get('last-modified-version');
    while (data.length < total) {
      url.searchParams.set('start', String(data.length));
      const next = await original(url.pathname + url.search, options);
      if (!Array.isArray(next.data) || !next.data.length) throw new Error('Zotero returned an incomplete page');
      if (Number(next.response.headers.get('total-results')) !== total || next.response.headers.get('last-modified-version') !== version)
        throw new Error('Zotero changed during reading; refresh this view');
      data.push(...next.data);
    }
    if (data.length !== total) throw new Error('Zotero returned more items than Total-Results');
    const keys = data.map(row => row.key ?? row.id);
    if (new Set(keys).size !== data.length) throw new Error('Zotero returned overlapping pages');
    return { ...first, data };
  };
}
