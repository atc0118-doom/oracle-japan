const DRIVER_LABELS = {
  Disaster: '災害(地震・警報)',
  Security: '安全保障・有事',
  Health: '感染症',
  Infrastructure: 'インフラ障害',
  PublicSafety: '治安・事件事故'
};
const EVIDENCE_ORDER = ['Security', 'Health', 'Infrastructure', 'PublicSafety'];

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

function renderWarnings(detail) {
  const list = document.getElementById('warningList');
  list.innerHTML = '';
  if (!detail) {
    list.innerHTML = '<p class="no-warning">気象庁データを取得できませんでした。</p>';
    return;
  }
  const entries = detail.activeWarningsByPrefecture || [];
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
