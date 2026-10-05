'use strict';
/* Flight Radar — Israel. Data: OpenSky Network (ADS-B) via CORS worker; routes: adsbdb. */

const WORKER = 'https://bus-times-cors.ohrmich.workers.dev/?url=';
const BBOX = { lamin: 29.3, lamax: 33.5, lomin: 34.0, lomax: 36.0 };
const POLL_MS = 60_000;
const IL_AIRPORTS = ['TLV', 'ETM', 'HFA']; // Ben Gurion, Ramon, Haifa (IATA)

const I18N = {
  he: {
    title: 'מכ״ם טיסות', subtitle: 'שמי ישראל · זמן אמת',
    airborne: 'מטוסים באוויר', localTime: 'שעה מקומית', nextUpdate: 'עדכון הבא',
    fAll: 'הכל', fTo: 'לישראל', fFrom: 'מישראל', fOver: 'חולף',
    searchPh: 'חיפוש לפי מספר טיסה…',
    alt: 'גובה (רגל)', speed: 'מהירות (קשר)', heading: 'כיוון', vrate: 'קצב אנכי',
    legend: 'גובה', legLow: 'נמוך', legMid: 'בינוני', legHigh: 'גבוה',
    loading: 'סורק את השמיים…',
    credit: 'נתוני טיסות: OpenSky Network (ADS-B קהילתי) · מסלולים: adsbdb',
    noFlights: 'אין טיסות כרגע בתצוגה זו',
    quotaPaused: 'מכסת העדכונים היומית הסתיימה — ממשיך מחר',
    quotaLeft: (n) => `נשארו ${n} עדכונים להיום`,
    feedError: 'חיבור נתוני הטיסות נכשל — מנסה שוב…',
    unknown: 'לא ידוע', toIsrael: 'לישראל', fromIsrael: 'מישראל', overflying: 'חולף מעל',
    ftMin: 'רגל/דקה',
  },
  en: {
    title: 'Flight Radar', subtitle: 'Israeli skies · live',
    airborne: 'Airborne', localTime: 'Local time', nextUpdate: 'Next update',
    fAll: 'All', fTo: 'To Israel', fFrom: 'From Israel', fOver: 'Overflying',
    searchPh: 'Search by flight number…',
    alt: 'Altitude (ft)', speed: 'Speed (kts)', heading: 'Heading', vrate: 'Vert. rate',
    legend: 'Altitude', legLow: 'Low', legMid: 'Mid', legHigh: 'High',
    loading: 'Scanning the skies…',
    credit: 'Flight data: OpenSky Network (community ADS-B) · Routes: adsbdb',
    noFlights: 'No flights in this view right now',
    quotaPaused: 'Daily update quota reached — resumes tomorrow',
    quotaLeft: (n) => `${n} updates left today`,
    feedError: 'Flight feed unreachable — retrying…',
    unknown: 'Unknown', toIsrael: 'To Israel', fromIsrael: 'From Israel', overflying: 'Overflying',
    ftMin: 'ft/min',
  },
};

let lang = localStorage.getItem('fr_lang') || 'he';
let map = null;
let markers = {};       // icao24 -> { marker, state }
let flights = [];       // last enriched state list
let routeCache = {};    // callsign -> {origin, dest} | null
let selectedIcao = null;
let activeFilter = 'all';
let quotaPaused = false;
let callsToday = 0;
let countdownTimer = null;
let secondsLeft = POLL_MS / 1000;
let failStreak = 0;

const t = (k, ...a) => {
  const v = (I18N[lang] && I18N[lang][k]) || I18N.en[k] || k;
  return typeof v === 'function' ? v(...a) : v;
};
const $ = (id) => document.getElementById(id);
const M_TO_FT = 3.28084, MS_TO_KT = 1.94384;

const openskyUrl = () =>
  `https://opensky-network.org/api/states/all?lamin=${BBOX.lamin}&lamax=${BBOX.lamax}&lomin=${BBOX.lomin}&lomax=${BBOX.lomax}`;
const proxied = (url) => WORKER + encodeURIComponent(url);

function applyLang() {
  document.documentElement.lang = lang;
  document.documentElement.dir = lang === 'he' ? 'rtl' : 'ltr';
  document.querySelectorAll('[data-i18n]').forEach((el) => { el.textContent = t(el.dataset.i18n); });
  document.querySelectorAll('[data-i18n-ph]').forEach((el) => { el.placeholder = t(el.dataset.i18nPh); });
  $('langBtn').textContent = lang === 'he' ? 'EN' : 'עב';
  renderList();
  if (selectedIcao && markers[selectedIcao]) showDetail(markers[selectedIcao].state);
}

function altColor(altFt) {
  if (altFt == null) return '#8b93a9';
  if (altFt < 10000) return '#e0a458';
  if (altFt < 28000) return '#9db8d2';
  return '#f2ead8';
}

function planeIcon(state, selected) {
  const track = state[10] || 0;
  const altFt = state[7] != null ? Math.round(state[7] * M_TO_FT) : null;
  const color = altColor(altFt);
  const cs = (state[1] || '').trim();
  return L.divIcon({
    className: 'plane-marker' + (selected ? ' selected' : ''),
    html: `<div class="plane-glyph" style="transform: rotate(${track}deg)">`
      + `<svg viewBox="0 0 24 24"><path fill="${color}" d="M21 16v-2l-8-5V3.5c0-.83-.67-1.5-1.5-1.5S10 2.67 10 3.5V9l-8 5v2l8-2.5V19l-2 1.5V22l3.5-1 3.5 1v-1.5L13 19v-5.5l8 2.5z"/></svg></div>`
      + (selected && cs ? `<div class="plane-label">${escapeHtml(cs)}</div>` : ''),
    iconSize: [30, 30], iconAnchor: [15, 15],
  });
}

function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function todayKey() { return 'fr_calls_' + new Date().toISOString().slice(0, 10); }

async function fetchStates() {
  if (quotaPaused) return;
  const key = todayKey();
  callsToday = parseInt(localStorage.getItem(key) || '0', 10);
  if (callsToday >= 395) { setQuotaPaused(); return; }
  try {
    const res = await fetch(proxied(openskyUrl()));
    if (res.status === 429) { setQuotaPaused(); return; }
    if (!res.ok) throw new Error('http ' + res.status);
    const data = await res.json();
    callsToday += 1;
    localStorage.setItem(key, String(callsToday));
    updateQuotaNote();
    const states = (data.states || []).filter((s) => s[5] != null && s[6] != null && !s[8]);
    failStreak = 0;
    updateMarkers(states);
    enrichRoutes(states);
  } catch (e) {
    // keep old markers on transient errors; surface persistent failures
    failStreak += 1;
    if (failStreak >= 2) {
      const q = $('quotaNote');
      q.hidden = false;
      q.textContent = t('feedError');
    }
  }
  if (failStreak === 0) { /* ok */ }
  $('loader').classList.add('done');
  secondsLeft = POLL_MS / 1000;
}

function setQuotaPaused() {
  quotaPaused = true;
  const q = $('quotaNote');
  q.hidden = false;
  q.textContent = t('quotaPaused');
}

function updateQuotaNote() {
  const left = 395 - callsToday;
  const q = $('quotaNote');
  if (left <= 60) { q.hidden = false; q.textContent = t('quotaLeft', left); }
  else q.hidden = true;
}

function updateMarkers(states) {
  const seen = new Set();
  states.forEach((s) => {
    const icao = s[0];
    seen.add(icao);
    const selected = icao === selectedIcao;
    if (markers[icao]) {
      markers[icao].marker.setLatLng([s[6], s[5]]);
      markers[icao].marker.setIcon(planeIcon(s, selected));
      markers[icao].state = s;
    } else {
      const m = L.marker([s[6], s[5]], { icon: planeIcon(s, selected) });
      m.on('click', () => selectFlight(icao));
      m.addTo(map);
      markers[icao] = { marker: m, state: s };
    }
  });
  Object.keys(markers).forEach((icao) => {
    if (!seen.has(icao)) {
      map.removeLayer(markers[icao].marker);
      delete markers[icao];
      if (selectedIcao === icao) { selectedIcao = null; $('flightDetail').hidden = true; }
    }
  });
  flights = states;
  $('planeCount').textContent = states.length;
  applyFilter();
}

async function enrichRoutes(states) {
  const fresh = states.map((s) => (s[1] || '').trim()).filter((cs) => cs && !(cs in routeCache));
  const uniq = [...new Set(fresh)].slice(0, 40);
  for (const cs of uniq) {
    routeCache[cs] = null; // mark in-flight
    try {
      const res = await fetch('https://api.adsbdb.com/v0/callsign/' + encodeURIComponent(cs));
      if (res.ok) {
        const d = await res.json();
        const fr = d && d.response && d.response.flightroute;
        if (fr && fr.origin && fr.destination) {
          routeCache[cs] = {
            origin: fr.origin.iata_code || '?', dest: fr.destination.iata_code || '?',
            originName: fr.origin.name || '', destName: fr.destination.name || '',
          };
        }
      }
    } catch (e) { /* leave null */ }
    await new Promise((r) => setTimeout(r, 250));
  }
  applyFilter();
  if (selectedIcao && markers[selectedIcao]) showDetail(markers[selectedIcao].state);
}

function flightClass(cs) {
  const r = routeCache[cs];
  if (!r) return 'unknown';
  const oIL = IL_AIRPORTS.includes(r.origin), dIL = IL_AIRPORTS.includes(r.dest);
  if (dIL && !oIL) return 'to';
  if (oIL && !dIL) return 'from';
  if (!oIL && !dIL) return 'over';
  return 'domestic';
}

function applyFilter() {
  const q = $('searchInput').value.trim().toUpperCase();
  const rows = flights
    .map((s) => ({ s, cs: (s[1] || '').trim() }))
    .filter(({ cs }) => !q || cs.includes(q))
    .filter(({ cs }) => {
      if (activeFilter === 'all') return true;
      const c = flightClass(cs);
      return c === activeFilter;
    })
    .sort((a, b) => a.cs.localeCompare(b.cs));
  // dim markers not in filter
  const visible = new Set(rows.map((r) => r.s[0]));
  Object.entries(markers).forEach(([icao, { marker }]) => {
    marker.setOpacity(visible.has(icao) ? 1 : 0.18);
  });
  renderList(rows);
}

function renderList(rows) {
  const box = $('flightList');
  const list = rows || flights.map((s) => ({ s, cs: (s[1] || '').trim() }));
  if (!list.length) {
    box.innerHTML = `<div class="quota">${t('noFlights')}</div>`;
    return;
  }
  box.innerHTML = list.map(({ s, cs }) => {
    const icao = s[0];
    const altFt = s[7] != null ? Math.round(s[7] * M_TO_FT) : null;
    const r = routeCache[cs];
    const rt = r ? `${escapeHtml(r.origin)} → ${escapeHtml(r.dest)}` : '···';
    return `<div class="flight-row${icao === selectedIcao ? ' selected' : ''}" data-icao="${icao}">`
      + `<i class="altdot" style="background:${altColor(altFt)}"></i>`
      + `<span class="cs">${escapeHtml(cs || t('unknown'))}</span>`
      + `<span class="rt">${rt}</span></div>`;
  }).join('');
  box.querySelectorAll('.flight-row').forEach((el) =>
    el.addEventListener('click', () => selectFlight(el.dataset.icao)));
}

function selectFlight(icao) {
  selectedIcao = icao;
  const rec = markers[icao];
  if (!rec) return;
  rec.marker.setIcon(planeIcon(rec.state, true));
  Object.entries(markers).forEach(([k, { marker, state }]) => {
    if (k !== icao) marker.setIcon(planeIcon(state, false));
  });
  map.flyTo(rec.marker.getLatLng(), Math.max(map.getZoom(), 9), { duration: 0.7 });
  showDetail(rec.state);
  renderList();
}

function fmtNum(n) { return n == null || isNaN(n) ? '—' : Math.round(n).toLocaleString('en-US'); }

function showDetail(s) {
  const cs = (s[1] || '').trim();
  const altFt = s[7] != null ? s[7] * M_TO_FT : null;
  const kts = s[9] != null ? s[9] * MS_TO_KT : null;
  const vr = s[11] != null ? s[11] * M_TO_FT * 60 : null;
  const r = routeCache[cs];
  $('dCallsign').textContent = cs || t('unknown');
  $('dOrigin').textContent = r ? r.origin : '···';
  $('dDest').textContent = r ? r.dest : '···';
  $('dRouteSub').textContent = r
    ? `${r.originName} → ${r.destName}`
    : ({ to: t('toIsrael'), from: t('fromIsrael'), over: t('overflying'), unknown: '', domestic: '' }[flightClass(cs)] || '');
  $('dAlt').textContent = fmtNum(altFt);
  $('dSpeed').textContent = fmtNum(kts);
  $('dTrack').textContent = s[10] != null ? Math.round(s[10]) + '°' : '—';
  $('dVrate').textContent = vr == null ? '—' : (vr > 0 ? '+' : '') + fmtNum(vr) + ' ' + t('ftMin');
  $('dIcao').textContent = 'ICAO ' + s[0].toUpperCase();
  $('dCountry').textContent = s[2] || '';
  $('flightDetail').hidden = false;
}

function tickClock() {
  $('clock').textContent = new Date().toLocaleTimeString(lang === 'he' ? 'he-IL' : 'en-GB',
    { timeZone: 'Asia/Jerusalem', hour12: false });
}

function initMap() {
  map = L.map('map', { zoomControl: true, worldCopyJump: true }).setView([31.6, 34.9], 8);
  map.zoomControl.setPosition('bottomright');
  L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}', {
    attribution: '&copy; <a href="https://www.esri.com">Esri</a> &copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
    maxZoom: 19,
  }).addTo(map);
}

function boot() {
  applyLang();
  initMap();
  document.querySelectorAll('#filterSeg .seg-btn').forEach((b) =>
    b.addEventListener('click', () => {
      document.querySelectorAll('#filterSeg .seg-btn').forEach((x) => x.classList.remove('active'));
      b.classList.add('active');
      activeFilter = b.dataset.filter;
      applyFilter();
    }));
  $('searchInput').addEventListener('input', applyFilter);
  $('detailClose').addEventListener('click', () => {
    $('flightDetail').hidden = true;
    if (selectedIcao && markers[selectedIcao]) {
      markers[selectedIcao].marker.setIcon(planeIcon(markers[selectedIcao].state, false));
    }
    selectedIcao = null;
    renderList();
  });
  $('langBtn').addEventListener('click', () => {
    lang = lang === 'he' ? 'en' : 'he';
    localStorage.setItem('fr_lang', lang);
    applyLang();
  });
  tickClock();
  setInterval(tickClock, 1000);
  fetchStates();
  setInterval(fetchStates, POLL_MS);
  countdownTimer = setInterval(() => {
    secondsLeft = Math.max(0, secondsLeft - 1);
    $('countdown').textContent = quotaPaused ? '—' : secondsLeft + 's';
  }, 1000);
  updateQuotaNote();
}

document.addEventListener('DOMContentLoaded', boot);
