// ORACLE JAPAN — domestic life-risk intelligence
//
// DESIGN NOTE: this is NOT a copy of ORACLE (world geopolitical risk) or a
// copy of JAPAN NOW (neutral "what's happening" aggregator, no score). It
// borrows plumbing from ORACLE (cache/TTL, Redis persistence, isBaseline
// honesty pattern, keyword-driver scoring) and borrows JMA data-fetching
// from JAPAN NOW (official warnings + earthquake/volcano feed), but the
// scoring model itself is new: "how much domestic life-risk pressure is
// there right now", not "world geopolitical tension" and not "neutral news
// digest".
//
// CATEGORY SPLIT (see WEIGHTS below):
// - Disaster: driven by STRUCTURED official JMA data (active warning
//   severity + real earthquake/volcano activity), not keyword-matched news.
//   This is deliberately more trustworthy than a keyword heuristic — JMA's
//   own warning levels ARE the ground truth for this category.
// - Security / Health / Infrastructure / PublicSafety: driven by keyword-
//   matched news volume (NHK + Google News Japan), same heuristic-scoring
//   approach ORACLE uses for its Military/Diplomatic/Cyber/etc. drivers —
//   with the same acknowledged limitation: a keyword match is a proxy for
//   "this is being reported on a lot", not verified ground truth.

const CACHE_TTL_MS = 10 * 60 * 1000;
const AREA_CODES_TTL_MS = 24 * 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 6500;

const NHK_RSS_URL = 'https://news.web.nhk/n-data/conf/na/rss/cat0.xml';

// Broad query covering Security/Health/Infrastructure at once (same pattern
// as ORACLE's single fetchGoogleNews query) — categorization happens
// downstream via CATEGORY_KEYWORDS, not via separate per-category feeds.
// PublicSafety is DELIBERATELY excluded from this combined query and given
// its own dedicated fetch below — see PUBLIC_SAFETY_QUERY.
const GOOGLE_NEWS_JP_QUERY = encodeURIComponent('(北朝鮮 OR ミサイル OR 弾道ミサイル OR 領海侵入 OR 領空侵犯 OR 台湾有事 OR 尖閣 OR スクランブル発進 OR 感染症 OR インフルエンザ OR 鳥インフルエンザ OR パンデミック OR 感染拡大 OR ノロウイルス OR 停電 OR 断水 OR 運休 OR システム障害 OR 通信障害 OR 大規模障害 OR 欠航)');
const GOOGLE_NEWS_JP_URL = `https://news.google.com/rss/search?q=${GOOGLE_NEWS_JP_QUERY}&hl=ja&gl=JP&ceid=JP:ja`;

// FIX (signal starvation): when the combined query above has a dominant,
// heavily-reported story (e.g. a citywide water outage generating 5-6
// differently-worded headlines), Google News' relevance ranking can fill
// most or all of the ~25-result window with that one topic, leaving no
// room for PublicSafety terms to surface even when real matches exist. A
// separate, dedicated query for PublicSafety alone guarantees it gets its
// own ~25-result window that nothing else can crowd out.
const PUBLIC_SAFETY_QUERY = encodeURIComponent('(テロ OR 立てこもり OR 大規模火災 OR 殺傷 OR 爆発 OR 銃撃 OR 死亡事故 OR 殺人 OR 強盗 OR 放火 OR 轢き逃げ OR 容疑者逮捕)');
const PUBLIC_SAFETY_URL = `https://news.google.com/rss/search?q=${PUBLIC_SAFETY_QUERY}&hl=ja&gl=JP&ceid=JP:ja`;

const JMA_AREA_JSON_URL = 'https://www.jma.go.jp/bosai/common/const/area.json';
const JMA_WARNING_BASE = 'https://www.jma.go.jp/bosai/warning/data/warning/';
const JMA_EQVOL_FEED_URL = 'https://www.data.jma.go.jp/developer/xml/feed/eqvol.xml';

// ---------------------------------------------------------------------------
// Category keywords for the four news-driven drivers. Unlike ORACLE's
// English lists, Japanese has no word boundaries, so matching is plain
// substring inclusion rather than ORACLE's word-boundary regex approach.
// ---------------------------------------------------------------------------
const CATEGORY_KEYWORDS = {
  // FIX (over-triggering, round 3): a bare actor word like '北朝鮮' matched
  // completely unrelated stories about North Korea (a dog-meat cooking
  // contest was one real observed case), and a bare action word like
  // 'ミサイル' matched missile stories anywhere in the world with zero
  // connection to Japan's own security theater (an Iraq/Kuwait strike was
  // another real observed case). Same fix pattern as Health below: require
  // an ACTOR term (a state/flashpoint relevant to Japan's security) AND a
  // separate ACTION/THREAT term (an actual incident, not just the country
  // being mentioned) in the same headline.
  // FIX (over-triggering, round 4): bare '中国' as an actor matched ANY
  // China-related security story worldwide, including ones with zero
  // connection to Japan (observed case: "中国にミサイル発射を抗議 オーストラリア
  // 外相" — an Australia-China dispute). '尖閣'/'台湾'/'北朝鮮' are flashpoints
  // specific enough to Japan's own security concerns that they can stand
  // alone with an action term (see scoreSecurityCategory below); '中国' and
  // 'ロシア軍' are too broad for that and now additionally require a
  // Japan-relevance term (reusing the same JAPAN_RELEVANCE_TERMS list used
  // elsewhere) before they count.
  // FIX (over-triggering, round 5): '地雷' let through a North Korea/South
  // Korea DMZ landmine-washout story that has no actual bearing on Japan —
  // unlike a missile launch or a naval incursion, a landmine hazard
  // confined to the inter-Korean border doesn't project any threat toward
  // Japan the way this category's other action terms do. Removed.
  Security: {
    flashpoints: ['尖閣', '台湾', '北朝鮮'],
    broadActors: ['中国', 'ロシア軍'],
    actions: ['ミサイル', '弾道', '領海侵入', '領空侵犯', 'スクランブル', '侵入', '軍艦', '実戦訓練', '有事', '演習']
  },
  // FIX (over-triggering, round 2): bare '感染症' matched routine weekly
  // surveillance bulletins ("感染症の流行状況 第29週"), market-research reports
  // ("外用感染症用軟膏の世界市場"), and vaccine-research-center announcements —
  // none of which indicate an actual outbreak happening right now. Health is
  // now scored differently from the other three categories: it requires a
  // named disease term AND a separate escalation term in the SAME headline
  // (see scoreHealthCategory below) rather than a single flat keyword list.
  Health: {
    diseases: ['インフルエンザ', '鳥インフルエンザ', 'ノロウイルス', '麻疹', 'マダニ感染症', '新型コロナ'],
    escalation: ['急増', '拡大', '流行入り', 'クラスター', 'アウトブレイク', '集団感染', '警戒レベル', '警報']
  },
  Infrastructure: ['停電', '断水', '運休', 'システム障害', '通信障害', '大規模障害', '欠航'],
  // FIX (too narrow): the original list (テロ/立てこもり/大規模火災/殺傷/爆発/銃撃)
  // only matches catastrophic, rare event types — a day with genuinely zero
  // matches is plausible for THOSE specific terms, but "治安・事件事故" as a
  // category name implies everyday crime/accident coverage too, which this
  // list had no terms for at all. Added common daily incident/accident terms.
  PublicSafety: ['テロ', '立てこもり', '大規模火災', '殺傷', '爆発', '銃撃', '死亡事故', '殺人', '強盗', '放火', '轢き逃げ', '容疑者逮捕']
};


// Disaster and the four news categories are combined with these weights.
// Disaster carries the largest single weight on purpose: for a *domestic
// life-risk* index (unlike ORACLE's geopolitical-tension index), earthquakes
// and active severe-weather warnings are the single most direct threat to
// daily life in Japan, and they come from structured official data rather
// than a keyword proxy.
const WEIGHTS = { Disaster: 0.35, Security: 0.25, Health: 0.15, Infrastructure: 0.15, PublicSafety: 0.10 };

const CACHE = globalThis.__ORACLE_JAPAN_CACHE__ || (globalThis.__ORACLE_JAPAN_CACHE__ = {
  articles: null, ts: 0, lastError: null, sourceReport: null, areaOffices: null, areaTs: 0
});

const REDIS_URL = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL || null;
const REDIS_TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN || null;
const REDIS_LOG_KEY = 'oraclejapan:score_log';
const REDIS_LOG_MAX_AGE_MS = 9 * 24 * 60 * 60 * 1000;

async function redisCommand(command) {
  if (!REDIS_URL || !REDIS_TOKEN) return null;
  try {
    const r = await fetchWithTimeout(REDIS_URL, {
      method: 'POST',
      headers: { authorization: `Bearer ${REDIS_TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify(command),
      timeout: 4000
    });
    if (!r.ok) return null;
    const j = await r.json();
    return j?.result ?? null;
  } catch (_) {
    return null;
  }
}

async function logScoreToRedis({ score, state, topDriver }) {
  if (!REDIS_URL || !REDIS_TOKEN) return;
  const now = Date.now();
  const member = JSON.stringify({ ts: now, score, state, topDriver });
  await redisCommand(['ZADD', REDIS_LOG_KEY, now, member]);
  await redisCommand(['ZREMRANGEBYSCORE', REDIS_LOG_KEY, 0, now - REDIS_LOG_MAX_AGE_MS]);
}

function parseRedisLogEntries(raw) {
  if (!Array.isArray(raw)) return [];
  return raw.map(s => { try { return JSON.parse(s); } catch (_) { return null; } }).filter(Boolean);
}

async function getServerDelta24h() {
  if (!REDIS_URL || !REDIS_TOKEN) return { available: false };
  const now = Date.now();
  const windowMin = now - 30 * 60 * 60 * 1000;
  const windowMax = now - 20 * 60 * 60 * 1000;
  const raw = await redisCommand(['ZRANGEBYSCORE', REDIS_LOG_KEY, windowMin, windowMax]);
  const entries = parseRedisLogEntries(raw);
  if (!entries.length) return { available: false };
  const target = now - 24 * 60 * 60 * 1000;
  const closest = entries.reduce((best, e) => Math.abs(e.ts - target) < Math.abs(best.ts - target) ? e : best);
  return { available: true, refScore: closest.score, refTs: closest.ts };
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 's-maxage=60, stale-while-revalidate=240');

  try {
    const now = Date.now();
    if (CACHE.payload && now - CACHE.ts < CACHE_TTL_MS) {
      return res.status(200).json(CACHE.payload);
    }

    const payload = await buildPayload();
    payload.serverDelta24h = await getServerDelta24h();
    if (!payload.isBaseline) {
      await logScoreToRedis({ score: payload.score, state: payload.state, topDriver: payload.topDriver });
    }

    CACHE.payload = payload;
    CACHE.ts = Date.now();
    res.status(200).json(payload);
  } catch (error) {
    res.status(200).json(fallbackPayload(error?.message || 'unknown'));
  }
}

async function fetchWithTimeout(url, options = {}) {
  const attempts = options.retries ?? 1;
  let lastErr;
  for (let attempt = 0; attempt <= attempts; attempt++) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), options.timeout || FETCH_TIMEOUT_MS);
    try {
      return await fetch(url, { ...options, signal: controller.signal });
    } catch (err) {
      lastErr = err;
      if (attempt < attempts) await new Promise(r => setTimeout(r, 250));
    } finally {
      clearTimeout(timeout);
    }
  }
  throw lastErr;
}

// ---------------------------------------------------------------------------
// News (Security / Health / Infrastructure / PublicSafety input)
// ---------------------------------------------------------------------------

async function fetchAllNews() {
  const collectors = [['NHK', fetchNHKNews], ['Google News (Japan)', fetchGoogleNewsJP], ['Google News (PublicSafety)', fetchGoogleNewsJP_PublicSafety]];
  const settled = await Promise.allSettled(collectors.map(async ([name, fn]) => {
    const items = await fn();
    return { name, ok: true, count: items.length, items };
  }));
  const report = settled.map((r, i) => {
    const name = collectors[i][0];
    if (r.status === 'fulfilled') return { name, ok: true, count: r.value.count };
    return { name, ok: false, count: 0, error: r.reason?.message || 'error' };
  });
  let items = [];
  for (const r of settled) if (r.status === 'fulfilled') items.push(...r.value.items);
  items = dedupeByTitleStem(items);
  return { items, report };
}

async function fetchNHKNews() {
  const r = await fetchWithTimeout(NHK_RSS_URL, { headers: { 'user-agent': 'OracleJapan/1.0' } });
  if (!r.ok) throw new Error('nhk ' + r.status);
  return parseRss(await r.text(), 'NHK');
}

async function fetchGoogleNewsJP() {
  const r = await fetchWithTimeout(GOOGLE_NEWS_JP_URL, { headers: { 'user-agent': 'OracleJapan/1.0' } });
  if (!r.ok) throw new Error('google_news_jp ' + r.status);
  return parseRss(await r.text(), 'Google News');
}

async function fetchGoogleNewsJP_PublicSafety() {
  const r = await fetchWithTimeout(PUBLIC_SAFETY_URL, { headers: { 'user-agent': 'OracleJapan/1.0' } });
  if (!r.ok) throw new Error('google_news_jp_publicsafety ' + r.status);
  return parseRss(await r.text(), 'Google News');
}

function parseRss(xml, fallbackSource = 'RSS') {
  const items = [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)].map(m => m[1]);
  return items.map(block => {
    const rawTitle = decodeXml((block.match(/<title><!\[CDATA\[([\s\S]*?)\]\]><\/title>/)?.[1] || block.match(/<title>([\s\S]*?)<\/title>/)?.[1] || ''));
    const title = clean(rawTitle
      .replace(/\s+[-|｜]\s+[a-zA-Z0-9-]+(\.[a-zA-Z0-9-]+)+$/, '')
      .replace(/\s+[-|｜]\s+[^-|｜]+$/, '')
      .replace(/\s*[|｜]\s*[^-|｜]+$/, '')
      .replace(/[(（][^()（）]{0,20}(NNN|JNN|FNN|ANN|TXN)[^()（）]{0,20}[)）]\s*$/, '')
      // FIX (false Japan-relevance signal): a trailing outlet suffix like
      //「（中央日報日本語版）」 just means "this is the Japanese-language edition
      // of a Korean outlet" — it's metadata about the publication, not
      // content about Japan. Left attached, its "日本" substring fooled
      // isForeignOnlyStory into treating a pure Korea/DMZ story as
      // Japan-relevant (it appeared in the 治安・事件事故 evidence list despite
      // having nothing to do with Japan). Stripped the same way the
      // NNN/JNN broadcaster-code suffix above is.
      .replace(/[(（][^()（）]{0,20}日本語版[^()（）]{0,20}[)）]\s*$/, '')
    ).slice(0, 140);
    const url = decodeXml(block.match(/<link>([\s\S]*?)<\/link>/)?.[1] || '');
    const source = decodeXml(block.match(/<source[^>]*>([\s\S]*?)<\/source>/)?.[1] || fallbackSource);
    const pub = decodeXml(block.match(/<pubDate>([\s\S]*?)<\/pubDate>/)?.[1] || '');
    return { title, url, source: clean(source) || fallbackSource, published: pub };
  }).filter(a => a.title && a.url);
}

function decodeXml(s = '') {
  return String(s).replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ').replace(/&#160;/g, ' ');
}
function clean(s = '') { return String(s).replace(/\s+/g, ' ').trim(); }

function titleStem(title) {
  return clean(title).toLowerCase().replace(/[^a-z0-9ぁ-んァ-ヶ一-龠]+/g, '').slice(0, 24);
}
function dedupeByTitleStem(items) {
  const seen = new Set(); const out = [];
  for (const a of items) {
    const key = titleStem(a.title);
    if (!key || seen.has(key)) continue;
    seen.add(key); out.push(a);
  }
  return out;
}

// FIX (miscategorization): ported from JAPAN NOW. A story about a foreign
// country's own security/incident affairs (e.g. a North Korea/South Korea
// DMZ landmine story) can still match a generic keyword like '爆発' and leak
// into Health/Infrastructure/PublicSafety — categories meant to represent
// risk to daily life IN Japan, not overseas events. Security is
// deliberately EXEMPT from this filter: North Korea/China regional
// activity is exactly what that category is meant to capture, even when
// the event itself happens outside Japan.
const FOREIGN_ONLY_INDICATOR_TERMS = ['北朝鮮', '韓国', 'ロシア', 'ウクライナ', 'イスラエル', 'ガザ', 'シリア', 'レバノン', 'イラン', '中国軍', '台湾'];
const JAPAN_RELEVANCE_TERMS = ['日本', '日系', '邦人', '在日', '対日', '日米', '日露', '日中', '日韓', '日ロ', '来日', '訪日', '国内', '県', '市'];
function isForeignOnlyStory(title) {
  const t = String(title || '');
  const hasForeignSignal = FOREIGN_ONLY_INDICATOR_TERMS.some(term => t.includes(term));
  if (!hasForeignSignal) return false;
  const hasJapanRelevance = JAPAN_RELEVANCE_TERMS.some(term => t.includes(term));
  return !hasJapanRelevance;
}

function scoreSecurityCategory(articles) {
  const { flashpoints, broadActors, actions } = CATEGORY_KEYWORDS.Security;
  const hits = articles.filter(a => {
    if (!actions.some(x => a.title.includes(x))) return false;
    if (flashpoints.some(x => a.title.includes(x))) return true;
    if (broadActors.some(x => a.title.includes(x))) {
      return JAPAN_RELEVANCE_TERMS.some(t => a.title.includes(t));
    }
    return false;
  });
  return { count: hits.length, hits: hits.slice(0, 6) };
}

function scoreHealthCategory(articles) {
  const { diseases, escalation } = CATEGORY_KEYWORDS.Health;
  const hits = articles.filter(a =>
    !isForeignOnlyStory(a.title) &&
    diseases.some(d => a.title.includes(d)) &&
    escalation.some(e => a.title.includes(e))
  );
  return { count: hits.length, hits: hits.slice(0, 6) };
}


// (article-level presence, not raw term frequency — mirrors ORACLE's
// intent of "how much is this being reported on" rather than double-
// counting a single article that repeats a keyword many times).
function scoreNewsCategory(articles, terms, { domesticOnly = false } = {}) {
  const pool = domesticOnly ? articles.filter(a => !isForeignOnlyStory(a.title)) : articles;
  const hits = pool.filter(a => terms.some(t => a.title.includes(t)));
  return { count: hits.length, hits: hits.slice(0, 6) };
}

// ---------------------------------------------------------------------------
// JMA warnings (structured Disaster input) — adapted from JAPAN NOW
// ---------------------------------------------------------------------------

const JMA_WARNING_CODE_NAMES = {
  '02': '暴風雪警報', '03': '大雨警報', '04': '洪水警報', '05': '暴風警報', '06': '大雪警報',
  '07': '波浪警報', '08': '高潮警報', '09': '土砂災害警報', '10': '大雨注意報', '12': '大雪注意報',
  '13': '風雪注意報', '14': '雷注意報', '15': '強風注意報', '16': '波浪注意報', '17': '融雪注意報',
  '18': '洪水注意報', '19': '高潮注意報', '20': '濃霧注意報', '21': '乾燥注意報', '22': 'なだれ注意報',
  '23': '低温注意報', '24': '霜注意報', '25': '着氷注意報', '26': '着雪注意報', '29': '土砂災害注意報',
  '32': '暴風雪特別警報', '33': '大雨特別警報', '35': '暴風特別警報', '36': '大雪特別警報',
  '37': '波浪特別警報', '38': '高潮特別警報', '39': '土砂災害特別警報', '43': '大雨危険警報',
  '48': '高潮危険警報', '49': '土砂災害危険警報'
};
// Split by severity tier for scoring — 特別警報(emergency) counts far more
// than a 注意報(advisory). This drives the Disaster structural score.
const SPECIAL_WARNING_CODES = new Set(['32', '33', '35', '36', '37', '38', '39', '43', '48', '49']);
const WARNING_CODES = new Set(['02', '03', '04', '05', '06', '07', '08', '09']);

const PREFECTURE_GROUP_LABELS = {
  '011000': '北海道', '012000': '北海道', '013000': '北海道', '014030': '北海道',
  '014100': '北海道', '015000': '北海道', '016000': '北海道', '017000': '北海道',
  '471000': '沖縄県', '472000': '沖縄県', '473000': '沖縄県', '474000': '沖縄県'
};

async function fetchJMAOffices() {
  const now = Date.now();
  if (CACHE.areaOffices && now - CACHE.areaTs < AREA_CODES_TTL_MS) return CACHE.areaOffices;
  const r = await fetchWithTimeout(JMA_AREA_JSON_URL, { headers: { 'user-agent': 'OracleJapan/1.0' } });
  if (!r.ok) throw new Error('jma_area ' + r.status);
  const j = await r.json();
  const centers = j.centers || {};
  const officesById = j.offices || {};
  const orderedCodes = [];
  for (const center of Object.values(centers)) {
    for (const code of (center.children || [])) {
      if (officesById[code] && !orderedCodes.includes(code)) orderedCodes.push(code);
    }
  }
  for (const code of Object.keys(officesById)) if (!orderedCodes.includes(code)) orderedCodes.push(code);
  const offices = orderedCodes.map(code => ({ code, name: officesById[code].name }));
  CACHE.areaOffices = offices; CACHE.areaTs = now;
  return offices;
}

function extractActiveWarnings(data) {
  const found = [];
  const walk = (node) => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) { node.forEach(walk); return; }
    if (typeof node.code === 'string' && typeof node.status === 'string' && node.status !== '解除') {
      found.push(node.code);
    }
    Object.values(node).forEach(walk);
  };
  walk(data);
  return found;
}

function groupWarningsByPrefecture(officeResults) {
  const grouped = new Map();
  for (const { office, codes } of officeResults) {
    if (!codes || !codes.length) continue;
    const label = PREFECTURE_GROUP_LABELS[office.code] || office.name;
    if (!grouped.has(label)) grouped.set(label, { prefecture: label, codes: new Set(), names: new Set() });
    const entry = grouped.get(label);
    codes.forEach(c => { entry.codes.add(c); entry.names.add(JMA_WARNING_CODE_NAMES[c] || `警報コード${c}`); });
  }
  return [...grouped.values()].map(g => ({ prefecture: g.prefecture, codes: [...g.codes], warnings: [...g.names] }));
}

async function fetchAllWarnings() {
  const offices = await fetchJMAOffices();
  const settled = await Promise.allSettled(offices.map(async (office) => {
    const r = await fetchWithTimeout(JMA_WARNING_BASE + office.code + '.json', { headers: { 'user-agent': 'OracleJapan/1.0' }, timeout: 5000 });
    if (!r.ok) throw new Error(String(r.status));
    const j = await r.json();
    return { office, codes: extractActiveWarnings(j) };
  }));
  let failCount = 0;
  const officeResults = [];
  for (const r of settled) {
    if (r.status !== 'fulfilled') { failCount++; continue; }
    officeResults.push(r.value);
  }
  const active = groupWarningsByPrefecture(officeResults);
  const error = failCount > offices.length * 0.5 ? `${failCount}/${offices.length} offices unreachable` : null;

  let specialCount = 0, warningCount = 0, advisoryCount = 0;
  for (const entry of active) {
    for (const c of entry.codes) {
      if (SPECIAL_WARNING_CODES.has(c)) specialCount++;
      else if (WARNING_CODES.has(c)) warningCount++;
      else advisoryCount++;
    }
  }
  return { items: active, error, specialCount, warningCount, advisoryCount };
}

// ---------------------------------------------------------------------------
// JMA earthquake / volcano feed — adapted from JAPAN NOW
// ---------------------------------------------------------------------------

function isRoutineBulletin(title) { return /（定時）|\(定時\)/.test(title); }

async function fetchEarthquakes() {
  const r = await fetchWithTimeout(JMA_EQVOL_FEED_URL, { headers: { 'user-agent': 'OracleJapan/1.0' } });
  if (!r.ok) throw new Error('jma_eqvol ' + r.status);
  const xml = await r.text();
  const entries = [...xml.matchAll(/<entry>([\s\S]*?)<\/entry>/g)].map(m => m[1]);
  return entries.map(block => {
    const title = decodeXml(block.match(/<title>([\s\S]*?)<\/title>/)?.[1] || '');
    const updated = decodeXml(block.match(/<updated>([\s\S]*?)<\/updated>/)?.[1] || '');
    const link = block.match(/<link href="([^"]*)"/)?.[1] || '';
    return { title: clean(title), updated, url: link, isRoutine: isRoutineBulletin(title) };
  }).filter(e => e.title).sort((a, b) => new Date(b.updated || 0) - new Date(a.updated || 0));
}

// Rough severity signal from earthquake feed titles: JMA's 震度速報/地震情報
// bulletins mention 震度 (seismic intensity) levels in the title text; a
// bulletin mentioning intensity 5弱 or higher within the last few entries is
// treated as a meaningful recent-earthquake signal. This is a coarse text
// heuristic (like ORACLE's keyword matching), not a parsed structured field
// — the Atom feed's title format doesn't expose intensity as clean JSON.
const SIGNIFICANT_INTENSITY_PATTERN = /震度[5-7]/;
function significantQuakeCount(entries) {
  return entries.filter(e => !e.isRoutine && SIGNIFICANT_INTENSITY_PATTERN.test(e.title)).length;
}

// ---------------------------------------------------------------------------
// Scoring
// ---------------------------------------------------------------------------

function disasterScore({ specialCount, warningCount, advisoryCount, quakeSignificant }) {
  // Structural score, not keyword-derived: each 特別警報(emergency) contributes
  // heavily, each 警報 moderately, each 注意報 lightly, each significant
  // earthquake (震度5弱+) heavily. Capped at 100.
  //
  // FIX (calibration): 注意報(advisory, the LOWEST severity tier — things
  // like 雷注意報/濃霧注意報) is issued somewhere in Japan on almost any
  // summer afternoon; a perfectly ordinary day can easily have 20-25 of
  // them active nationwide at once. At the original weight of 2 points each,
  // that alone produced a Disaster score of ~50 (already "WATCH/HIGH"
  // territory) with zero actual 警報 or 特別警報 anywhere. Advisory weight is
  // dropped to 0.4 so a routine advisory-only day scores low, while an
  // actual 警報 (still worth 8) or 特別警報 (30) still dominates the score
  // the way it should.
  const raw = specialCount * 30 + warningCount * 8 + advisoryCount * 0.4 + quakeSignificant * 25;
  return Math.min(100, raw);
}

function newsCategoryScore(count) {
  // FIX (calibration): denominator raised from 8 to 14. A single real event
  // (e.g. one city's water outage) routinely generates 4-6 differently-
  // worded headlines across outlets that survive dedupeByTitleStem's
  // 24-char-prefix matching — meaning one localized incident could already
  // saturate this to 100, the same score a genuinely nationwide, multi-
  // event day would get. This is a documented, imperfect mitigation (real
  // per-event dedup would need entity extraction this project doesn't have)
  // rather than a full fix — see README.
  return Math.min(100, Math.round((count / 14) * 100));
}

function stateFromScore(s) { if (s >= 70) return 'CRITICAL'; if (s >= 50) return 'HIGH'; if (s >= 30) return 'WATCH'; return 'STABLE'; }
function round1(n) { return Math.round(Number(n || 0) * 10) / 10; }

async function buildPayload() {
  const [newsResult, warningsResult, quakesResult] = await Promise.allSettled([
    fetchAllNews(), fetchAllWarnings(), fetchEarthquakes()
  ]);

  const news = newsResult.status === 'fulfilled' ? newsResult.value.items : [];
  const newsReport = newsResult.status === 'fulfilled' ? newsResult.value.report : [{ name: 'News', ok: false, error: newsResult.reason?.message || 'error' }];

  const warningsData = warningsResult.status === 'fulfilled' ? warningsResult.value : { items: [], specialCount: 0, warningCount: 0, advisoryCount: 0, error: warningsResult.reason?.message || 'error' };
  const quakes = quakesResult.status === 'fulfilled' ? quakesResult.value : [];
  const quakesError = quakesResult.status === 'rejected' ? (quakesResult.reason?.message || 'error') : null;

  const anyLiveNews = news.length > 0;
  const anyLiveDisaster = warningsData.items.length >= 0 && !warningsData.error || quakes.length > 0;
  const isBaseline = !anyLiveNews && !anyLiveDisaster;

  const failedSources = [
    ...newsReport.filter(r => !r.ok).map(r => `${r.name} ${r.error}`),
    ...(warningsData.error ? [`JMA warnings ${warningsData.error}`] : []),
    ...(quakesError ? [`JMA earthquakes ${quakesError}`] : [])
  ];

  const driverScores = isBaseline
    ? { Disaster: 15, Security: 10, Health: 5, Infrastructure: 5, PublicSafety: 5 }
    : {
        Disaster: disasterScore({
          specialCount: warningsData.specialCount, warningCount: warningsData.warningCount,
          advisoryCount: warningsData.advisoryCount, quakeSignificant: significantQuakeCount(quakes)
        }),
        Security: newsCategoryScore(scoreSecurityCategory(news).count),
        Health: newsCategoryScore(scoreHealthCategory(news).count),
        Infrastructure: newsCategoryScore(scoreNewsCategory(news, CATEGORY_KEYWORDS.Infrastructure, { domesticOnly: true }).count),
        PublicSafety: newsCategoryScore(scoreNewsCategory(news, CATEGORY_KEYWORDS.PublicSafety, { domesticOnly: true }).count)
      };

  const finalScore = Math.round(Object.entries(WEIGHTS).reduce((sum, [k, w]) => sum + (driverScores[k] || 0) * w, 0));
  const state = stateFromScore(finalScore);
  const topDriver = Object.entries(driverScores).sort((a, b) => b[1] - a[1])[0]?.[0] || 'Disaster';

  const categoryEvidence = {
    Security: isBaseline ? [] : scoreSecurityCategory(news).hits.map(a => ({ title: a.title, source: a.source, url: a.url })),
    Health: isBaseline ? [] : scoreHealthCategory(news).hits.map(a => ({ title: a.title, source: a.source, url: a.url })),
    Infrastructure: isBaseline ? [] : scoreNewsCategory(news, CATEGORY_KEYWORDS.Infrastructure, { domesticOnly: true }).hits.map(a => ({ title: a.title, source: a.source, url: a.url })),
    PublicSafety: isBaseline ? [] : scoreNewsCategory(news, CATEGORY_KEYWORDS.PublicSafety, { domesticOnly: true }).hits.map(a => ({ title: a.title, source: a.source, url: a.url }))
  };

  return {
    ok: true,
    mode: isBaseline ? 'baseline' : 'live',
    isBaseline,
    dataStatus: isBaseline ? 'BASELINE — 情報源に到達できません' : 'LIVE',
    updatedAt: new Date().toISOString(),
    cacheTtlMinutes: Math.round(CACHE_TTL_MS / 60000),
    sourceError: failedSources.length ? failedSources.join(' · ') : null,
    score: finalScore,
    state,
    topDriver,
    drivers: driverScores,
    weights: WEIGHTS,
    disasterDetail: isBaseline ? null : {
      specialWarningCount: warningsData.specialCount,
      warningCount: warningsData.warningCount,
      advisoryCount: warningsData.advisoryCount,
      significantEarthquakes: significantQuakeCount(quakes),
      activeWarningsByPrefecture: warningsData.items
    },
    categoryEvidence,
    earthquakes: isBaseline ? [] : quakes.filter(q => !q.isRoutine).slice(0, 10),
    news: isBaseline ? [] : news.slice(0, 30),
    sourceReport: [
      ...newsReport,
      { name: 'JMA Warnings', ok: !warningsData.error, error: warningsData.error || undefined },
      { name: 'JMA Earthquakes', ok: !quakesError, error: quakesError || undefined }
    ]
  };
}

function fallbackPayload(error) {
  return {
    ok: true, mode: 'fallback', isBaseline: true, dataStatus: 'FALLBACK — 内部エラー', sourceError: error,
    updatedAt: new Date().toISOString(), cacheTtlMinutes: Math.round(CACHE_TTL_MS / 60000),
    score: 15, state: 'STABLE', topDriver: 'Disaster',
    drivers: { Disaster: 15, Security: 10, Health: 5, Infrastructure: 5, PublicSafety: 5 },
    weights: WEIGHTS, disasterDetail: null, categoryEvidence: {}, earthquakes: [], news: [],
    sourceReport: [{ name: 'All sources', ok: false, error }]
  };
}

export { dedupeByTitleStem, titleStem, extractActiveWarnings, groupWarningsByPrefecture, isRoutineBulletin, significantQuakeCount, disasterScore, newsCategoryScore, stateFromScore, parseRss, clean, decodeXml, isForeignOnlyStory, scoreHealthCategory, scoreNewsCategory, scoreSecurityCategory };
