// fetch.js — runs every night via cron at midnight IST
// Fetches yesterday's matches and appends to public/data.json

const https = require('https');
const fs = require('fs');
const path = require('path');

const API_KEY = '06674a197d7ee04550b0f2dae4c64205';

const LEAGUES = {
  1:'FIFA World Cup',2:'Champions League',3:'Europa League',
  848:'Conference League',39:'Premier League',140:'La Liga',
  135:'Serie A',78:'Bundesliga',61:'Ligue 1',94:'Primeira Liga',
  88:'Eredivisie',203:'Süper Lig'
};
const LEAGUE_ORDER = [1,2,3,848,39,140,135,78,61,94,88,203];

function getYesterdayIST() {
  const now = new Date();
  const ist = new Date(now.getTime() + 5.5 * 60 * 60 * 1000);
  ist.setDate(ist.getDate() - 1);
  return ist.toISOString().split('T')[0];
}

function apiFetch(path) {
  return new Promise((resolve, reject) => {
    https.get({
      hostname: 'v3.football.api-sports.io',
      path,
      headers: { 'x-apisports-key': API_KEY }
    }, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => { try { resolve(JSON.parse(data)); } catch(e) { reject(e); } });
    }).on('error', reject);
  });
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function run() {
  const date = getYesterdayIST();
  const dataFile = path.join(__dirname, 'public', 'data.json');

  // Load existing data
  let existing = { generated_at: new Date().toISOString(), days: [] };
  if (fs.existsSync(dataFile)) {
    try {
      const raw = JSON.parse(fs.readFileSync(dataFile, 'utf8'));
      // Handle both old single-date and new multi-date format
      if (raw.days) existing = raw;
      else if (raw.date) existing.days = [{ date: raw.date, fetched_at: raw.fetched_at, match_count: raw.match_count, matches: raw.matches }];
    } catch(e) { console.log('Could not read existing data, starting fresh'); }
  }

  // Skip if already fetched
  if (existing.days.find(d => d.date === date)) {
    console.log(`${date} already fetched, skipping`);
    process.exit(0);
  }

  console.log(`Fetching ${date}...`);
  const fx = await apiFetch(`/fixtures?date=${date}&timezone=Asia%2FKolkata`);

  if (fx.errors && Object.keys(fx.errors).length) {
    console.error('API error:', JSON.stringify(fx.errors));
    process.exit(1);
  }

  const done = (fx.response || []).filter(f =>
    LEAGUES[f.league?.id] && ['FT','AET','PEN','P'].includes(f.fixture?.status?.short)
  );
  console.log(`${done.length} completed matches found`);

  const matches = [];
  for (const f of done) {
    const id = f.fixture.id;
    console.log(`  ${f.teams.home.name} vs ${f.teams.away.name}...`);
    const [ev, st, lu, pl] = await Promise.all([
      apiFetch(`/fixtures/events?fixture=${id}`),
      apiFetch(`/fixtures/statistics?fixture=${id}`),
      apiFetch(`/fixtures/lineups?fixture=${id}`),
      apiFetch(`/fixtures/players?fixture=${id}`),
    ]);
    const ratings = {};
    for (const t of pl.response || [])
      for (const p of t.players || []) {
        const r = p.statistics?.[0]?.games?.rating;
        if (r) ratings[p.player?.id] = { name: p.player?.name, rating: parseFloat(r), minutes: p.statistics?.[0]?.games?.minutes };
      }
    matches.push({
      fixture: { id: f.fixture.id, status: f.fixture.status, date: f.fixture.date },
      league: { id: f.league.id, name: LEAGUES[f.league.id] || f.league.name, logo: f.league.logo, round: f.league.round },
      teams: { home: { id: f.teams.home.id, name: f.teams.home.name, logo: f.teams.home.logo }, away: { id: f.teams.away.id, name: f.teams.away.name, logo: f.teams.away.logo } },
      goals: f.goals, score: f.score,
      events: (ev.response || []).filter(e => e.type === 'Goal' || (e.type === 'Card' && e.detail === 'Red Card')).map(e => ({ type: e.type, detail: e.detail, minute: e.time?.elapsed, team_id: e.team?.id, player: e.player?.name })),
      stats: (st.response || []).map(t => ({ team_id: t.team?.id, possession: t.statistics?.find(s => s.type === 'Ball Possession')?.value || null, shots_on: t.statistics?.find(s => s.type === 'Shots on Goal')?.value || null, shots_total: t.statistics?.find(s => s.type === 'Total Shots')?.value || null, corners: t.statistics?.find(s => s.type === 'Corner Kicks')?.value || null, fouls: t.statistics?.find(s => s.type === 'Fouls')?.value || null, yellow_cards: t.statistics?.find(s => s.type === 'Yellow Cards')?.value || null, saves: t.statistics?.find(s => s.type === 'Goalkeeper Saves')?.value || null, passes_total: t.statistics?.find(s => s.type === 'Total passes')?.value || null, passes_pct: t.statistics?.find(s => s.type === 'Passes %')?.value || null, xg: t.statistics?.find(s => s.type === 'Expected Goals')?.value || null })),
      lineups: (lu.response || []).map(t => ({ team_id: t.team?.id, formation: t.formation, startXI: (t.startXI || []).map(p => ({ id: p.player?.id, name: p.player?.name, number: p.player?.number, pos: p.player?.pos })), substitutes: (t.substitutes || []).map(p => ({ id: p.player?.id, name: p.player?.name, number: p.player?.number, pos: p.player?.pos })) })),
      ratings,
    });
    await sleep(300);
  }

  // Append new day and sort newest first
  existing.days.push({ date, fetched_at: new Date().toISOString(), match_count: matches.length, matches });
  existing.days.sort((a, b) => b.date.localeCompare(a.date));
  existing.generated_at = new Date().toISOString();

  fs.writeFileSync(dataFile, JSON.stringify(existing, null, 2));
  console.log(`Done — ${matches.length} matches appended. Total days: ${existing.days.length}`);
}

run().catch(err => { console.error('Fatal:', err.message); process.exit(1); });
