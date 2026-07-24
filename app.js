const DRIVER_LABELS = {
  Disaster: '災害(地震・警報)',
  Security: '安全保障・有事',
  Health: '感染症',
  Infrastructure: 'インフラ障害',
  PublicSafety: '治安・事件事故'
};
const EVIDENCE_ORDER = ['Security', 'Health', 'Infrastructure', 'PublicSafety'];

// Real prefecture boundary data (same technique ORACLE uses for its world
// map: d3 + topojson-client pulling a public TopoJSON from a CDN, see
// index.html script tags), not a hand-placed grid. Source: jpn-atlas,
// derived from the Geospatial Information Authority of Japan's Global Map
// Japan (2016). Geometry is pre-projected (d3.geoAzimuthalEqualArea, fit to
// an 850×680 viewport) and simplified, so no projection is applied here —
// only d3.geoPath() with its default identity behavior, same as the
// library's own usage example.
const JAPAN_ATLAS_URL = 'https://unpkg.com/jpn-atlas@1.0.2/japan/japan.json';
// Standard JIS X 0401 prefecture codes — the "prefectures" geometry
// collection in the atlas uses these 2-digit codes as feature ids.
const PREFECTURE_CODE_TO_NAME = {
  '01': '北海道', '02': '青森県', '03': '岩手県', '04': '宮城県', '05': '秋田県', '06': '山形県', '07': '福島県',
  '08': '茨城県', '09': '栃木県', '10': '群馬県', '11': '埼玉県', '12': '千葉県', '13': '東京都', '14': '神奈川県',
  '15': '新潟県', '16': '富山県', '17': '石川県', '18': '福井県', '19': '山梨県', '20': '長野県', '21': '岐阜県',
  '22': '静岡県', '23': '愛知県', '24': '三重県', '25': '滋賀県', '26': '京都府', '27': '大阪府', '28': '兵庫県',
  '29': '奈良県', '30': '和歌山県', '31': '鳥取県', '32': '島根県', '33': '岡山県', '34': '広島県', '35': '山口県',
  '36': '徳島県', '37': '香川県', '38': '愛媛県', '39': '高知県', '40': '福岡県', '41': '佐賀県', '42': '長崎県',
  '43': '熊本県', '44': '大分県', '45': '宮崎県', '46': '鹿児島県', '47': '沖縄県'
};

let japanTopoCache = null;
async function loadJapanTopology() {
  if (japanTopoCache) return japanTopoCache;
  const res = await fetch(JAPAN_ATLAS_URL);
  japanTopoCache = await res.json();
  return japanTopoCache;
}

function severityFromWarnings(names) {
  if (!names || !names.length) return 0;
  if (names.some(w => w.includes('特別警報'))) return 3;
  if (names.some(w => w.includes('警報'))) return 2;
  return 1; // 注意報 only
}

function fmtTime(iso) {
  if (!iso) return '';
  try {
    return new Date(iso).toLocaleString('ja-JP', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  } catch (_) { return ''; }
}

async function load() {
  try {
    const res = await fetch('/api/risk-japan');
    const data = await res.json();
    render(data);
  } catch (err) {
    render({ ok: false, isBaseline: true, dataStatus: 'FALLBACK — 通信エラー', score: 15, state: 'STABLE', drivers: {}, weights: {}, categoryEvidence: {}, news: [], earthquakes: [], disasterDetail: null, sourceError: err.message });
  }
}

function render(data) {
  const liveBadge = document.getElementById('liveBadge');
  const statusEl = document.getElementById('dataStatus');
  const badgeClass = data.isBaseline ? (data.mode === 'fallback' ? 'fallback' : 'baseline') : '';
  liveBadge.className = 'live' + (badgeClass ? ' ' + badgeClass : '');
  statusEl.textContent = data.isBaseline ? (data.mode === 'fallback' ? 'FALLBACK' : 'BASELINE') : 'LIVE';
  document.getElementById('updatedAt').textContent = data.updatedAt ? `UPDATED — ${fmtTime(data.updatedAt)}` : 'UPDATED — WAITING';

  const score = data.score ?? 0;
  document.getElementById('scoreValue').textContent = score;
  document.getElementById('scoreState').textContent = data.state || '—';
  document.getElementById('topDriver').textContent = DRIVER_LABELS[data.topDriver] || data.topDriver || '—';

  renderDrivers(data.drivers || {}, data.weights || {});
  renderWarnings(data.disasterDetail);
  renderQuakes(data.earthquakes || []);
  renderEvidence(data.categoryEvidence || {});

  document.getElementById('sourceError').textContent = data.sourceError ? `⚠ ${data.sourceError}` : '';
}

function renderDrivers(drivers, weights) {
  const grid = document.getElementById('driverGrid');
  grid.innerHTML = '';
  for (const key of Object.keys(DRIVER_LABELS)) {
    const val = Math.round(drivers[key] ?? 0);
    const weight = weights[key] != null ? Math.round(weights[key] * 100) : null;
    const card = document.createElement('div');
    card.className = 'driver-card';
    card.innerHTML = `
      <div class="name">${DRIVER_LABELS[key]}</div>
      <div class="value">${val}</div>
      <div class="bar"><i style="width:${val}%"></i></div>
      ${weight != null ? `<div class="weight">重み ${weight}%</div>` : ''}
    `;
    grid.appendChild(card);
  }
}

async function renderWarningMap(entriesByPrefecture) {
  const host = document.getElementById('warningMap');
  if (!host) return;
  if (typeof d3 === 'undefined' || typeof topojson === 'undefined') {
    host.innerHTML = '<p class="no-warning">地図ライブラリを読み込めませんでした。</p>';
    return;
  }
  try {
    const japan = await loadJapanTopology();
    const features = topojson.feature(japan, japan.objects.prefectures).features;
    const sevColor = ['var(--line)', 'var(--lv2)', 'var(--lv4)', 'var(--lv5)'];
    const path = d3.geoPath(); // data is pre-projected to an 850x680 viewport

    host.innerHTML = '';
    const svg = d3.select(host).append('svg')
      .attr('viewBox', '0 0 850 680')
      .attr('width', '100%')
      .attr('role', 'img')
      .attr('aria-label', '都道府県別の気象警報レベル');

    svg.selectAll('path.pref')
      .data(features)
      .join('path')
      .attr('class', 'pref')
      .attr('d', path)
      .attr('fill', d => {
        const name = PREFECTURE_CODE_TO_NAME[d.id] || PREFECTURE_CODE_TO_NAME[String(d.id).padStart(2, '0')];
        const sev = severityFromWarnings(entriesByPrefecture[name]?.warnings);
        return sevColor[sev];
      })
      .attr('stroke', 'rgba(255,255,255,0.15)')
      .attr('stroke-width', 0.6)
      .append('title')
      .text(d => {
        const name = PREFECTURE_CODE_TO_NAME[d.id] || PREFECTURE_CODE_TO_NAME[String(d.id).padStart(2, '0')] || '';
        const entry = entriesByPrefecture[name];
        return entry ? `${name}: ${entry.warnings.join(' / ')}` : `${name}: 活動中の警報・注意報なし`;
      });
  } catch (err) {
    host.innerHTML = '<p class="no-warning">地図データを取得できませんでした。</p>';
  }
}

function renderWarnings(detail) {
  const list = document.getElementById('warningList');
  list.innerHTML = '';
  if (!detail) {
    list.innerHTML = '<p class="no-warning">気象庁データを取得できませんでした。</p>';
    renderWarningMap({});
    return;
  }
  const entries = detail.activeWarningsByPrefecture || [];
  const byName = Object.fromEntries(entries.map(e => [e.prefecture, e]));
  renderWarningMap(byName);

  if (!entries.length) {
    list.innerHTML = '<p class="no-warning">現在、活動中の警報・注意報はありません。</p>';
    return;
  }
  for (const e of entries) {
    const isSpecial = (e.warnings || []).some(w => w.includes('特別警報'));
    const chip = document.createElement('div');
    chip.className = 'warning-chip' + (isSpecial ? ' special' : '');
    chip.innerHTML = `<b>${e.prefecture}</b><span class="tags">${(e.warnings || []).join(' / ')}</span>`;
    list.appendChild(chip);
  }
}

function renderQuakes(quakes) {
  const list = document.getElementById('quakeList');
  list.innerHTML = '';
  if (!quakes.length) {
    list.innerHTML = '<p class="no-warning">直近の速報はありません。</p>';
    return;
  }
  for (const q of quakes.slice(0, 8)) {
    const item = document.createElement('div');
    item.className = 'quake-item';
    item.innerHTML = `<span>${q.title}</span><time>${fmtTime(q.updated)}</time>`;
    list.appendChild(item);
  }
}

function renderEvidence(evidence) {
  const grid = document.getElementById('evidenceGrid');
  grid.innerHTML = '';
  for (const key of EVIDENCE_ORDER) {
    const items = evidence[key] || [];
    const card = document.createElement('div');
    card.className = 'evidence-card';
    card.innerHTML = `<h4>${DRIVER_LABELS[key]}</h4>` + (items.length
      ? `<ul>${items.map(a => `<li><a href="${a.url}" target="_blank" rel="noopener">${a.title}</a></li>`).join('')}</ul>`
      : `<p class="empty">該当する報道は見つかりませんでした。</p>`);
    grid.appendChild(card);
  }
}

load();
setInterval(load, 10 * 60 * 1000);
