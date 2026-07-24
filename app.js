const DRIVER_LABELS = {
  Disaster: '災害(地震・警報)',
  Security: '安全保障・有事',
  Health: '感染症',
  Infrastructure: 'インフラ障害',
  PublicSafety: '治安・事件事故'
};
const EVIDENCE_ORDER = ['Security', 'Health', 'Infrastructure', 'PublicSafety'];

// Schematic "grid cartogram" positions — same technique used by Japanese
// election-night graphics: each prefecture gets one grid cell, positioned
// to roughly match real geography (north→south, west→east) rather than
// true coastline shapes. This avoids needing precise boundary path data
// (not available in this environment) while still being instantly
// recognizable as "a map of Japan". Okinawa is placed as a detached inset,
// same convention official Japanese maps use.
const PREFECTURE_GRID = {
  '北海道': [9, 1],
  '青森県': [9, 2], '岩手県': [10, 3], '秋田県': [8, 3], '宮城県': [10, 4], '山形県': [9, 4], '福島県': [10, 5],
  '新潟県': [9, 5], '富山県': [8, 6], '石川県': [7, 6], '福井県': [7, 7], '長野県': [9, 6], '山梨県': [9, 7],
  '群馬県': [10, 6], '栃木県': [11, 6], '茨城県': [12, 6], '埼玉県': [11, 7], '千葉県': [12, 7],
  '東京都': [11, 8], '神奈川県': [11, 9], '静岡県': [10, 8], '岐阜県': [8, 7], '愛知県': [9, 8], '三重県': [8, 8],
  '滋賀県': [7, 8], '京都府': [6, 8], '大阪府': [6, 9], '兵庫県': [5, 8], '奈良県': [7, 9], '和歌山県': [6, 10],
  '鳥取県': [4, 8], '島根県': [3, 8], '岡山県': [4, 9], '広島県': [3, 9], '山口県': [2, 9],
  '徳島県': [5, 10], '香川県': [4, 10], '愛媛県': [3, 10], '高知県': [4, 11],
  '福岡県': [1, 10], '佐賀県': [1, 11], '長崎県': [0, 11], '熊本県': [1, 12], '大分県': [2, 10],
  '宮崎県': [2, 12], '鹿児島県': [1, 13],
  '沖縄県': [0, 15]
};
const TILE = 30, GAP = 3;

function severityFromWarnings(names) {
  if (!names || !names.length) return 0;
  if (names.some(w => w.includes('特別警報'))) return 3;
  if (names.some(w => w.includes('警報'))) return 2;
  return 1; // 注意報 only
}

function levelFromScore(score) {
  if (score >= 70) return 5;
  if (score >= 50) return 4;
  if (score >= 30) return 3;
  if (score >= 15) return 2;
  return 1;
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
  const statusEl = document.getElementById('dataStatus');
  statusEl.textContent = data.dataStatus || '—';
  statusEl.className = 'pill ' + (data.isBaseline ? (data.mode === 'fallback' ? 'fallback' : 'baseline') : 'live');
  document.getElementById('updatedAt').textContent = data.updatedAt ? `更新: ${fmtTime(data.updatedAt)}` : '';

  const score = data.score ?? 0;
  document.getElementById('scoreValue').textContent = score;
  document.getElementById('scoreState').textContent = data.state || '—';
  document.getElementById('topDriver').textContent = DRIVER_LABELS[data.topDriver] || data.topDriver || '—';

  const lvl = levelFromScore(score);
  document.querySelectorAll('.level-cell').forEach(cell => {
    cell.classList.toggle('active', Number(cell.dataset.level) === lvl);
  });

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

function renderWarningMap(entriesByPrefecture) {
  const host = document.getElementById('warningMap');
  if (!host) return;
  const cols = Math.max(...Object.values(PREFECTURE_GRID).map(p => p[0])) + 1;
  const rows = Math.max(...Object.values(PREFECTURE_GRID).map(p => p[1])) + 1;
  const w = cols * (TILE + GAP), h = rows * (TILE + GAP);
  const sevColor = ['var(--line)', 'var(--lv2)', 'var(--lv4)', 'var(--lv5)'];
  let svg = `<svg viewBox="0 0 ${w} ${h}" width="100%" role="img" aria-label="都道府県別の気象警報レベル">`;
  for (const [name, [col, row]] of Object.entries(PREFECTURE_GRID)) {
    const entry = entriesByPrefecture[name];
    const sev = severityFromWarnings(entry?.warnings);
    const x = col * (TILE + GAP), y = row * (TILE + GAP);
    const title = entry ? `${name}: ${entry.warnings.join(' / ')}` : `${name}: 活動中の警報・注意報なし`;
    svg += `<g><title>${title}</title><rect x="${x}" y="${y}" width="${TILE}" height="${TILE}" rx="5" fill="${sevColor[sev]}" stroke="rgba(255,255,255,0.08)"/></g>`;
  }
  svg += `</svg>`;
  host.innerHTML = svg;
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
