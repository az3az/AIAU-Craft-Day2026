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
    getDataRange: () => ({ getValues: () => data.map(r => (r || []).slice()) }),
    getLastColumn: () => Math.max(...data.map(r => (r || []).length)),
    insertRowsBefore(row, numRows) {
      for (let i = 0; i < numRows; i++) {
        data.splice(row - 1, 0, []);
      }
    },
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
      const bulk = address.match(/^東京都サンプル区(\d+)$/);
      const point = address === '東京都千代田区丸の内1-9-1'
        ? { lat: 35.6812, lng: 139.7671 }
        : bulk
          ? { lat: 35.6 + Number(bulk[1]) / 1000, lng: 139.7 + Number(bulk[1]) / 1000 }
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

function today() {
  return sandbox.Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyy-MM-dd');
}

function run(name, fn) {
  try { fn(); console.log('PASS ' + name); }
  catch (e) { console.log("FAIL " + name + ": " + (process.env.DEBUG ? e.stack : e.message)); process.exitCode = 1; }
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

run('createRouteFromInputSheet: 上限超えは座標だけ書き戻し、ルートは作らない', () => {
  const rows = [['配送日', '2026-08-15'], ['id', 'name', 'address', 'priority']];
  for (let i = 1; i <= 90; i++) {
    rows.push(['', '', '東京都サンプル区' + i, '5']);
  }
  const input = makeSheet('配送先入力', rows);
  const sheets = [input];
  spreadsheet = {
    getSheetByName: (n) => sheets.find(s => s.getName() === n) || null,
    getSheets: () => sheets,
    insertSheet: (n) => { const s = makeSheet(n, []); sheets.push(s); return s; },
    setActiveSheet: () => {},
    toast: (msg) => { sheetValues.toast = msg; },
  };

  assert.throws(() => sandbox.createRouteFromInputSheet(), /未処理の住所が 10件/);
  assert.strictEqual(sheets.length, 1);  // ルートシートは作られない
  assert.strictEqual(input.data[2][4], 35.601);  // 座標は書き戻されている
  assert.ok(!input.data[91][4]);                 // 上限を超えた行はまだ空

  // 残り10件を取り終えた2回目はルートができる
  fetchCount = 0;
  sandbox.createRouteFromInputSheet();
  assert.strictEqual(fetchCount, 11);  // 残り10件 + 起点
  assert.strictEqual(sheets[1].getName(), '2026-08-15_配送ルート');
  assert.strictEqual(sheets[1].data.length, 98);  // メタ6 + 空行 + ヘッダー + 明細90
});

run('createRouteFromInputSheet: 配送日が無ければ今日の日付を使って書き戻す', () => {
  const input = makeSheet('配送先入力', [
    ['address'],
    ['東京都港区海岸1-7-1'],
  ]);
  const created = [];
  spreadsheet = {
    getSheetByName: () => input,
    getSheets: () => [input],
    insertSheet: (n) => { const s = makeSheet(n, []); created.push(s); return s; },
    setActiveSheet: () => {},
    toast: (msg) => { sheetValues.toast = msg; },
  };

  sandbox.createRouteFromInputSheet();
  assert.strictEqual(created[0].getName(), today() + '_配送ルート');
  assert.strictEqual(input.data[0][0], '配送日');
  assert.strictEqual(input.data[0][1], today());
  assert.strictEqual(input.data[1][0], 'address');
  // 行が1つ下がっても座標は元の住所の行に書き戻される
  assert.strictEqual(input.data[2][0], '東京都港区海岸1-7-1');
  assert.strictEqual(input.data[1][2], 'lat');
  assert.strictEqual(input.data[2][2], 35.6560);
  assert.strictEqual(input.data[2][3], 139.7570);
  assert.ok(/今日/.test(sheetValues.toast));
});

run('createRouteFromInputSheet: 配送日ラベルがあれば右のセルに今日の日付を入れる', () => {
  const input = makeSheet('配送先入力', [
    ['配送日', ''],
    [],
    ['id', 'name', 'address', 'priority'],
    ['D01', '公共施設A', '東京都港区海岸1-7-1', '1'],
  ]);
  const created = [];
  spreadsheet = {
    getSheetByName: () => input,
    getSheets: () => [input],
    insertSheet: (n) => { const s = makeSheet(n, []); created.push(s); return s; },
    setActiveSheet: () => {},
    toast: () => {},
  };

  sandbox.createRouteFromInputSheet();
  assert.strictEqual(input.data[0][1], today());
  assert.strictEqual(created[0].getName(), today() + '_配送ルート');
  assert.strictEqual(input.data[3][2], '東京都港区海岸1-7-1');
});

run('createRouteFromInputSheet: delivery_date 列があれば今日の日付で上書きしない', () => {
  const input = makeSheet('配送先入力', [
    ['address', 'delivery_date'],
    ['東京都港区海岸1-7-1', '2026-08-15'],
  ]);
  const created = [];
  spreadsheet = {
    getSheetByName: () => input,
    getSheets: () => [input],
    insertSheet: (n) => { const s = makeSheet(n, []); created.push(s); return s; },
    setActiveSheet: () => {},
    toast: () => {},
  };

  sandbox.createRouteFromInputSheet();
  assert.strictEqual(created[0].getName(), '2026-08-15_配送ルート');
  assert.strictEqual(input.data[0][0], 'address');
  assert.strictEqual(input.data.length, 2);
});

run('createRouteFromInputSheet: 入力シートが無いと分かるエラー', () => {
  spreadsheet = { getSheetByName: () => null, getSheets: () => [] };
  assert.throws(() => sandbox.createRouteFromInputSheet(), /配送先入力.*見つかりません/);
});

run('createInputTemplateSheet: 空のテンプレートを作り、そのままルート作成に使える', () => {
  const sheets = [];
  spreadsheet = {
    getSheetByName: (n) => sheets.find(s => s.getName() === n) || null,
    getSheets: () => sheets,
    insertSheet: (n) => { const s = makeSheet(n, []); sheets.push(s); return s; },
    setActiveSheet: () => {},
    toast: (msg) => { sheetValues.toast = msg; },
  };

  const template = sandbox.createInputTemplateSheet();
  assert.strictEqual(template.getName(), '配送先入力');
  assert.strictEqual(template.data[0][0], '配送日');
  assert.strictEqual(template.data[2].join(','), 'id,name,address,priority,lat,lng');

  // 見出しの位置は parseInputSheet が読める形になっている
  template.data[0][1] = '2026-08-15';
  template.data[3] = ['', '', '東京都江東区有明3-11-1', '1'];
  const parsed = sandbox.parseInputSheet(Array.from(template.data, r => (r || []).slice()));
  assert.strictEqual(parsed.deliveryDate, '2026-08-15');
  assert.strictEqual(parsed.destinations.length, 1);
  assert.strictEqual(parsed.columns.lat, 4);
});

run('createInputTemplateSheet: 空のときは B1 に今日の日付を入れる', () => {
  const sheets = [];
  spreadsheet = {
    getSheetByName: (n) => sheets.find(s => s.getName() === n) || null,
    getSheets: () => sheets,
    insertSheet: (n) => { const s = makeSheet(n, []); sheets.push(s); return s; },
    setActiveSheet: () => {},
    toast: () => {},
  };

  const template = sandbox.createInputTemplateSheet();
  assert.strictEqual(template.data[0][1], today());
  assert.strictEqual(sandbox.normalizeDate(template.data[0][1]), today());
});

function templateSpreadsheet(input) {
  const sheets = [input];
  spreadsheet = {
    getSheetByName: (n) => sheets.find(s => s.getName() === n) || null,
    getSheets: () => sheets,
    insertSheet: (n) => { const s = makeSheet(n, []); sheets.push(s); return s; },
    setActiveSheet: () => {},
    toast: (msg) => { sheetValues.toast = msg; },
  };
  return sheets;
}

run('createInputTemplateSheet: 配送日も見出しも揃っていれば何も変えない', () => {
  const input = makeSheet('配送先入力', [
    ['配送日', '2026-08-15'],
    [],
    ['id', 'name', 'address', 'priority'],
    ['D01', '公共施設A', '東京都江東区有明3-11-1', '1'],
  ]);
  const sheets = templateSpreadsheet(input);

  sandbox.createInputTemplateSheet();
  assert.strictEqual(input.data.length, 4);
  assert.strictEqual(input.data[0][1], '2026-08-15');
  assert.strictEqual(input.data[3][2], '東京都江東区有明3-11-1');
  assert.strictEqual(sheets.length, 1);
  assert.ok(/変えていません/.test(sheetValues.toast));
});

run('createInputTemplateSheet: 配送日セルが空なら今日の日付だけ補う', () => {
  const input = makeSheet('配送先入力', [
    ['配送日', ''],
    [],
    ['id', 'name', 'address', 'priority'],
    ['D01', '公共施設A', '東京都江東区有明3-11-1', '1'],
  ]);
  templateSpreadsheet(input);

  sandbox.createInputTemplateSheet();
  assert.strictEqual(input.data[0][1], today());
  assert.strictEqual(input.data.length, 4);
  assert.strictEqual(input.data[3][2], '東京都江東区有明3-11-1');
});

run('createInputTemplateSheet: 配送日ラベルが無いときは行を足して既存行を残す', () => {
  const input = makeSheet('配送先入力', [
    ['id', 'name', 'address', 'priority'],
    ['D01', '公共施設A', '東京都江東区有明3-11-1', '1'],
  ]);
  templateSpreadsheet(input);

  sandbox.createInputTemplateSheet();
  assert.strictEqual(input.data[0][0], '配送日');
  assert.strictEqual(input.data[0][1], today());
  assert.strictEqual(input.data[1].join(','), 'id,name,address,priority');
  assert.strictEqual(input.data[2][2], '東京都江東区有明3-11-1');

  const parsed = sandbox.parseInputSheet(Array.from(input.data, r => (r || []).slice()));
  assert.strictEqual(parsed.deliveryDate, today());
  assert.strictEqual(parsed.destinations.length, 1);
});

run('createInputTemplateSheet: 見出し行が無いときは見出しを補い、データを消さない', () => {
  const input = makeSheet('配送先入力', [
    ['D01', '公共施設A', '東京都江東区有明3-11-1', '1'],
    ['D02', '公共施設B', '東京都渋谷区神南1-19-8', '2'],
  ]);
  templateSpreadsheet(input);

  sandbox.createInputTemplateSheet();
  assert.strictEqual(input.data[0][0], '配送日');
  assert.strictEqual(input.data[1].join(','), 'id,name,address,priority,lat,lng');
  assert.strictEqual(input.data[2][2], '東京都江東区有明3-11-1');
  assert.strictEqual(input.data[3][2], '東京都渋谷区神南1-19-8');

  const parsed = sandbox.parseInputSheet(Array.from(input.data, r => (r || []).slice()));
  assert.strictEqual(parsed.deliveryDate, today());
  assert.strictEqual(parsed.destinations.length, 2);
});

run('createInputTemplateSheet: 見出しを足すとき既存の配送日セルを残す', () => {
  const input = makeSheet('配送先入力', [
    ['配送日', '2026-08-15'],
    ['D01', '公共施設A', '東京都江東区有明3-11-1', '1'],
  ]);
  templateSpreadsheet(input);

  sandbox.createInputTemplateSheet();
  assert.strictEqual(input.data[0][1], '2026-08-15');
  assert.strictEqual(input.data[1].join(','), 'id,name,address,priority,lat,lng');
  assert.strictEqual(input.data[2][2], '東京都江東区有明3-11-1');

  const parsed = sandbox.parseInputSheet(Array.from(input.data, r => (r || []).slice()));
  assert.strictEqual(parsed.deliveryDate, '2026-08-15');
});

run('createInputTemplateSheet: delivery_date 列で指定していれば配送日セルを足さない', () => {
  const input = makeSheet('配送先入力', [
    ['id', 'name', 'address', 'priority', 'delivery_date'],
    ['D01', '公共施設A', '東京都江東区有明3-11-1', '1', '2026-08-15'],
  ]);
  templateSpreadsheet(input);

  sandbox.createInputTemplateSheet();
  assert.strictEqual(input.data.length, 2);
  assert.strictEqual(input.data[0][0], 'id');

  const parsed = sandbox.parseInputSheet(Array.from(input.data, r => (r || []).slice()));
  assert.strictEqual(parsed.deliveryDate, '2026-08-15');
});
