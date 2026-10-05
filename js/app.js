'use strict';
/* Flight Radar — Israel. Data: adsb.lol (community ADS-B) via scheduled
   GitHub Action -> data branch -> raw.githubusercontent (no CORS issues).
   Routes enriched via adsbdb (direct, CORS-open). */

const DATA_URL = 'https://raw.githubusercontent.com/ohrmich-png/flight-radar/data/flights.json';
const GLOBAL_URL = 'https://raw.githubusercontent.com/ohrmich-png/flight-radar/data/global.json';
const POLL_MS = 60_000;
const STALE_MS = 15 * 60_000;
const IL_AIRPORTS = ['TLV', 'ETM', 'HFA']; // Ben Gurion, Ramon, Haifa (IATA)
const IL_BBOX = { lamin: 29.2, lamax: 33.6, lomin: 33.9, lomax: 36.1 };

const I18N = {
  he: {
    title: 'מכ״ם טיסות', subtitle: 'שמי ישראל · זמן אמת',
    airborne: 'מטוסים באוויר', localTime: 'שעה מקומית', nextUpdate: 'עדכון הבא',
    fAll: 'הכל', fTo: 'לישראל', fFrom: 'מישראל', fOver: 'חולף',
    searchPh: 'חיפוש לפי מספר טיסה…',
    alt: 'גובה (רגל)', speed: 'מהירות (קשר)', heading: 'כיוון', vrate: 'קצב אנכי',
    legend: 'גובה', legLow: 'נמוך', legMid: 'בינוני', legHigh: 'גבוה',
    loading: 'סורק את השמיים…',
    credit: 'נתוני טיסות: adsb.lol (ADS-B קהילתי) · מסלולים: adsbdb',
    noFlights: 'אין טיסות כרגע בתצוגה זו',
    feedError: 'נתוני הטיסות אינם מעודכנים — מנסה שוב…',
    unknown: 'לא ידוע', toIsrael: 'לישראל', fromIsrael: 'מישראל', overflying: 'חולף מעל',
    ftMin: 'רגל/דקה', ilOnly: 'רק טיסות ישראל',
  },
  en: {
    title: 'Flight Radar', subtitle: 'Israeli skies · live',
    airborne: 'Airborne', localTime: 'Local time', nextUpdate: 'Next update',
    fAll: 'All', fTo: 'To Israel', fFrom: 'From Israel', fOver: 'Overflying',
    searchPh: 'Search by flight number…',
    alt: 'Altitude (ft)', speed: 'Speed (kts)', heading: 'Heading', vrate: 'Vert. rate',
    legend: 'Altitude', legLow: 'Low', legMid: 'Mid', legHigh: 'High',
    loading: 'Scanning the skies…',
    credit: 'Flight data: adsb.lol (community ADS-B) · Routes: adsbdb',
    noFlights: 'No flights in this view right now',
    feedError: 'Flight data is stale — retrying…',
    unknown: 'Unknown', toIsrael: 'To Israel', fromIsrael: 'From Israel', overflying: 'Overflying',
    ftMin: 'ft/min', ilOnly: 'Israel flights only',
  },
};

let lang = localStorage.getItem('fr_lang') || 'he';
let map = null;
let markers = {};       // hex -> { marker, f }
let flights = [];       // normalized flight objects
let routeCache = {};    // callsign -> {origin, dest, ...} | null (persisted)
let selectedHex = null;
let activeFilter = 'all';
let israelOnly = true;
let countdownTimer = null;
let secondsLeft = POLL_MS / 1000;
let failStreak = 0;

function loadRouteCache() {
  try {
    const raw = localStorage.getItem('fr_routes');
    if (!raw) return;
    const d = JSON.parse(raw);
    const week = 7 * 86400_000, now = Date.now();
    Object.entries(d).forEach(([cs, v]) => {
      if (v && v.ts && now - v.ts < week) routeCache[cs] = v.r;
    });
  } catch (e) { /* ignore */ }
}
function saveRouteCache() {
  try {
    const d = {};
    Object.entries(routeCache).forEach(([cs, r]) => {
      if (r) d[cs] = { r, ts: Date.now() };
    });
    localStorage.setItem('fr_routes', JSON.stringify(d));
  } catch (e) { /* ignore */ }
}

const t = (k, ...a) => {
  const v = (I18N[lang] && I18N[lang][k]) || I18N.en[k] || k;
  return typeof v === 'function' ? v(...a) : v;
};
const $ = (id) => document.getElementById(id);

function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// adsb.lol -> normalized
function normAc(a) {
  return {
    hex: String(a.hex || '').toLowerCase(),
    cs: (a.flight || '').trim(),
    lat: a.lat, lon: a.lon,
    altFt: typeof a.alt_baro === 'number' ? Math.round(a.alt_baro) : null,
    kts: typeof a.gs === 'number' ? Math.round(a.gs) : null,
    track: typeof a.track === 'number' ? a.track : 0,
    vrate: typeof a.baro_rate === 'number' ? Math.round(a.baro_rate) : null,
    reg: a.r || '', type: a.t || '',
  };
}
function validAc(a) {
  return a && a.lat != null && a.lon != null
    && !String(a.hex || '').startsWith('~')
    && a.alt_baro !== 'ground';
}

function applyLang() {
  document.documentElement.lang = lang;
  document.documentElement.dir = lang === 'he' ? 'rtl' : 'ltr';
  document.querySelectorAll('[data-i18n]').forEach((el) => { el.textContent = t(el.dataset.i18n); });
  document.querySelectorAll('[data-i18n-ph]').forEach((el) => { el.placeholder = t(el.dataset.i18nPh); });
  $('langBtn').textContent = lang === 'he' ? 'EN' : 'עב';
  renderList();
  if (selectedHex && markers[selectedHex]) showDetail(markers[selectedHex].f);
}

function altColor(altFt) {
  if (altFt == null) return '#8b93a9';
  if (altFt < 10000) return '#e0a458';
  if (altFt < 28000) return '#9db8d2';
  return '#f2ead8';
}

function planeIcon(f, selected) {
  const color = altColor(f.altFt);
  return L.divIcon({
    className: 'plane-marker' + (selected ? ' selected' : ''),
    html: `<div class="plane-glyph" style="transform: rotate(${f.track}deg)">`
      + `<svg viewBox="0 0 24 24"><path fill="${color}" d="M21 16v-2l-8-5V3.5c0-.83-.67-1.5-1.5-1.5S10 2.67 10 3.5V9l-8 5v2l8-2.5V19l-2 1.5V22l3.5-1 3.5 1v-1.5L13 19v-5.5l8 2.5z"/></svg></div>`
      + (selected && f.cs ? `<div class="plane-label">${escapeHtml(f.cs)}</div>` : ''),
    iconSize: [30, 30], iconAnchor: [15, 15],
  });
}

async function fetchStates() {
  try {
    const [r1, r2] = await Promise.all([
      fetch(DATA_URL + '?t=' + Date.now(), { cache: 'no-store' }),
      fetch(GLOBAL_URL + '?t=' + Date.now(), { cache: 'no-store' }).catch(() => null),
    ]);
    if (!r1.ok) throw new Error('http ' + r1.status);
    const data = await r1.json();
    const ageMs = Date.now() - (data.now || 0);
    if (ageMs > STALE_MS) throw new Error('stale');
    const seen = new Set();
    const list = [];
    const pushAc = (a) => {
      const h = String(a.hex || '').toLowerCase();
      if (!h || seen.has(h)) return;
      seen.add(h);
      list.push(normAc(a));
    };
    (data.ac || []).filter(validAc).forEach(pushAc);
    // global Israel-related flights (dedupe against regional)
    try {
      if (r2 && r2.ok) {
        const g = await r2.json();
        (g.ac || []).filter(validAc).forEach(pushAc);
      }
    } catch (e) { /* global optional */ }
    failStreak = 0;
    $('quotaNote').hidden = true;
    updateMarkers(list);
    enrichRoutes(list);
  } catch (e) {
    failStreak += 1;
    if (failStreak >= 2) {
      const q = $('quotaNote');
      q.hidden = false;
      q.textContent = t('feedError');
    }
  }
  $('loader').classList.add('done');
  secondsLeft = POLL_MS / 1000;
}

function updateMarkers(list) {
  const seen = new Set();
  list.forEach((f) => {
    seen.add(f.hex);
    const selected = f.hex === selectedHex;
    if (markers[f.hex]) {
      markers[f.hex].marker.setLatLng([f.lat, f.lon]);
      markers[f.hex].marker.setIcon(planeIcon(f, selected));
      markers[f.hex].f = f;
    } else {
      const m = L.marker([f.lat, f.lon], { icon: planeIcon(f, selected) });
      m.on('click', () => selectFlight(f.hex));
      m.addTo(map);
      markers[f.hex] = { marker: m, f };
    }
  });
  Object.keys(markers).forEach((hex) => {
    if (!seen.has(hex)) {
      map.removeLayer(markers[hex].marker);
      delete markers[hex];
      if (selectedHex === hex) { selectedHex = null; $('flightDetail').hidden = true; }
    }
  });
  flights = list;
  $('planeCount').textContent = list.length;
  applyFilter();
}

async function enrichRoutes(list) {
  const fresh = list.map((f) => f.cs).filter((cs) => cs && !(cs in routeCache));
  const uniq = [...new Set(fresh)].slice(0, 40);
  for (const cs of uniq) {
    routeCache[cs] = null;
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
  saveRouteCache();
  applyFilter();
  if (selectedHex && markers[selectedHex]) showDetail(markers[selectedHex].f);
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

function inIsrael(f) {
  return f.lat >= IL_BBOX.lamin && f.lat <= IL_BBOX.lamax
      && f.lon >= IL_BBOX.lomin && f.lon <= IL_BBOX.lomax;
}
function routeTouchesIsrael(cs) {
  const r = routeCache[cs];
  return !!r && (IL_AIRPORTS.includes(r.origin) || IL_AIRPORTS.includes(r.dest));
}
function isIsraelRelevant(f) {
  return inIsrael(f) || routeTouchesIsrael(f.cs);
}

function applyFilter() {
  const q = $('searchInput').value.trim().toUpperCase();
  const rows = flights
    .filter((f) => !q || f.cs.includes(q))
    .filter((f) => !israelOnly || isIsraelRelevant(f))
    .filter((f) => activeFilter === 'all' || flightClass(f.cs) === activeFilter)
    .sort((a, b) => a.cs.localeCompare(b.cs));
  const visible = new Set(rows.map((f) => f.hex));
  Object.entries(markers).forEach(([hex, { marker }]) => {
    marker.setOpacity(visible.has(hex) ? 1 : 0.18);
  });
  renderList(rows);
}

function renderList(rows) {
  const box = $('flightList');
  const list = rows || flights;
  if (!list.length) {
    box.innerHTML = `<div class="quota">${t('noFlights')}</div>`;
    return;
  }
  box.innerHTML = list.map((f) => {
    const r = routeCache[f.cs];
    const rt = r ? `${escapeHtml(r.origin)} → ${escapeHtml(r.dest)}` : '···';
    return `<div class="flight-row${f.hex === selectedHex ? ' selected' : ''}" data-hex="${f.hex}">`
      + `<i class="altdot" style="background:${altColor(f.altFt)}"></i>`
      + `<span class="cs">${escapeHtml(f.cs || t('unknown'))}</span>`
      + `<span class="rt">${rt}</span></div>`;
  }).join('');
  box.querySelectorAll('.flight-row').forEach((el) =>
    el.addEventListener('click', () => selectFlight(el.dataset.hex)));
}

function selectFlight(hex) {
  selectedHex = hex;
  const rec = markers[hex];
  if (!rec) return;
  rec.marker.setIcon(planeIcon(rec.f, true));
  Object.entries(markers).forEach(([k, { marker, f }]) => {
    if (k !== hex) marker.setIcon(planeIcon(f, false));
  });
  map.flyTo(rec.marker.getLatLng(), Math.max(map.getZoom(), 9), { duration: 0.7 });
  showDetail(rec.f);
  renderList();
}

function fmtNum(n) { return n == null || isNaN(n) ? '—' : Math.round(n).toLocaleString('en-US'); }

function showDetail(f) {
  const r = routeCache[f.cs];
  $('dCallsign').textContent = f.cs || t('unknown');
  $('dOrigin').textContent = r ? r.origin : '···';
  $('dDest').textContent = r ? r.dest : '···';
  $('dRouteSub').textContent = r
    ? `${r.originName} → ${r.destName}`
    : ({ to: t('toIsrael'), from: t('fromIsrael'), over: t('overflying'), unknown: '', domestic: '' }[flightClass(f.cs)] || '');
  $('dAlt').textContent = fmtNum(f.altFt);
  $('dSpeed').textContent = fmtNum(f.kts);
  $('dTrack').textContent = f.track != null ? Math.round(f.track) + '°' : '—';
  $('dVrate').textContent = f.vrate == null ? '—' : (f.vrate > 0 ? '+' : '') + fmtNum(f.vrate) + ' ' + t('ftMin');
  $('dIcao').textContent = f.reg ? f.reg + (f.type ? ' · ' + f.type : '') : 'ICAO ' + f.hex.toUpperCase();
  $('dCountry').textContent = '';
  $('flightDetail').hidden = false;
}

function tickClock() {
  $('clock').textContent = new Date().toLocaleTimeString(lang === 'he' ? 'he-IL' : 'en-GB',
    { timeZone: 'Asia/Jerusalem', hour12: false });
}

function initMap() {
  map = L.map('map', { zoomControl: true, worldCopyJump: true }).setView([31.6, 34.9], 8);
  map.zoomControl.setPosition('bottomright');
  L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {
    attribution: '&copy; <a href="https://www.esri.com">Esri</a> &copy; Maxar &copy; Earthstar Geographics',
    maxZoom: 19,
  }).addTo(map);
  L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}', {
    maxZoom: 19,
  }).addTo(map);
}

function boot() {
  loadRouteCache();
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
  $('ilOnly').addEventListener('change', (e) => {
    israelOnly = e.target.checked;
    applyFilter();
  });
  $('detailClose').addEventListener('click', () => {
    $('flightDetail').hidden = true;
    if (selectedHex && markers[selectedHex]) {
      markers[selectedHex].marker.setIcon(planeIcon(markers[selectedHex].f, false));
    }
    selectedHex = null;
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
    $('countdown').textContent = secondsLeft + 's';
  }, 1000);
}

document.addEventListener('DOMContentLoaded', boot);
