/** matcher.mjs — Trakt matching engine. Episodes + movies, prefix backoff,
 *  absolute numbering, title-search fallback, dedupe, cancellable. */
import { readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';

export const TRAKT = process.env.TRAKT_BASE || 'https://api.trakt.tv';
export const USER_AGENT = 'trakt-backfill-app/1.3 (+local personal tool)';

export const readJson = async (path, fallback = undefined) => { if (!existsSync(path)) return fallback; try { return JSON.parse(await readFile(path, 'utf8')); } catch { return fallback; } };
export const writeJson = (path, obj) => writeFile(path, JSON.stringify(obj, null, 2));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const romanToArabic = (raw) => { const t = raw.toLowerCase(); if (!/^[ivxlcdm]+$/.test(t)) return null; const v = { i: 1, v: 5, x: 10, l: 50, c: 100, d: 500, m: 1000 }; let total = 0, prev = 0; for (let i = t.length - 1; i >= 0; i--) { const val = v[t[i]]; if (val === undefined) return null; if (val < prev) total -= val; else { total += val; prev = val; } } return total > 0 && total < 4000 ? total : null; };
const SEASON_LABELS = ['season','saison','temporada','staffel','stagione','part','parte','cour','vol','volume','series','chapter'];
const LABEL_RE = new RegExp(`\\b(?:${SEASON_LABELS.join('|')})\\b\\.?\\s*(?:[0-9]+|[ivxlcdm]+)?`, 'gi');
const normalize = (raw) => { if (!raw) return ''; let v = raw.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').normalize('NFKC').toLowerCase(); v = v.replace(/&/g, ' and ').replace(LABEL_RE, ' '); return v.split(/[^a-z0-9\u3040-\u30ff\u4e00-\u9fff]+/).filter(Boolean).map((tk) => { const a = romanToArabic(tk); return a !== null ? String(a) : tk; }).join(' ').trim(); };
const normalizeEp = (raw) => { if (!raw) return ''; let v = raw.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').normalize('NFKC').toLowerCase(); v = v.replace(/[\u00d7\u2715\u2716]/g, ' ').replace(/&/g, ' and ').replace(/\b x \b/g, ' '); return v.split(/[^a-z0-9\u3040-\u30ff\u4e00-\u9fff]+/).filter(Boolean).join(' ').trim(); };
const bigrams = (s) => { const m = new Map(); for (let i = 0; i < s.length - 1; i++) { const g = s.slice(i, i + 2); m.set(g, (m.get(g) || 0) + 1); } return m; };
const dice = (a, b) => { if (a === b) return 1; if (a.length < 2 || b.length < 2) return 0; const A = bigrams(a), B = bigrams(b); let inter = 0, at = 0, bt = 0; for (const c of A.values()) at += c; for (const [g, c] of B) { const x = A.get(g); if (x) inter += Math.min(x, c); bt += c; } return (2 * inter) / (at + bt); };
const simCore = (na, nb) => { if (!na || !nb) return 0; if (na === nb) return 1; const d = dice(na, nb); const sa = new Set(na.split(' ')), sb = new Set(nb.split(' ')); let sh = 0; for (const t of sa) if (sb.has(t)) sh++; return Math.max(d, sh / Math.max(sa.size, sb.size)); };
const titleSim = (a, b) => simCore(normalize(a), normalize(b));
const epTitleSim = (a, b) => simCore(normalizeEp(a), normalizeEp(b));
const showNameCandidates = (show) => { const out = []; const push = (s) => { const t = s.trim(); if (t && !out.includes(t)) out.push(t); }; push(show); const parts = show.split(':').map((p) => p.trim()).filter(Boolean); for (let cut = parts.length - 1; cut >= 1; cut--) push(parts.slice(0, cut).join(': ')); const dash = show.split(/\s[-\u2013]\s/); if (dash.length > 1) push(dash[0]); return out; };
const parseYear = (item) => { if (item.year) return item.year; const d = item.watched_date || item.releaseDate; if (d) { const m = String(d).match(/(19|20)\d{2}/); if (m) return parseInt(m[0], 10); } return undefined; };
const realSeasons = (seasons) => seasons.filter((s) => s.season >= 1 && s.count > 0).sort((a, b) => a.season - b.season);
const absoluteToSE = (seasons, abs) => { if (!Number.isFinite(abs) || abs < 1) return null; let rem = abs; for (const s of realSeasons(seasons)) { if (rem <= s.count) return { season: s.season, number: rem }; rem -= s.count; } return null; };

export class Trakt {
	constructor(clientId, clientSecret, token) { this.clientId = clientId; this.clientSecret = clientSecret; this.token = token; this.showCache = new Map(); this.movieCache = new Map(); this.seasonCache = new Map(); this.epCache = new Map(); }
	headers(auth = true) { const h = { 'Content-Type': 'application/json', 'User-Agent': USER_AGENT, 'trakt-api-version': '2', 'trakt-api-key': this.clientId }; if (auth && this.token?.access_token) h.Authorization = `Bearer ${this.token.access_token}`; return h; }
	async req(path, { method = 'GET', body, auth = true } = {}) { for (let attempt = 1; ; attempt++) { const res = await fetch(`${TRAKT}${path}`, { method, headers: this.headers(auth), body: body ? JSON.stringify(body) : undefined }); if (res.status === 429) { const w = (parseInt(res.headers.get('retry-after') || '2', 10)) * 1000; await sleep(w); continue; } if (res.status === 401) throw new Error('AUTH_401'); if (res.status >= 500 && attempt < 4) { await sleep(500 * 2 ** attempt); continue; } if (!res.ok) { const t = await res.text().catch(() => ''); throw new Error(`Trakt ${res.status} on ${path}: ${t.slice(0, 160)}`); } await sleep(120); if (res.status === 204) return null; return res.json(); } }
	async searchShows(title) { const key = normalize(title); if (this.showCache.has(key)) return this.showCache.get(key); const ex = await this.req(`/search/show/exact?query=${encodeURIComponent(title)}&extended=full&limit=5`).catch(() => []); const br = await this.req(`/search/show?query=${encodeURIComponent(title)}&extended=full&limit=15`).catch(() => []); const seen = new Map(); for (const r of [...(ex || []), ...(br || [])]) { const s = r.show; if (s && !seen.has(s.ids.trakt)) seen.set(s.ids.trakt, { traktId: s.ids.trakt, title: s.title, year: s.year }); } const list = [...seen.values()]; this.showCache.set(key, list); return list; }
	async searchShowsBackoff(show) { const cands = showNameCandidates(show); const base = cands[cands.length - 1]; const byId = new Map(); for (const q of cands) { const hits = await this.searchShows(q); for (const h of hits) if (!byId.has(h.traktId)) byId.set(h.traktId, h); if (byId.size && q === base) break; } return { shows: [...byId.values()], base }; }
	async searchMovies(title) { const key = normalize(title); if (this.movieCache.has(key)) return this.movieCache.get(key); const ex = await this.req(`/search/movie/exact?query=${encodeURIComponent(title)}&extended=full&limit=5`).catch(() => []); const br = await this.req(`/search/movie?query=${encodeURIComponent(title)}&extended=full&limit=15`).catch(() => []); const seen = new Map(); for (const r of [...(ex || []), ...(br || [])]) { const m = r.movie; if (m && !seen.has(m.ids.trakt)) seen.set(m.ids.trakt, { traktId: m.ids.trakt, title: m.title, year: m.year, released: m.released }); } const list = [...seen.values()]; this.movieCache.set(key, list); return list; }
	async seasons(showId) { if (this.seasonCache.has(showId)) return this.seasonCache.get(showId); const raw = await this.req(`/shows/${showId}/seasons?extended=full`); const info = (raw || []).map((s) => ({ season: s.number, count: s.aired_episodes ?? s.episode_count ?? 0 })).filter((s) => s.count > 0); this.seasonCache.set(showId, info); return info; }
	async episodes(showId, season) { const key = `${showId}|${season}`; if (this.epCache.has(key)) return this.epCache.get(key); const raw = await this.req(`/shows/${showId}/seasons/${season}?extended=full`); const eps = (raw || []).map((e) => ({ traktId: e.ids.trakt, season: e.season, number: e.number, title: e.title, firstAired: e.first_aired })); this.epCache.set(key, eps); return eps; }
	async existingEpisodeHistoryIds(showId) { const set = new Set(); let page = 1; while (page <= 30) { const rows = await this.req(`/sync/history/shows/${showId}?limit=100&page=${page}`).catch(() => []); if (!rows || !rows.length) break; for (const r of rows) if (r.episode?.ids?.trakt) set.add(r.episode.ids.trakt); if (rows.length < 100) break; page++; } return set; }
	async existingMovieHistoryIds(movieId) { const rows = await this.req(`/sync/history/movies/${movieId}?limit=10`).catch(() => []); const set = new Set(); for (const r of rows || []) if (r.movie?.ids?.trakt) set.add(r.movie.ids.trakt); return set; }
}

const matchEpisode = async (trakt, item) => {
	if (!item.show || !item.show.trim()) return null; // no series name -> unmatchable
	const { shows } = await trakt.searchShowsBackoff(item.show);
	let best = null; const consider = (c) => { if (!best || c.score > best.score) best = c; };
	const prefixes = showNameCandidates(item.show); const seriesSim = (t) => Math.max(...prefixes.map((p) => titleSim(p, t)));
	for (const show of shows.slice(0, 6)) { const sim = seriesSim(show.title); if (sim < 0.55) continue; const seasons = await trakt.seasons(show.traktId); const layouts = []; if (item.season != null && item.number != null) layouts.push({ season: item.season, number: item.number, via: 'direct' }); const absN = item.sequence_number ?? item.number; if (absN != null) { const abs = absoluteToSE(seasons, absN); if (abs) layouts.push({ ...abs, via: 'absolute' }); } for (const L of layouts) { const eps = await trakt.episodes(show.traktId, L.season); const ep = eps.find((e) => e.number === L.number); if (!ep) continue; const tSim = item.title && ep.title ? epTitleSim(item.title, ep.title) : 0; const score = sim * 10 + (L.via === 'direct' ? 22 : 20) + tSim * 18; const reasons = [sim >= 0.92 ? 'series matches' : 'series similar', L.via === 'absolute' ? 'absolute number remapped' : 'direct number']; if (tSim >= 0.9) reasons.push('episode title matches'); else if (tSim >= 0.6) reasons.push('episode title similar'); consider({ kind: 'episode', show, ep, via: L.via, score, tSim, sim, reasons }); } }
	if ((!best || best.tSim < 0.6) && item.title) { for (const show of shows.slice(0, 6)) { const sim = seriesSim(show.title); if (sim < 0.55) continue; const seasons = await trakt.seasons(show.traktId); for (const s of seasons) { const eps = await trakt.episodes(show.traktId, s.season); for (const ep of eps) { if (!ep.title) continue; const tSim = epTitleSim(item.title, ep.title); if (tSim >= 0.8) { const score = sim * 10 + 30 + tSim * 18; consider({ kind: 'episode', show, ep, via: 'title', score, tSim, sim, reasons: [sim >= 0.92 ? 'series matches' : 'series similar', 'matched by episode title'] }); } } } } }
	return best;
};
const matchMovie = async (trakt, item) => { const title = item.title || item.show; const year = parseYear(item); const movies = await trakt.searchMovies(title); let best = null; for (const mv of movies.slice(0, 8)) { const sim = titleSim(title, mv.title); if (sim < 0.7) continue; let score = sim * 30; const reasons = [sim >= 0.97 ? 'title matches' : 'title similar']; if (year && mv.year) { if (year === mv.year) { score += 12; reasons.push('year matches'); } else if (Math.abs(year - mv.year) <= 1) score += 4; else if (Math.abs(year - mv.year) >= 4) score -= 8; } const exact = normalize(title) === normalize(mv.title); if (exact) score += 15; const cand = { kind: 'movie', movie: mv, score, sim, tSim: sim, reasons, exact }; if (!best || cand.score > best.score) best = cand; } return best; };
const bandOf = (c) => { if (!c) return 'none'; if (c.kind === 'movie') { if (c.exact || c.sim >= 0.92) return 'high'; if (c.sim >= 0.75) return 'medium'; return 'low'; } if (c.sim >= 0.85 && c.tSim >= 0.85) return 'high'; if (c.sim >= 0.85 && c.via === 'direct' && c.tSim >= 0.6) return 'high'; if (c.sim >= 0.6 && c.score >= 30) return 'medium'; return 'low'; };
const summarise = (c) => c.kind === 'movie' ? { kind: 'movie', title: c.movie.title, year: c.movie.year, movieTraktId: c.movie.traktId, score: +c.score.toFixed(1), reasons: c.reasons } : { kind: 'episode', showTitle: c.show.title, epTraktId: c.ep.traktId, showTraktId: c.show.traktId, season: c.ep.season, number: c.ep.number, epTitle: c.ep.title, firstAired: c.ep.firstAired, score: +c.score.toFixed(1), reasons: c.reasons };

export const dedupe = (items) => { const seen = new Set(); const out = []; for (const i of items) { const k = i.type === 'movie' ? `m|${(i.title || i.show || '').toLowerCase()}` : (i.cr_episode_id || `${i.show}|${i.season}|${i.number}|${(i.title || '').toLowerCase()}`); if (seen.has(k)) continue; seen.add(k); out.push(i); } return out; };

export const runItems = async (trakt, items, { mode = 'dry-run', dateMode = 'airdate', onLog = () => {}, onProgress = () => {}, shouldCancel = () => false } = {}) => {
	const results = { high: [], medium: [], low: [], none: [], errors: [] }; const epHist = new Map(), movieHist = new Map(); let cancelled = false;
	for (let i = 0; i < items.length; i++) {
		if (shouldCancel()) { cancelled = true; onLog('-- cancelled by user --'); break; }
		const item = items[i]; const isMovie = item.type === 'movie';
		const tag = isMovie ? `(movie) "${item.title || item.show}"` : `${item.show || '(no show name)'} S${item.season ?? '?'}E${item.number ?? '?'} "${item.title || ''}"`;
		try {
			const c = isMovie ? await matchMovie(trakt, item) : await matchEpisode(trakt, item); const band = bandOf(c);
			if (!c || band === 'low' || band === 'none') { results[band === 'low' ? 'low' : 'none'].push({ item, cand: c && summarise(c) }); onLog(`x  ${tag}  ->  no confident match`); }
			else {
				let watchedAt, already, dest;
				if (c.kind === 'movie') { const rel = c.movie.released || null; watchedAt = dateMode === 'now' || !rel ? new Date().toISOString() : new Date(rel).toISOString(); if (!movieHist.has(c.movie.traktId)) movieHist.set(c.movie.traktId, await trakt.existingMovieHistoryIds(c.movie.traktId)); already = movieHist.get(c.movie.traktId).has(c.movie.traktId); dest = `${c.movie.title} (${c.movie.year ?? '?'})`; }
				else { const air = c.ep.firstAired || null; watchedAt = dateMode === 'now' || !air ? new Date().toISOString() : new Date(air).toISOString(); if (!epHist.has(c.show.traktId)) epHist.set(c.show.traktId, await trakt.existingEpisodeHistoryIds(c.show.traktId)); already = epHist.get(c.show.traktId).has(c.ep.traktId); dest = `${c.show.title} S${c.ep.season}E${c.ep.number} "${c.ep.title}"`; }
				results[band].push({ item, cand: summarise(c), already, watchedAt });
				onLog(`${band === 'high' ? 'OK' : '~ '} ${tag}  ->  ${dest}  [${band}]${already ? '  (already on Trakt - skip)' : ''}`);
			}
		} catch (e) { if (e.message === 'AUTH_401') throw e; results.errors.push({ item, error: e.message }); onLog(`!  ${tag}  ->  error: ${e.message}`); }
		onProgress(i + 1, items.length);
	}
	const episodes = results.high.filter((r) => !r.already && r.cand.kind === 'episode').map((r) => ({ ids: { trakt: r.cand.epTraktId }, watched_at: r.watchedAt }));
	const movies = results.high.filter((r) => !r.already && r.cand.kind === 'movie').map((r) => ({ ids: { trakt: r.cand.movieTraktId }, watched_at: r.watchedAt }));
	let added = { episodes: 0, movies: 0 };
	if (mode === 'commit' && !cancelled && (episodes.length || movies.length)) { const payload = {}; if (episodes.length) payload.episodes = episodes; if (movies.length) payload.movies = movies; const resp = await trakt.req('/sync/history', { method: 'POST', body: payload }); added = { episodes: resp?.added?.episodes ?? 0, movies: resp?.added?.movies ?? 0 }; }
	return { results, wouldWrite: { episodes: episodes.length, movies: movies.length }, added, cancelled };
};

export const startDeviceCode = async (clientId) => { const res = await fetch(`${TRAKT}/oauth/device/code`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'User-Agent': USER_AGENT }, body: JSON.stringify({ client_id: clientId }) }); if (!res.ok) throw new Error(`device/code ${res.status}`); return res.json(); };
export const pollDeviceToken = async (deviceCode, clientId, clientSecret) => { const res = await fetch(`${TRAKT}/oauth/device/token`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'User-Agent': USER_AGENT }, body: JSON.stringify({ code: deviceCode, client_id: clientId, client_secret: clientSecret }) }); if (res.status === 400) return { pending: true }; if (res.status === 429) return { pending: true }; if (res.status === 410) return { error: 'expired' }; if (res.status === 418) return { error: 'denied' }; if (res.status === 404) return { error: 'not_found' }; if (res.status === 409) return { error: 'already_used' }; if (!res.ok) return { pending: true }; return { token: await res.json() }; };
