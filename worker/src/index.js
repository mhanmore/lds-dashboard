const FRESH_MS = 36 * 60 * 60 * 1000;
const KEYS = ['data/data.json'];

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname === '/health') return json({ ok: true });
    if (url.pathname !== '/api/data') return new Response('Not found', { status: 404 });
    const key = 'data/data.json';
    const cached = await env.DATA.get(key, 'json');
    if (!cached) return json({ error: 'baseline_missing', message: 'No baseline artifact is available. Run the build-time backfill.' }, 503);
    const stale = Date.now() - new Date(cached.metadata.generated_at).getTime() >= FRESH_MS;
    if (stale) {
      // The lock is deliberately short-lived. A durable object can replace this
      // best-effort single-flight lock for deployments requiring strict coalescing.
      const lock = await env.DATA.get('refresh-lock');
      if (!lock) {
        ctx.waitUntil(refresh(env, cached));
        return json({ ...cached, metadata: { ...cached.metadata, refresh_in_progress: true } });
      }
    }
    const refreshError = await env.DATA.get('refresh-error', 'json');
    return json(refreshError ? { ...cached, metadata: { ...cached.metadata, refresh_error: refreshError.message } } : cached);
  }
};

async function refresh(env, previous) {
  await env.DATA.put('refresh-lock', new Date().toISOString(), { expirationTtl: 300 });
  try {
    // Incremental PLD retrieval is intentionally delegated to the build-time
    // pipeline. Configure an endpoint only when the API contract is verified.
    if (!env.PLD_INCREMENTAL_URL) return;
    const response = await fetch(env.PLD_INCREMENTAL_URL, { headers: { accept: 'application/json' } });
    if (!response.ok) throw new Error(`PLD returned ${response.status}`);
    const next = await response.json();
    if (!next.metadata || !Array.isArray(next.annual_summary)) throw new Error('Invalid processed artifact');
    next.metadata.generated_at = new Date().toISOString();
    await env.DATA.put('data/data.json', JSON.stringify(next));
  } catch (error) {
    await env.DATA.put('refresh-error', JSON.stringify({ at: new Date().toISOString(), message: error.message }), { expirationTtl: 86400 });
  } finally { await env.DATA.delete('refresh-lock'); }
}

function json(value, status=200) { return new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } }); }
