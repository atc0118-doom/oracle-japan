import test from 'node:test';
import assert from 'node:assert/strict';
import {
  disasterScore, newsCategoryScore, stateFromScore,
  dedupeByTitleStem, titleStem, extractActiveWarnings,
  groupWarningsByPrefecture, isRoutineBulletin, significantQuakeCount,
  isForeignOnlyStory, scoreHealthCategory, scoreNewsCategory, parseRss,
  scoreSecurityCategory, CATEGORY_KEYWORDS
} from '../api/risk-japan.js';

test('disasterScore weights 特別警報 much higher than 注意報', () => {
  const special = disasterScore({ specialCount: 1, warningCount: 0, advisoryCount: 0, quakeSignificant: 0 });
  const advisory = disasterScore({ specialCount: 0, warningCount: 0, advisoryCount: 1, quakeSignificant: 0 });
  assert.ok(special > advisory);
});

test('disasterScore caps at 100', () => {
  const s = disasterScore({ specialCount: 10, warningCount: 10, advisoryCount: 10, quakeSignificant: 10 });
  assert.equal(s, 100);
});

test('newsCategoryScore saturates around 14 articles', () => {
  assert.equal(newsCategoryScore(0), 0);
  assert.equal(newsCategoryScore(14), 100);
  assert.equal(newsCategoryScore(30), 100);
});

test('stateFromScore thresholds', () => {
  assert.equal(stateFromScore(10), 'STABLE');
  assert.equal(stateFromScore(35), 'WATCH');
  assert.equal(stateFromScore(55), 'HIGH');
  assert.equal(stateFromScore(80), 'CRITICAL');
});

test('titleStem strips punctuation and keeps Japanese chars', () => {
  assert.equal(titleStem('北海道で震度5弱の地震、注意呼びかけ'), titleStem('北海道で震度5弱の地震、注意呼びかけ'));
});

test('dedupeByTitleStem removes headlines sharing the same 24-char stem', () => {
  // titleStem truncates to 24 chars, so dedup only catches shared PREFIXES
  // of at least that length — this mirrors the real-world case of outlets
  // appending a short trailing clause after an identical opening.
  const items = [
    { title: '北海道で震度5弱の地震が発生し東北でも揺れを観測、津波の心配なし', url: 'https://a.example/1' },
    { title: '北海道で震度5弱の地震が発生し東北でも揺れを観測、気象庁が会見', url: 'https://a.example/2' },
    { title: '沖縄で大雨特別警報を発表', url: 'https://a.example/3' }
  ];
  const out = dedupeByTitleStem(items);
  assert.equal(out.length, 2);
});

test('extractActiveWarnings ignores cleared (解除) entries', () => {
  const data = { area: [{ code: '03', status: '継続' }, { code: '10', status: '解除' }] };
  assert.deepEqual(extractActiveWarnings(data), ['03']);
});

test('extractActiveWarnings returns empty for "no warnings" shape', () => {
  const data = { area: { status: '発表警報・注意報はなし' } };
  assert.deepEqual(extractActiveWarnings(data), []);
});

test('groupWarningsByPrefecture groups Hokkaido offices into one label', () => {
  const officeResults = [
    { office: { code: '011000', name: '宗谷地方' }, codes: ['03'] },
    { office: { code: '012000', name: '上川・留萌地方' }, codes: ['05'] }
  ];
  const grouped = groupWarningsByPrefecture(officeResults);
  assert.equal(grouped.length, 1);
  assert.equal(grouped[0].prefecture, '北海道');
});

test('isRoutineBulletin detects scheduled ashfall bulletins', () => {
  assert.equal(isRoutineBulletin('桜島の火山活動（定時）'), true);
  assert.equal(isRoutineBulletin('震度速報'), false);
});

test('isRoutineBulletin also treats routine volcano commentary/forecast bulletins as routine', () => {
  // These are issued roughly hourly for any already-active volcano and
  // don't indicate a new event — same treatment as the (定時) ashfall case.
  assert.equal(isRoutineBulletin('火山の状況に関する解説情報（桜島）'), true);
  assert.equal(isRoutineBulletin('推定噴煙流向報'), true);
  // An actual eruption report/warning should NOT be treated as routine.
  assert.equal(isRoutineBulletin('噴火に関する火山観測報'), false);
  assert.equal(isRoutineBulletin('噴火警報'), false);
});

test('significantQuakeCount only counts non-routine 震度5+ entries', () => {
  const entries = [
    { title: '震度5弱を観測', isRoutine: false },
    { title: '震度3を観測', isRoutine: false },
    { title: '桜島（定時）震度6弱相当', isRoutine: true }
  ];
  assert.equal(significantQuakeCount(entries), 1);
});

test('disasterScore: an advisory-only day (no 警報/特別警報) stays low even with many advisories', () => {
  // Regression check for the real-world case observed in production: ~25
  // active advisories nationwide (routine summer 雷注意報/濃霧注意報), zero
  // actual 警報 or 特別警報, zero significant earthquakes. This should NOT
  // land in WATCH/HIGH territory.
  const s = disasterScore({ specialCount: 0, warningCount: 0, advisoryCount: 25, quakeSignificant: 0 });
  assert.ok(s < 20, `expected a quiet advisory-only day to score low, got ${s}`);
});

test('disasterScore: a single 警報 still meaningfully outweighs a pile of advisories', () => {
  const withWarning = disasterScore({ specialCount: 0, warningCount: 1, advisoryCount: 5, quakeSignificant: 0 });
  const advisoryOnly = disasterScore({ specialCount: 0, warningCount: 0, advisoryCount: 5, quakeSignificant: 0 });
  assert.ok(withWarning > advisoryOnly);
});

test('newsCategoryScore: a single event covered by ~5 outlets no longer auto-caps at 100', () => {
  // Regression check: one real localized incident (e.g. one city's water
  // outage) reported by 4-6 differently-worded headlines should not score
  // identically to a genuinely widespread multi-event day.
  const singleEventCoverage = newsCategoryScore(5);
  assert.ok(singleEventCoverage < 100 && singleEventCoverage > 0);
});

test('isForeignOnlyStory flags a Korea-only story with no Japan relevance', () => {
  assert.equal(isForeignOnlyStory('北朝鮮非武装地帯で地雷爆発…韓国軍が発表'), true);
});

test('isForeignOnlyStory does not flag a story explicitly about Japan-China relations', () => {
  assert.equal(isForeignOnlyStory('尖閣諸島沖の日本領海に中国海警局の船が侵入'), false);
});

test('scoreSecurityCategory rejects actor-only or action-only headlines with no real Japan-security link', () => {
  const articles = [
    { title: '北朝鮮・平壌で「犬肉料理」のコンテスト開催 伝統文化、味や見栄え競う', url: 'https://a/1', source: 'x' },
    { title: 'イラク国境付近での攻撃を受け、ミサイルやドローンがクウェートを標的に', url: 'https://a/2', source: 'x' },
    { title: '尖閣諸島・魚釣島沖の領海に中国海警局の船4隻が相次いで侵入', url: 'https://a/3', source: 'x' },
    { title: '北朝鮮が非武装地帯に埋設した大量の地雷、豪雨で一部流出か', url: 'https://a/4', source: 'x' },
    { title: '中国にミサイル発射を抗議 オーストラリア外相：時事ドットコム', url: 'https://a/5', source: 'x' }
  ];
  const { count, hits } = scoreSecurityCategory(articles);
  // The landmine story is a DMZ/inter-Korean border hazard with no actual
  // bearing on Japan — it correctly does NOT match (no term in `actions`
  // describes it since '地雷' was removed; see round-5 fix above).
  assert.equal(count, 1);
  assert.deepEqual(hits.map(h => h.title), [
    '尖閣諸島・魚釣島沖の領海に中国海警局の船4隻が相次いで侵入'
  ]);
});

test('scoreSecurityCategory allows a broad-actor (中国/ロシア軍) story only when it also carries a Japan-relevance term', () => {
  const articles = [
    { title: '中国軍艦、日本領海に接近 防衛省が警戒', url: 'https://a/1', source: 'x' },
    { title: 'ロシア軍が演習を実施、米国が非難声明', url: 'https://a/2', source: 'x' }
  ];
  const { count, hits } = scoreSecurityCategory(articles);
  assert.equal(count, 1);
  assert.equal(hits[0].title, '中国軍艦、日本領海に接近 防衛省が警戒');
});

test('scoreHealthCategory rejects routine surveillance/market-report headlines with no disease+escalation pair', () => {
  const articles = [
    { title: '感染症の流行状況 2026年 第29週', url: 'https://a/1', source: 'x' },
    { title: '外用感染症用軟膏の世界市場（2026年〜2032年）', url: 'https://a/2', source: 'x' },
    { title: '県内でインフルエンザが急増、学級閉鎖相次ぐ', url: 'https://a/3', source: 'x' }
  ];
  const { count, hits } = scoreHealthCategory(articles);
  assert.equal(count, 1);
  assert.equal(hits[0].title, '県内でインフルエンザが急増、学級閉鎖相次ぐ');
});

test('parseRss strips a trailing "(outlet 日本語版)" suffix so it cannot leak a false Japan-relevance signal', () => {
  const xml = `<item><title>北朝鮮非武装地帯で地雷爆発…韓国合同参謀本部「豪雨で流失の地雷に注意」（中央日報日本語版）</title><link>https://a/1</link></item>`;
  const [item] = parseRss(xml, 'Test');
  assert.equal(item.title.includes('日本語版'), false);
  assert.equal(isForeignOnlyStory(item.title), true);
});

test('scoreNewsCategory with domesticOnly excludes a foreign-only story leaking via a generic keyword', () => {
  const articles = [
    { title: '北朝鮮非武装地帯で地雷爆発…韓国軍が発表', url: 'https://a/1', source: 'x' },
    { title: '大阪市内で爆発、消防が出動', url: 'https://a/2', source: 'x' }
  ];
  const { count } = scoreNewsCategory(articles, ['爆発'], { domesticOnly: true });
  assert.equal(count, 1);
});

test('PublicSafety rejects a figurative "爆発" used as a festival slogan, not an actual incident', () => {
  const articles = [
    { title: '『横濱漢祭 2026』今年も応援総長に角田信朗さん就任決定ッ！今年のテーマは「漢気爆発 盆バイエ」!!', url: 'https://a/1', source: 'x' },
    { title: '工場でガス爆発、2人搬送 東京都内', url: 'https://a/2', source: 'x' }
  ];
  const { count, hits } = scoreNewsCategory(articles, CATEGORY_KEYWORDS.PublicSafety, { domesticOnly: true });
  assert.equal(count, 1);
  assert.equal(hits[0].title, '工場でガス爆発、2人搬送 東京都内');
});
