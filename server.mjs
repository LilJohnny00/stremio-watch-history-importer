/** server.mjs — local web server for the Stremio Watch History Importer GUI. */
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { Trakt, runItems, dedupe, readJson, writeJson, startDeviceCode, pollDeviceToken } from './matcher.mjs';
import { parseByService } from './parsers.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = 8787;
const CONFIG_PATH = join(__dirname, 'config.json');
const TOKEN_PATH = join(__dirname, 'token.json');

let parsed = { service: null, items: [] };
let device = null;
let cancelFlag = false;

const send = (res, code, obj, type = 'application/json') => { res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store' }); res.end(type === 'application/json' ? JSON.stringify(obj) : obj); };
const body = (req) => new Promise((resolve) => { let b = ''; req.on('data', (c) => { b += c; if (b.length > 60 * 1024 * 1024) req.destroy(); }); req.on('end', () => resolve(b)); });

const buildCrunchyrollScript = (auth, accountId) => {
	const A = JSON.stringify(auth || 'PASTE_THE_AUTHORIZATION_VALUE_HERE');
	const ID = JSON.stringify(accountId || 'PASTE_THE_ACCOUNT_ID_HERE');
	return `/* Crunchyroll history export — paste this whole block into the Console (F12) on your Crunchyroll history page, then press Enter. */
const AUTH = ${A};
const ACCOUNT_ID = ${ID};
(async () => {
  const base = \`https://www.crunchyroll.com/content/v2/\${ACCOUNT_ID}/watch-history\`;
  const pageSize = 100, seen = new Set(), out = [];
  for (let page = 1; page <= 60; page++) {
    const res = await fetch(\`\${base}?page_size=\${pageSize}&page=\${page}&locale=en-US\`, {
      headers: { authorization: AUTH.startsWith('Bearer') ? AUTH : 'Bearer ' + AUTH }, credentials: 'include' });
    if (!res.ok) { console.error('Failed', res.status, await res.text()); break; }
    const json = await res.json(); const items = json.items || json.data || []; if (!items.length) break;
    let added = 0;
    for (const it of items) { const id = it.panel?.id || it.id; if (seen.has(id)) continue; seen.add(id); added++;
      const m = (it.panel || {}).episode_metadata || {};
      out.push({ cr_episode_id: it.panel?.id || it.id, cr_series_id: m.series_id, show: m.series_title, season: m.season_number, number: m.episode_number, sequence_number: m.sequence_number, title: it.panel?.title, audio_locale: m.audio_locale }); }
    console.log(\`page \${page}: +\${added} (total \${out.length})\`);
    if (items.length < pageSize || added === 0) break; await new Promise(r => setTimeout(r, 300));
  }
  const blob = new Blob([JSON.stringify(out, null, 2)], { type: 'application/json' });
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = 'crunchyroll-history-full.json'; a.click();
  console.log('DONE. Exported', out.length, 'items.');
})();`;
};

const PRIME_SCRIPT = `/* Prime Video history export — go to https://www.primevideo.com/settings/watch-history (your profile), open Console (F12), paste this whole block, press Enter. Downloads primevideo-history.json to upload in the app. */
(async () => {
  const base = 'https://www.primevideo.com/settings/watch-history';
  const out = []; let token = null, page = 0;
  const findActivity = (html) => { const doc = new DOMParser().parseFromString(html, 'text/html'); for (const t of [...doc.querySelectorAll('script[type="text/template"]')]) { const txt = t.textContent || ''; if (txt.indexOf('ActivityHistoryItems') === -1) continue; let json; try { json = JSON.parse(txt); } catch { continue; } const widgets = (json.props && json.props.widgets) || []; for (const w of widgets) if (w.widgetType === 'watch-history' && w.content && w.content.content) return w.content.content; } return null; };
  const cleanSeries = (raw) => { let s = (raw || '').trim(); let season = 1; const m = s.match(/[\\-\\u2013:,]\\s*(?:season|series)\\s*(\\d+)\\s*$/i); if (m) { season = parseInt(m[1], 10); s = s.slice(0, m.index).trim(); } s = s.replace(/[\\-\\u2013:,]\\s*$/, '').trim(); return { show: s, season }; };
  const parseEp = (raw) => { const t = (raw || '').trim(); let m = t.match(/^episode\\s*(\\d+)\\s*:\\s*(.*)$/i); if (m) return { number: parseInt(m[1], 10), title: m[2].trim() || undefined }; m = t.match(/^episode\\s*(\\d+)\\s*$/i); if (m) return { number: parseInt(m[1], 10), title: undefined }; return { title: t }; };
  const seen = new Set(); const push = (item) => { const k = item.type === 'movie' ? 'm|' + (item.title || '').toLowerCase() : 'e|' + (item.show || '').toLowerCase() + '|' + item.season + '|' + ((item.title || item.number || '') + '').toLowerCase(); if (seen.has(k)) return; seen.add(k); out.push(item); };
  do {
    const url = token ? base + '?nextToken=' + encodeURIComponent(token) + '&ref_=atv_set_wh' : base;
    const res = await fetch(url, { credentials: 'include' }); if (!res.ok) { console.error('Fetch failed', res.status); break; }
    const ah = findActivity(await res.text()); if (!ah) { console.warn('No history block found (logged in / correct page?).'); break; }
    for (const grp of ah.titles || []) { const date = grp.date || ''; for (const t of grp.titles || []) {
      if (t.titleType === 'movie') { const name = (t.title && t.title.text) || ''; if (name) push({ service: 'amazon', type: 'movie', show: name, title: name, watched_date: date }); }
      else if ((t.children && t.children.length) || t.titleType === 'season') { const cs = cleanSeries((t.title && t.title.text) || ''); for (const c of t.children || []) { const ep = parseEp((c.title && c.title.text) || ''); push({ service: 'amazon', type: 'episode', show: cs.show || ((t.title && t.title.text) || ''), season: cs.season, number: ep.number, title: ep.title, watched_date: date }); } }
      else if (t.titleType === 'episode') { const ep = parseEp((t.title && t.title.text) || ''); push({ service: 'amazon', type: 'episode', show: (t.title && t.title.text) || '', season: 1, number: ep.number, title: ep.title, watched_date: date }); }
    } }
    token = ah.nextToken || null; page++; console.log('page ' + page + ': total ' + out.length); await new Promise(r => setTimeout(r, 400));
  } while (token && page < 300);
  const blob = new Blob([JSON.stringify(out, null, 2)], { type: 'application/json' });
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = 'primevideo-history.json'; a.click();
  const movies = out.filter(o => o.type === 'movie').length;
  console.log('DONE. Exported ' + out.length + ' items (' + (out.length - movies) + ' episodes, ' + movies + ' movies).');
})();`;

const server = createServer(async (req, res) => {
	try {
		const host = req.headers.host || '';
if (!(host === `127.0.0.1:${PORT}` || host === `localhost:${PORT}`) || req.headers['sec-fetch-site'] === 'cross-site') return send(res, 403, { error: 'forbidden' });
		const p = url.pathname;
		if (p === '/' || p === '/index.html') return send(res, 200, await readFile(join(__dirname, 'index.html'), 'utf8'), 'text/html');
		if (p === '/crunchyroll-help.html') return send(res, 200, await readFile(join(__dirname, 'crunchyroll-help.html'), 'utf8'), 'text/html');
		if (p === '/primevideo-help.html') return send(res, 200, await readFile(join(__dirname, 'primevideo-help.html'), 'utf8'), 'text/html');

		if (p === '/api/status') { const cfg = await readJson(CONFIG_PATH, null); const token = await readJson(TOKEN_PATH, null); return send(res, 200, { hasConfig: !!(cfg && cfg.client_id && cfg.client_secret), hasToken: !!(token && token.access_token) }); }
		if (p === '/api/save-config' && req.method === 'POST') { const { client_id, client_secret } = JSON.parse(await body(req)); if (!client_id || !client_secret) return send(res, 400, { error: 'client_id and client_secret required' }); await writeJson(CONFIG_PATH, { client_id: client_id.trim(), client_secret: client_secret.trim() }); return send(res, 200, { ok: true }); }
		if (p === '/api/auth-start' && req.method === 'POST') { const cfg = await readJson(CONFIG_PATH, null); if (!cfg?.client_id) return send(res, 400, { error: 'Save your Client ID/Secret first.' }); const dc = await startDeviceCode(cfg.client_id); device = { device_code: dc.device_code, interval: dc.interval || 5, expires: Date.now() + (dc.expires_in || 600) * 1000, client_id: cfg.client_id, client_secret: cfg.client_secret }; return send(res, 200, { user_code: dc.user_code, verification_url: dc.verification_url || 'https://trakt.tv/activate', interval: Math.max(dc.interval || 5, 5) }); }
		if (p === '/api/auth-poll' && req.method === 'POST') { if (!device) return send(res, 200, { status: 'idle' }); if (Date.now() > device.expires) { device = null; return send(res, 200, { status: 'expired' }); } const r = await pollDeviceToken(device.device_code, device.client_id, device.client_secret); if (r.token) { await writeJson(TOKEN_PATH, r.token); device = null; return send(res, 200, { status: 'ok' }); } if (r.error) { device = null; return send(res, 200, { status: 'error', detail: r.error }); } return send(res, 200, { status: 'pending' }); }

		if (p === '/api/crunchyroll-script' && req.method === 'POST') { const { auth, account_id } = JSON.parse(await body(req)); return send(res, 200, { script: buildCrunchyrollScript(auth, account_id) }); }
		if (p === '/api/primevideo-script') return send(res, 200, { script: PRIME_SCRIPT });

		if (p === '/api/parse' && req.method === 'POST') { const { service, content, profile } = JSON.parse(await body(req)); try { const out = parseByService(service, content, { profile }); if (out.items && out.items.length) parsed = { service, items: dedupe(out.items) }; const counts = { episodes: (out.items || []).filter((i) => i.type === 'episode').length, movies: (out.items || []).filter((i) => i.type === 'movie').length }; return send(res, 200, { ok: true, count: (out.items || []).length, counts, profiles: out.profiles || null }); } catch (e) { return send(res, 200, { ok: false, error: e.message }); } }
		if (p === '/api/cancel' && req.method === 'POST') { cancelFlag = true; return send(res, 200, { ok: true }); }

		if (p === '/api/run') {
			const mode = url.searchParams.get('mode') === 'commit' ? 'commit' : 'dry-run';
			if (!parsed.items.length) return send(res, 400, { error: 'Upload & parse a file first.' });
			const cfg = await readJson(CONFIG_PATH, null); const token = await readJson(TOKEN_PATH, null);
			if (!cfg?.client_id || !token?.access_token) return send(res, 400, { error: 'Not logged in.' });
			cancelFlag = false;
			res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
			const evt = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
			const trakt = new Trakt(cfg.client_id, cfg.client_secret, token);
			try { const out = await runItems(trakt, parsed.items, { mode, onLog: (line) => evt('log', line), onProgress: (done, total) => evt('progress', { done, total }), shouldCancel: () => cancelFlag }); const n = (k) => out.results[k].length; evt('done', { summary: { high: n('high'), medium: n('medium'), low: n('low'), none: n('none'), errors: n('errors') }, wouldWrite: out.wouldWrite, added: out.added, mode, cancelled: out.cancelled }); }
			catch (e) { evt('fatal', { error: e.message === 'AUTH_401' ? 'Trakt login expired — log in again and retry.' : e.message }); }
			return res.end();
		}
		send(res, 404, { error: 'not found' });
	} catch (e) { try { send(res, 500, { error: e.message }); } catch { /* ignore */ } }
});

server.listen(PORT, '127.0.0.1', () => { console.log('\n  Stremio Watch History Importer is running.'); console.log('  Open this in your browser:  http://127.0.0.1:' + PORT + '\n'); console.log('  (Keep this window open while you use the app. Close it when done.)\n'); });
