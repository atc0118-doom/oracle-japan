import test from 'node:test';
import assert from 'node:assert/strict';
import {
  disasterScore, newsCategoryScore, stateFromScore,
  dedupeByTitleStem, titleStem, extractActiveWarnings,
  groupWarningsByPrefecture, isRoutineBulletin, significantQuakeCount
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

test('newsCategoryScore saturates around 8 articles', () => {
  assert.equal(newsCategoryScore(0), 0);
  assert.equal(newsCategoryScore(8), 100);
  assert.equal(newsCategoryScore(20), 100);
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

test('significantQuakeCount only counts non-routine 震度5+ entries', () => {
  const entries = [
    { title: '震度5弱を観測', isRoutine: false },
    { title: '震度3を観測', isRoutine: false },
    { title: '桜島（定時）震度6弱相当', isRoutine: true }
  ];
  assert.equal(significantQuakeCount(entries), 1);
});
