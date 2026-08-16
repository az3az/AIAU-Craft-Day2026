// Code.gs を Google のサービスをスタブした vm に読み込んで確かめる。
// 実行: node apps-script/tests/code_test.js
// 外部通信は行わず、使う住所は公共施設の匿名サンプルだけ。
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

const source = fs.readFileSync(path.join(__dirname, '..', 'Code.gs'), 'utf8');

// 匿名サンプル（公共施設の住所）。実データは使わない。
const GEO = {
  '東京都江東区有明3-11-1': { lat: 35.6300, lng: 139.7950 },
  '東京都渋谷区神南1-19-8': { lat: 35.6640, lng: 139.6990 },
  '東京都新宿区西新宿2-8-1': { lat: 35.6895, lng: 139.6917 },
  '東京都千代田区丸の内2-4-1': { lat: 35.6810, lng: 139.7660 },
  '東京都港区海岸1-7-1': { lat: 35.6560, lng: 139.7570 },
  '存在しない住所テスト': null,
};

let fetchCount = 0;
const sheetValues = {};

function makeSheet(name, values) {
  const data = values.map(row => row.slice());
  return {
    name,
    data,
    written: [],
    getName: () => name,
    getDataRange: () => ({ getValues: () => data.map(r => r.slice()) }),
    getLastColumn: () => Math.max(...data.map(r => r.length)),
    getRange(row, col, numRows, numCols) {
      return {
        setValue: v => { (data[row - 1] = data[row - 1] || [])[col - 1] = v; },
        setValues: v => { v.forEach((r, i) => { data[row - 1 + i] = r.slice(); }); },
        setBackground: () => this, setVerticalAlignment: () => this,
        setFontWeight: () => this, setWrap: () => this, setHorizontalAlignment: () => this,
      };
    },
    clear: () => {}, setFrozenRows: () => {}, setRowHeight: () => {},
    setRowHeights: () => {}, setColumnWidth: () => {},
  };
}

const sandbox = {
  console,
  Utilities: { formatDate: (d) => d.toISOString().slice(0, 10) },
  Session: { getScriptTimeZone: () => 'Asia/Tokyo' },
  PropertiesService: {
    getScriptProperties: () => ({
      getProperty: (key) => ({
        GOOGLE_MAPS_API_KEY: 'test-key-not-real',
        ROUTE_ORIGIN_NAME: '会社センター',
        ROUTE_ORIGIN_ADDRESS: '東京都千代田区丸の内1-9-1',
      }[key] || null),
    }),
  },
  UrlFetchApp: {
    fetch: (url) => {
      fetchCount++;
      const address = decodeURIComponent(url.match(/address=([^&]+)/)[1]);
      const point = address === '東京都千代田区丸の内1-9-1'
        ? { lat: 35.6812, lng: 139.7671 }
        : GEO[address];
      const body = point
        ? { status: 'OK', results: [{ geometry: { location: point } }] }
        : { status: 'ZERO_RESULTS', results: [] };
      return { getResponseCode: () => 200, getContentText: () => JSON.stringify(body) };
    },
  },
  SpreadsheetApp: { getActiveSpreadsheet: () => spreadsheet },
};

let spreadsheet;
vm.createContext(sandbox);
vm.runInContext(source, sandbox);

function run(name, fn) {
  try { fn(); console.log('PASS ' + name); }
  catch (e) { console.log('FAIL ' + name + ': ' + e.message); process.exitCode = 1; }
}

run('normalizeDate: 複数表記を YYYY-MM-DD に揃える', () => {
  assert.strictEqual(sandbox.normalizeDate('2026-08-15'), '2026-08-15');
  assert.strictEqual(sandbox.normalizeDate('2026/8/5'), '2026-08-05');
  assert.strictEqual(sandbox.normalizeDate(new Date('2026-08-15T00:00:00Z')), '2026-08-15');
  assert.strictEqual(sandbox.normalizeDate('8/15'), '');
  assert.strictEqual(sandbox.normalizeDate(''), '');
});

run('uniqueSheetName: 同名タブは上書きせず連番', () => {
  assert.strictEqual(sandbox.uniqueSheetName([], '2026-08-15_配送ルート'), '2026-08-15_配送ルート');
  assert.strictEqual(
    sandbox.uniqueSheetName(['2026-08-15_配送ルート'], '2026-08-15_配送ルート'),
    '2026-08-15_配送ルート_2');
  assert.strictEqual(
    sandbox.uniqueSheetName(['2026-08-15_配送ルート', '2026-08-15_配送ルート_2'], '2026-08-15_配送ルート'),
    '2026-08-15_配送ルート_3');
});

run('parseInputSheet: id/name 空でも住所だけで動く', () => {
  const parsed = sandbox.parseInputSheet([
    ['配送日', '2026-08-15'],
    [],
    ['id', 'name', 'address', 'priority'],
    ['', '', '東京都江東区有明3-11-1', '1'],
    ['D9', '渋谷会場', '東京都渋谷区神南1-19-8', ''],
    ['', '', '', ''],
  ]);
  assert.strictEqual(parsed.deliveryDate, '2026-08-15');
  assert.strictEqual(parsed.destinations.length, 2);
  assert.strictEqual(parsed.destinations[0].id, 'D01');
  assert.strictEqual(parsed.destinations[0].name, '東京都江東区有明3-11-1');
  assert.strictEqual(parsed.destinations[0].priority, 1);
  assert.strictEqual(parsed.destinations[1].priority, 9);
});

run('parseInputSheet: delivery_date 列からも配送日を取れる', () => {
  const parsed = sandbox.parseInputSheet([
    ['address', 'delivery_date'],
    ['東京都渋谷区神南1-19-8', '2026/9/1'],
  ]);
  assert.strictEqual(parsed.deliveryDate, '2026-09-01');
});

run('parseInputSheet: 日本語見出しでも読める', () => {
  const parsed = sandbox.parseInputSheet([
    ['住所', '配送先名', '優先度'],
    ['東京都港区海岸1-7-1', '竹芝会場', '2'],
  ]);
  assert.strictEqual(parsed.destinations[0].name, '竹芝会場');
  assert.strictEqual(parsed.destinations[0].priority, 2);
});

run('parseInputSheet: 見出しが無いとエラー', () => {
  assert.throws(() => sandbox.parseInputSheet([['foo', 'bar']]), /見出し行が見つかりません/);
});

run('geocodeDestinations: 座標済みは呼ばず、同じ住所は1回だけ、失敗は記録', () => {
  fetchCount = 0;
  const result = sandbox.geocodeDestinations([
    { address: '東京都新宿区西新宿2-8-1', lat: 1, lng: 2 },
    { address: '東京都渋谷区神南1-19-8', lat: null, lng: null },
    { address: '東京都渋谷区神南1-19-8', lat: null, lng: null },
    { address: '存在しない住所テスト', lat: null, lng: null },
  ], 'test-key-not-real');
  assert.strictEqual(fetchCount, 2);
  assert.strictEqual(result.failed.join(','), '存在しない住所テスト');
  assert.strictEqual(result.destinations[2].lat, 35.6640);
  assert.strictEqual(result.remaining, 0);
});

run('buildRoute: 優先度が先、次に近い順。時間帯が空でも壊れない', () => {
  const origin = { lat: 35.6812, lng: 139.7671 };
  const route = sandbox.buildRoute(origin, [
    { id: 'A', name: 'A', address: 'a', priority: 2, lat: 35.6640, lng: 139.6990, service_minutes: 0 },
    { id: 'B', name: 'B', address: 'b', priority: 1, lat: 35.6300, lng: 139.7950, service_minutes: 0 },
  ]);
  assert.strictEqual(route[0][1], 'B');
  assert.strictEqual(route[0][4], '');
  assert.ok(route[1][8] > route[0][8]);
});

run('createRouteFromInputSheet: 配送日タブに出力し、2回目は連番になる', () => {
  const input = makeSheet('配送先入力', [
    ['配送日', '2026-08-15'],
    ['id', 'name', 'address', 'priority'],
    ['', '', '東京都江東区有明3-11-1', '1'],
    ['', '渋谷会場', '東京都渋谷区神南1-19-8', '2'],
    ['', '', '存在しない住所テスト', '2'],
  ]);
  const sheets = [input];
  spreadsheet = {
    getSheetByName: (n) => sheets.find(s => s.getName() === n) || null,
    getSheets: () => sheets,
    insertSheet: (n) => { const s = makeSheet(n, []); sheets.push(s); return s; },
    setActiveSheet: () => {},
    toast: (msg) => { sheetValues.toast = msg; },
  };

  sandbox.createRouteFromInputSheet();
  assert.strictEqual(sheets[1].getName(), '2026-08-15_配送ルート');
  const written = sheets[1].data;
  assert.strictEqual(written[0][0], 'ルート名');
  assert.strictEqual(written[1][1], '会社センター');
  assert.strictEqual(written[7][0], '配送順');
  assert.strictEqual(written[8][0], 1);
  assert.strictEqual(written.length, 10);  // メタ6 + 空行 + ヘッダー + 明細2
  assert.ok(sheetValues.toast.includes('座標を取れなかった住所が 1件'));

  // 座標が書き戻され、2回目はAPIを呼ばない
  assert.strictEqual(input.data[2][4], 35.6300);
  fetchCount = 0;
  sandbox.createRouteFromInputSheet();
  assert.strictEqual(sheets[2].getName(), '2026-08-15_配送ルート_2');
  assert.strictEqual(fetchCount, 2);  // 起点 + 失敗住所の再試行のみ
});

run('createRouteFromInputSheet: 配送日が無いと分かるエラー', () => {
  const input = makeSheet('配送先入力', [
    ['address'],
    ['東京都港区海岸1-7-1'],
  ]);
  spreadsheet = {
    getSheetByName: () => input,
    getSheets: () => [input],
    insertSheet: (n) => makeSheet(n, []),
    setActiveSheet: () => {},
    toast: () => {},
  };
  assert.throws(() => sandbox.createRouteFromInputSheet(), /配送日が分かりません/);
});

run('createRouteFromInputSheet: 入力シートが無いと分かるエラー', () => {
  spreadsheet = { getSheetByName: () => null, getSheets: () => [] };
  assert.throws(() => sandbox.createRouteFromInputSheet(), /配送先入力.*見つかりません/);
});
