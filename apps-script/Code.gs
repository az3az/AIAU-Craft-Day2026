// ルート結果シートの列順。シート内計算 (段階1) と Supabase読み取り (段階2) で共通。
const ROUTE_SHEET_NAME = 'ルート結果';
const ROUTE_HEADERS = [
  '配送順',
  'ID',
  '配送先名',
  '住所',
  '希望時間',
  '作業分数',
  '優先度',
  '区間距離km',
  '累計距離km',
];

// 明細列の書式。ROUTE_HEADERS と同じ並び。
// wrap = 折り返し表示にする列 (住所や名称が潰れないように)。
const ROUTE_COLUMN_FORMATS = [
  { width: 60, align: 'right', wrap: false },   // 配送順
  { width: 120, align: 'left', wrap: false },   // ID
  { width: 200, align: 'left', wrap: true },    // 配送先名
  { width: 320, align: 'left', wrap: true },    // 住所
  { width: 100, align: 'center', wrap: false }, // 希望時間
  { width: 80, align: 'right', wrap: false },   // 作業分数
  { width: 70, align: 'right', wrap: false },   // 優先度
  { width: 100, align: 'right', wrap: false },  // 区間距離km
  { width: 100, align: 'right', wrap: false },  // 累計距離km
];

const META_BACKGROUND = '#eef3fb';
const HEADER_BACKGROUND = '#d9e2f3';
const META_ROW_HEIGHT = 26;
const DETAIL_ROW_HEIGHT = 30;

// ルート結果シート上部に出すメタ情報の行。[見出し, latest_route_summary のキー]
const SUMMARY_ROWS = [
  ['ルート名', 'run_label'],
  ['起点', 'start_name'],
  ['起点住所', 'start_address'],
  ['合計距離km', 'total_distance_km'],
  ['作成日時', 'created_at'],
  ['配送先件数', 'stop_count'],
];

function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('配送ルート')
    .addItem('シートからルート作成 (段階1)', 'optimizeRoute')
    .addItem('Supabaseから取得 (段階2)', 'importRouteFromSupabase')
    .addToUi();
}

// 段階1: 配送先シートを読んで、シート内でルートを作る。Supabaseは使わない。
function optimizeRoute() {
  const spreadsheet = SpreadsheetApp.getActiveSpreadsheet();
  const sourceSheet = spreadsheet.getSheetByName('配送先');

  if (!sourceSheet) {
    throw new Error('配送先シートが見つかりません。');
  }

  const values = sourceSheet.getDataRange().getValues();
  const headers = values[0];
  const rows = values.slice(1).filter(row => row.join('') !== '');
  const destinations = rows.map(rowToDestination(headers));

  const startPoint = {
    id: 'START',
    name: '出発地点',
    address: '東京駅',
    lat: 35.681236,
    lng: 139.767125,
  };

  const route = buildRoute(startPoint, destinations);
  writeRoute(spreadsheet, route, null);
}

// 段階2: Supabaseの latest_route_summary / latest_route_stops ビューを読んで、
// ルート結果シートに「上部=メタ情報 / 下部=明細」の形で書く。
// ルート計算は手元の src/save_route_to_supabase.py 側で済ませておく。
// キーは anon キーを使う (service_role はここには置かない)。
function importRouteFromSupabase() {
  const config = getSupabaseConfig();
  const latest = fetchLatestRoute(config);
  const summary = latest.summary;
  const stops = latest.stops;

  if (stops.length === 0) {
    throw new Error(
      'Supabaseに完了済みのルートがありません。'
      + ' 先に src/save_route_to_supabase.py を実行してください。'
    );
  }

  const route = stops.map(function(stop) {
    return [
      stop.stop_no,
      stop.external_id,
      stop.name,
      stop.address,
      stop.time_window,
      stop.service_minutes,
      stop.priority,
      Number(stop.leg_distance_km),
      Number(stop.total_distance_km),
    ];
  });

  writeRoute(SpreadsheetApp.getActiveSpreadsheet(), route, summary);
}

function getSupabaseConfig() {
  const props = PropertiesService.getScriptProperties();
  const url = props.getProperty('SUPABASE_URL');
  const anonKey = props.getProperty('SUPABASE_ANON_KEY');

  if (!url || !anonKey) {
    throw new Error(
      'スクリプトプロパティに SUPABASE_URL と SUPABASE_ANON_KEY を設定してください。'
    );
  }

  return { url: url.replace(/\/+$/, ''), anonKey: anonKey };
}

// メタ情報と明細は別リクエストなので、その間に新しい run が保存されると
// 食い違うことがある。route_run_id が揃うまで数回だけ読み直す。
function fetchLatestRoute(config) {
  let summary = null;
  let stops = [];

  for (let attempt = 0; attempt < 3; attempt++) {
    summary = fetchLatestRouteSummary(config);
    stops = fetchLatestRouteStops(config);

    if (!summary || stops.length === 0) {
      return { summary: summary, stops: stops };
    }

    if (stops[0].route_run_id === summary.route_run_id) {
      return { summary: summary, stops: stops };
    }
  }

  // 揃わないときはメタ情報を捨て、明細だけを確実に表示する。
  return { summary: null, stops: stops };
}

function fetchLatestRouteStops(config) {
  return fetchView(config, 'latest_route_stops?select=*&order=stop_no.asc');
}

// 明細と同じ run のメタ情報。1行しか無いビューなので先頭を返す。
function fetchLatestRouteSummary(config) {
  const rows = fetchView(config, 'latest_route_summary?select=*&limit=1');
  return rows.length > 0 ? rows[0] : null;
}

function fetchView(config, path) {
  const response = UrlFetchApp.fetch(config.url + '/rest/v1/' + path, {
    method: 'get',
    muteHttpExceptions: true,
    headers: {
      apikey: config.anonKey,
      Authorization: 'Bearer ' + config.anonKey,
    },
  });

  const status = response.getResponseCode();
  if (status !== 200) {
    throw new Error(
      'Supabaseの読み取りに失敗しました (' + status + '): ' + response.getContentText()
    );
  }

  return JSON.parse(response.getContentText());
}

function rowToDestination(headers) {
  return function(row) {
    const item = {};
    headers.forEach(function(header, index) {
      item[header] = row[index];
    });
    item.lat = Number(item.lat);
    item.lng = Number(item.lng);
    item.priority = Number(item.priority || 9);
    return item;
  };
}

function buildRoute(startPoint, destinations) {
  const remaining = destinations.slice();
  let current = startPoint;
  let totalDistance = 0;
  const route = [];

  while (remaining.length > 0) {
    let bestIndex = 0;
    let bestScore = Number.POSITIVE_INFINITY;

    remaining.forEach(function(stop, index) {
      const score = stop.priority * 1000 + distanceKm(current, stop);
      if (score < bestScore) {
        bestScore = score;
        bestIndex = index;
      }
    });

    const nextStop = remaining.splice(bestIndex, 1)[0];
    const legDistance = distanceKm(current, nextStop);
    totalDistance += legDistance;

    route.push([
      route.length + 1,
      nextStop.id,
      nextStop.name,
      nextStop.address,
      nextStop.time_window_start + '-' + nextStop.time_window_end,
      nextStop.service_minutes,
      nextStop.priority,
      round2(legDistance),
      round2(totalDistance),
    ]);

    current = nextStop;
  }

  return route;
}

// summary があれば上部にメタ情報を出し、空行をはさんで明細を出す。
// 段階1 (optimizeRoute) は summary = null で呼ぶので従来どおり明細だけ。
function writeRoute(spreadsheet, route, summary) {
  let outputSheet = spreadsheet.getSheetByName(ROUTE_SHEET_NAME);

  if (!outputSheet) {
    outputSheet = spreadsheet.insertSheet(ROUTE_SHEET_NAME);
  }

  outputSheet.clear();
  outputSheet.setFrozenRows(0);

  let headerRow = 1;

  if (summary) {
    const metaValues = SUMMARY_ROWS.map(function(entry) {
      return [entry[0], formatSummaryValue(entry[1], summary[entry[1]])];
    });

    const metaRange = outputSheet.getRange(1, 1, metaValues.length, 2);
    metaRange.setValues(metaValues);
    metaRange.setBackground(META_BACKGROUND);
    metaRange.setVerticalAlignment('middle');
    outputSheet.getRange(1, 1, metaValues.length, 1).setFontWeight('bold');
    // 起点住所などが長くても読めるように、値側だけ折り返す。
    outputSheet.getRange(1, 2, metaValues.length, 1).setWrap(true);
    outputSheet.setRowHeights(1, metaValues.length, META_ROW_HEIGHT);

    headerRow = metaValues.length + 2;  // メタ情報の下に空行を1行はさむ
  }

  const headerRange = outputSheet.getRange(headerRow, 1, 1, ROUTE_HEADERS.length);
  headerRange.setValues([ROUTE_HEADERS]);
  headerRange.setFontWeight('bold');
  headerRange.setBackground(HEADER_BACKGROUND);
  headerRange.setHorizontalAlignment('center');
  headerRange.setVerticalAlignment('middle');
  headerRange.setWrap(true);
  outputSheet.setRowHeight(headerRow, DETAIL_ROW_HEIGHT);

  if (route.length > 0) {
    outputSheet
      .getRange(headerRow + 1, 1, route.length, ROUTE_HEADERS.length)
      .setValues(route);
    outputSheet.setRowHeights(headerRow + 1, route.length, DETAIL_ROW_HEIGHT);
    applyDetailColumnFormats(outputSheet, headerRow + 1, route.length);
  }

  // 明細をスクロールしてもヘッダーが見えるようにする。
  outputSheet.setFrozenRows(headerRow);
  applyColumnWidths(outputSheet);
}

function applyColumnWidths(sheet) {
  ROUTE_COLUMN_FORMATS.forEach(function(format, index) {
    sheet.setColumnWidth(index + 1, format.width);
  });
}

function applyDetailColumnFormats(sheet, firstRow, rowCount) {
  ROUTE_COLUMN_FORMATS.forEach(function(format, index) {
    const range = sheet.getRange(firstRow, index + 1, rowCount, 1);
    range.setHorizontalAlignment(format.align);
    range.setVerticalAlignment('middle');
    range.setWrap(format.wrap);
  });
}

function formatSummaryValue(key, value) {
  if (value === null || value === undefined || value === '') {
    return '(未設定)';
  }

  if (key === 'total_distance_km' || key === 'stop_count') {
    return Number(value);
  }

  if (key === 'created_at') {
    return Utilities.formatDate(
      new Date(value),
      Session.getScriptTimeZone(),
      'yyyy-MM-dd HH:mm'
    );
  }

  return value;
}

function distanceKm(a, b) {
  const radiusKm = 6371;
  const lat1 = toRadians(Number(a.lat));
  const lon1 = toRadians(Number(a.lng));
  const lat2 = toRadians(Number(b.lat));
  const lon2 = toRadians(Number(b.lng));
  const dlat = lat2 - lat1;
  const dlon = lon2 - lon1;

  const haversine =
    Math.sin(dlat / 2) * Math.sin(dlat / 2) +
    Math.cos(lat1) * Math.cos(lat2) *
    Math.sin(dlon / 2) * Math.sin(dlon / 2);

  return radiusKm * 2 * Math.atan2(Math.sqrt(haversine), Math.sqrt(1 - haversine));
}

function toRadians(value) {
  return value * Math.PI / 180;
}

function round2(value) {
  return Math.round(value * 100) / 100;
}
