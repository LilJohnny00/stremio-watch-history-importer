/** parsers.mjs — convert each service's uploaded text into common items.
 *  v1.1: Amazon parser now also accepts the primevideo-history.json produced
 *  by primevideo-export.js (a JSON array of items), in addition to CSV. */
const splitCsv = (line, delim) => { const out = []; let cur = '', inQ = false; for (let i = 0; i < line.length; i++) { const c = line[i]; if (c === '"') { if (inQ && line[i + 1] === '"') { cur += '"'; i++; } else inQ = !inQ; } else if (c === delim && !inQ) { out.push(cur); cur = ''; } else cur += c; } out.push(cur); return out.map((s) => s.trim()); };
const detectDelim = (h) => { const c = { ',': (h.match(/,/g) || []).length, ';': (h.match(/;/g) || []).length, '\t': (h.match(/\t/g) || []).length }; return Object.entries(c).sort((a, b) => b[1] - a[1])[0][0]; };
const norm = (s) => (s || '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const romanToArabic = (raw) => { const t = (raw || '').toLowerCase(); if (!/^[ivxlcdm]+$/.test(t)) return null; const v = { i: 1, v: 5, x: 10, l: 50, c: 100, d: 500, m: 1000 }; let tot = 0, prev = 0; for (let i = t.length - 1; i >= 0; i--) { const val = v[t[i]]; if (val === undefined) return null; if (val < prev) tot -= val; else { tot += val; prev = val; } } return tot > 0 && tot < 4000 ? tot : null; };

const NF_SEASON = /^(?:season|series|volume|vol\.?|part|chapter|book|limited series|cour|saison|temporada|staffel|stagione|book\s+\w+)\b\s*(\d+)?/i;
const NF_EP = /^(?:episode|ep\.?|folge|episodio)\s*(\d+)/i;
const WORD_NUM = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10 };
const nfSeasonFrom = (part) => { const m = part.match(NF_SEASON); if (m && m[1]) return parseInt(m[1], 10); for (const tk of part.split(/\s+/).slice(1)) { const w = WORD_NUM[tk.toLowerCase()]; if (w) return w; const r = romanToArabic(tk); if (r) return r; } return 1; };
const nfShowBeforeMarker = (parts) => { for (let i = 1; i < parts.length; i++) if (NF_SEASON.test(parts[i])) return parts.slice(0, i).join(': '); return null; };
const nfClassify = (raw, known) => { const parts = raw.split(':').map((p) => p.trim()).filter(Boolean); if (parts.length <= 1) return { type: 'movie', show: raw.trim(), title: raw.trim() }; let mi = -1; for (let i = 1; i < parts.length; i++) if (NF_SEASON.test(parts[i])) { mi = i; break; } if (mi >= 1) { const show = parts.slice(0, mi).join(': '); const season = nfSeasonFrom(parts[mi]); let et = parts[parts.length - 1], number; const em = et.match(NF_EP); if (em) { number = parseInt(em[1], 10); et = et.replace(NF_EP, '').replace(/^[:\-\s]+/, '').trim() || undefined; } if (mi === parts.length - 1) et = undefined; return { type: 'episode', show, season, number, title: et }; } for (let cut = parts.length - 1; cut >= 1; cut--) { const cand = parts.slice(0, cut).join(': '); if (known.has(norm(cand))) return { type: 'episode', show: cand, season: 1, title: parts.slice(cut).join(': ') }; } if (parts.length === 2) return { type: 'movie', show: raw.trim(), title: raw.trim() }; return { type: 'episode', show: parts.slice(0, parts.length - 1).join(': '), season: 1, title: parts[parts.length - 1] }; };
export const parseNetflix = (text) => { const lines = text.split(/\r?\n/).filter((l) => l.trim().length); let start = 0; if (/title/i.test(lines[0]) && /date/i.test(lines[0])) start = 1; const rows = []; for (let i = start; i < lines.length; i++) { const cols = splitCsv(lines[i], ','); if (cols[0]) rows.push({ title: cols[0], date: cols[1] || '' }); } const known = new Set(); for (const r of rows) { const s = nfShowBeforeMarker(r.title.split(':').map((p) => p.trim()).filter(Boolean)); if (s) known.add(norm(s)); } const seen = new Set(); const items = []; for (const r of rows) { const c = nfClassify(r.title, known); const key = c.type === 'movie' ? `m|${norm(c.show)}` : `e|${norm(c.show)}|${c.season}|${norm(c.title || String(c.number || ''))}`; if (seen.has(key)) continue; seen.add(key); items.push({ service: 'netflix', ...c, watched_date: r.date }); } return { items }; };

const DISNEY_HDR = { profile: ['profile id', 'profile', 'profile name', 'profileid'], program: ['program title', 'program', 'title', 'content title', 'episode title'], season: ['season title', 'season', 'series title', 'series', 'show', 'show title'], date: ['create date', 'date', 'watch date', 'play date', 'end date', 'start date'] };
const dCanon = (h) => { const s = h.trim().toLowerCase(); for (const [k, names] of Object.entries(DISNEY_HDR)) if (names.includes(s)) return k; return null; };
const dCleanSeries = (raw) => { if (!raw) return { series: '', season: null }; let s = raw.trim(), season = null; const m = s.match(/[:\-\u2013]?\s*season\s+(\d+)\s*$/i) || s.match(/\bs(?:eason)?\s*(\d+)\s*$/i); if (m) { season = parseInt(m[1], 10); s = s.slice(0, m.index).trim().replace(/[:\-\u2013]\s*$/, '').trim(); } return { series: s, season }; };
export const parseDisney = (text, profileFilter) => { const lines = text.split(/\r?\n/).filter((l) => l.trim().length); if (lines.length < 2) return { items: [] }; const delim = detectDelim(lines[0]); const headers = splitCsv(lines[0], delim).map(dCanon); const idx = {}; headers.forEach((h, i) => { if (h && !(h in idx)) idx[h] = i; }); const rows = lines.slice(1).map((l) => splitCsv(l, delim)); const profileOf = (r) => (idx.profile != null ? (r[idx.profile] || '').trim() : ''); const profiles = {}; for (const r of rows) { const p = profileOf(r) || '(blank)'; profiles[p] = (profiles[p] || 0) + 1; } if (!profileFilter) return { items: [], profiles }; const want = profileFilter.trim().toLowerCase(); const seen = new Set(); const items = []; for (const r of rows) { const p = profileOf(r).toLowerCase(); if (p !== want && !p.includes(want)) continue; const program = idx.program != null ? r[idx.program] : ''; const seasonRaw = idx.season != null ? r[idx.season] : ''; const date = idx.date != null ? r[idx.date] : ''; const isMovie = !seasonRaw || seasonRaw.toLowerCase() === (program || '').toLowerCase(); if (isMovie) { const k = `m|${(program || '').toLowerCase()}`; if (seen.has(k)) continue; seen.add(k); items.push({ service: 'disneyplus', type: 'movie', show: program, title: program, watched_date: date }); } else { const { series, season } = dCleanSeries(seasonRaw); const k = `e|${series.toLowerCase()}|${(program || '').toLowerCase()}`; if (seen.has(k)) continue; seen.add(k); items.push({ service: 'disneyplus', type: 'episode', show: series, season: season ?? undefined, title: program, watched_date: date }); } } return { items, profiles }; };

const AMZ_HDR = { title: ['title', 'item title', 'content title', 'program title', 'video title', 'name', 'titlename'], season: ['season title', 'season', 'series title', 'series', 'show title', 'show'], episode: ['episode title', 'episode name', 'episode'], number: ['episode number', 'episodenumber', 'ep number'], seasonNum: ['season number', 'seasonnumber'], date: ['playback date', 'watch date', 'date', 'event date', 'start time', 'timestamp', 'view date'] };
const aCanon = (h) => { const s = h.trim().toLowerCase().replace(/[_\s]+/g, ' '); for (const [k, names] of Object.entries(AMZ_HDR)) if (names.includes(s)) return k; return null; };
const AMZ_SEASON = /^(?:season|series|volume|vol\.?|staffel|temporada|saison)\b\s*(\d+)?/i;
const AMZ_EP = /^(?:episode|ep\.?|folge|episodio)\s*(\d+)/i;
const amzClassifyTitle = (raw) => { const t = raw.replace(/\s[-\u2013]\s/g, ': '); const parts = t.split(':').map((p) => p.trim()).filter(Boolean); if (parts.length <= 1) return { type: 'movie', show: raw.trim(), title: raw.trim() }; let mi = -1; for (let i = 1; i < parts.length; i++) if (AMZ_SEASON.test(parts[i])) { mi = i; break; } if (mi >= 1) { const show = parts.slice(0, mi).join(': '); const sm = parts[mi].match(AMZ_SEASON); const season = sm && sm[1] ? parseInt(sm[1], 10) : 1; let et = parts[parts.length - 1], number; const em = et.match(AMZ_EP); if (em) { number = parseInt(em[1], 10); et = et.replace(AMZ_EP, '').replace(/^[:\-\s]+/, '').trim() || undefined; } if (mi === parts.length - 1) et = undefined; return { type: 'episode', show, season, number, title: et }; } if (parts.length === 2) return { type: 'movie', show: raw.trim(), title: raw.trim() }; return { type: 'episode', show: parts.slice(0, parts.length - 1).join(': '), season: 1, title: parts[parts.length - 1] }; };
// Strip streaming "quality"/edition tags Prime appends to titles, e.g.
// "Zombieland (4K UHD)" -> "Zombieland", "Dune (HDR)" -> "Dune".
const stripQualityTags = (t) => (t || '')
	.replace(/[\(\[]\s*(?:4k|uhd|hdr|hd|sd|dolby(?:\s+vision)?|imax|extended|unrated|director'?s\s+cut|remastered|open\s+matte)(?:\s+\w+)*\s*[\)\]]/gi, '')
	.replace(/\s{2,}/g, ' ')
	.trim();

// A leaked "Episode N: Something" show name means Prime gave us an episode with
// no parent series — unmatchable, but we tidy the fields so the log is clear.
const looksLikeLeakedEpisode = (show) => /^episode\s*\d+\s*[:\-]/i.test((show || '').trim());

export const parseAmazon = (text) => {
	// NEW: accept the primevideo-export.js JSON (a ready-made items array).
	const trimmed = (text || '').trim();
	if (trimmed.startsWith('[')) {
		let arr; try { arr = JSON.parse(trimmed); } catch { throw new Error('Looks like JSON but could not parse it.'); }
		if (!Array.isArray(arr)) throw new Error('Expected a JSON array from primevideo-export.js.');
		const seen = new Set(); const items = [];
		for (const i of arr) {
			const type = i.type === 'movie' ? 'movie' : 'episode';
			let c;
			if (type === 'movie') {
				const clean = stripQualityTags(i.title || i.show);
				c = { type: 'movie', show: clean, title: clean };
			} else {
				let show = stripQualityTags(i.show);
				// If the show name is actually a leaked "Episode N: Title", keep the
				// title but blank the bogus show so it fails cleanly (not wrongly).
				let title = i.title;
				if (looksLikeLeakedEpisode(show)) {
					const m = show.match(/^episode\s*\d+\s*[:\-]\s*(.*)$/i);
					title = title || (m && m[1]) || show;
					show = '';
				}
				c = { type: 'episode', show, season: i.season ?? 1, number: i.number, title };
			}
			const key = type === 'movie' ? `m|${(c.title || '').toLowerCase()}` : `e|${(c.show || '').toLowerCase()}|${c.season}|${(c.title || c.number || '').toString().toLowerCase()}`;
			if (seen.has(key)) continue; seen.add(key);
			items.push({ service: 'amazon', ...c, watched_date: i.watched_date });
		}
		return { items };
	}
	// Otherwise treat as a CSV export.
	const lines = trimmed.split(/\r?\n/).filter((l) => l.trim().length); if (lines.length < 2) return { items: [] };
	const delim = detectDelim(lines[0]); const headers = splitCsv(lines[0], delim).map(aCanon); const idx = {}; headers.forEach((h, i) => { if (h && !(h in idx)) idx[h] = i; });
	if (!('title' in idx) && !('episode' in idx) && !('season' in idx)) throw new Error('Could not find a title column. Headers: ' + splitCsv(lines[0], delim).join(' | '));
	const rows = lines.slice(1).map((l) => splitCsv(l, delim)); const seen = new Set(); const items = [];
	for (const r of rows) { const date = idx.date != null ? r[idx.date] : ''; let c;
		if (idx.season != null && (idx.episode != null || idx.number != null)) { const show = r[idx.season] || ''; if (!show) continue; const title = idx.episode != null ? r[idx.episode] : ''; const number = idx.number != null ? parseInt(r[idx.number], 10) : undefined; const sn = idx.seasonNum != null ? parseInt(r[idx.seasonNum], 10) : undefined; c = { type: 'episode', show, season: Number.isFinite(sn) ? sn : 1, number: Number.isFinite(number) ? number : undefined, title: title || undefined }; }
		else { const combined = (idx.title != null ? r[idx.title] : '') || (idx.season != null ? r[idx.season] : ''); if (!combined) continue; c = amzClassifyTitle(combined); }
		const key = c.type === 'movie' ? `m|${(c.title || c.show).toLowerCase()}` : `e|${c.show.toLowerCase()}|${c.season}|${(c.title || c.number || '').toString().toLowerCase()}`; if (seen.has(key)) continue; seen.add(key); items.push({ service: 'amazon', ...c, watched_date: date }); }
	return { items };
};

export const parseCrunchyroll = (text) => { let arr; try { arr = JSON.parse(text); } catch { throw new Error('Crunchyroll file must be the exported JSON.'); } if (!Array.isArray(arr)) throw new Error('Expected a JSON array.'); const items = arr.map((i) => ({ service: 'crunchyroll', type: 'episode', cr_episode_id: i.cr_episode_id, show: i.show, season: i.season, number: i.number, sequence_number: i.sequence_number, title: i.title })); return { items }; };

export const parseByService = (service, text, opts = {}) => { switch (service) { case 'netflix': return parseNetflix(text); case 'disneyplus': return parseDisney(text, opts.profile); case 'amazon': return parseAmazon(text); case 'crunchyroll': return parseCrunchyroll(text); default: throw new Error('Unknown service: ' + service); } };
