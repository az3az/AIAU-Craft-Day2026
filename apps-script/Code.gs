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

// Sheets完結版 (段階3) で使う入力シートと出力シート名。
const INPUT_SHEET_NAME = '配送先入力';
const OUTPUT_SHEET_SUFFIX = '_配送ルート';
const DELIVERY_DATE_LABEL = '配送日';

// 入力シートの見出し。英語列名と日本語列名のどちらでも貼れるようにする。
const INPUT_HEADER_ALIASES = {
  'id': 'id',
  'ID': 'id',
  'name': 'name',
  '配送先名': 'name',
  '名前': 'name',
  'address': 'address',
  '住所': 'address',
  'priority': 'priority',
  '優先度': 'priority',
  'lat': 'lat',
  '緯度': 'lat',
  'lng': 'lng',
  '経度': 'lng',
  'time_window_start': 'time_window_start',
  '希望開始': 'time_window_start',
  'time_window_end': 'time_window_end',
  '希望終了': 'time_window_end',
  'service_minutes': 'service_minutes',
  '作業分数': 'service_minutes',
  'delivery_date': 'delivery_date',
  '配送日': 'delivery_date',
};

// 「配送先入力テンプレートを作成」で作る見出し。docs/input_template.md と揃える。
const INPUT_TEMPLATE_HEADERS = ['id', 'name', 'address', 'priority', 'lat', 'lng'];
const INPUT_TEMPLATE_HEADER_ROW = 3;
const INPUT_TEMPLATE_COLUMN_WIDTHS = [120, 200, 320, 70, 110, 110];

// 1回の実行は6分で打ち切られるので、ジオコーディング件数に上限を置く。
const GEOCODE_LIMIT_PER_RUN = 80;
const GEOCODE_ENDPOINT = 'https://maps.googleapis.com/maps/api/geocode/json';

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
    .addItem('配送ルート作成 (配送先入力シートから)', 'createRouteFromInputSheet')
    .addItem('配送先入力テンプレートを作成', 'createInputTemplateSheet')
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

// 段階3: 「配送先入力」シートの住所を Google Geocoding API で座標にし、
// 会社センターを起点に配送順を作って、配送日ごとのシートタブに書き出す。
// ターミナルを使わず Sheets だけで完結する経路。Supabase には書かない。
function createRouteFromInputSheet() {
  const spreadsheet = SpreadsheetApp.getActiveSpreadsheet();
  const inputSheet = spreadsheet.getSheetByName(INPUT_SHEET_NAME);

  if (!inputSheet) {
    throw new Error(
      '「' + INPUT_SHEET_NAME + '」シートが見つかりません。'
      + ' シート名を「' + INPUT_SHEET_NAME + '」にして、配送先CSVを貼り付けてください。'
    );
  }

  const parsed = parseInputSheet(inputSheet.getDataRange().getValues());

  if (parsed.destinations.length === 0) {
    throw new Error(
      '住所が入った行がありません。「' + INPUT_SHEET_NAME + '」シートの address (住所) 列を確認してください。'
    );
  }

  if (!parsed.deliveryDate) {
    throw new Error(
      '配送日が分かりません。「' + INPUT_SHEET_NAME + '」シートに「' + DELIVERY_DATE_LABEL
      + '」と書いたセルとその右に日付を入れるか、delivery_date 列を作ってください (例: 2026-08-15)。'
    );
  }

  const apiKey = getGeocodingApiKey();
  const geocoded = geocodeDestinations(parsed.destinations, apiKey);

  writeBackCoordinates(inputSheet, parsed, geocoded.destinations);

  // 上限で打ち切った回は座標だけ残し、途中までのルートシートは作らない。
  if (geocoded.remaining > 0) {
    throw new Error(
      '1回で座標にできるのは ' + GEOCODE_LIMIT_PER_RUN + '件までです。'
      + ' 未処理の住所が ' + geocoded.remaining + '件残っているため、ルートは作っていません。'
      + ' 取得できた座標は「' + INPUT_SHEET_NAME + '」シートに書き込んだので、'
      + ' もう一度「配送ルート作成」を実行してください (全件の座標が揃うとルートを作ります)。'
    );
  }

  const usable = geocoded.destinations.filter(hasCoordinates);

  if (usable.length === 0) {
    throw new Error(
      '座標を取得できた配送先がありません。住所の表記を見直してください。'
      + ' (取得できなかった住所: ' + geocoded.failed.length + '件)'
    );
  }

  const origin = resolveOrigin(apiKey);
  const route = buildRoute(origin, usable);
  const existingNames = spreadsheet.getSheets().map(function(sheet) {
    return sheet.getName();
  });
  const sheetName = uniqueSheetName(existingNames, parsed.deliveryDate + OUTPUT_SHEET_SUFFIX);
  const outputSheet = spreadsheet.insertSheet(sheetName);

  writeRouteToSheet(outputSheet, route, {
    run_label: parsed.deliveryDate + ' 配送ルート',
    start_name: origin.name,
    start_address: origin.address,
    total_distance_km: route.length > 0 ? route[route.length - 1][8] : 0,
    created_at: new Date().toISOString(),
    stop_count: route.length,
  });

  spreadsheet.setActiveSheet(outputSheet);
  spreadsheet.toast(resultMessage(sheetName, geocoded, usable.length), '配送ルート作成', 15);
}

// 空の「配送先入力」シートを見出し付きで用意する。
// 既にデータが入っている場合は上書きせずに止める。
function createInputTemplateSheet() {
  const spreadsheet = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = spreadsheet.getSheetByName(INPUT_SHEET_NAME);

  if (sheet && !isBlankSheet(sheet)) {
    throw new Error(
      '「' + INPUT_SHEET_NAME + '」シートに既にデータがあるため、テンプレートを作りませんでした。'
      + ' 中身を消すか、シート名を変えてからもう一度実行してください。'
    );
  }

  if (!sheet) {
    sheet = spreadsheet.insertSheet(INPUT_SHEET_NAME);
  }

  sheet.getRange(1, 1).setValue(DELIVERY_DATE_LABEL);
  sheet.getRange(1, 2).setValue('');
  sheet.getRange(INPUT_TEMPLATE_HEADER_ROW, 1, 1, INPUT_TEMPLATE_HEADERS.length)
    .setValues([INPUT_TEMPLATE_HEADERS]);

  formatInputTemplate(sheet);
  spreadsheet.setActiveSheet(sheet);
  spreadsheet.toast(
    '「' + INPUT_SHEET_NAME + '」を用意しました。B1 に配送日 (例: 2026-08-15) を入れ、'
    + INPUT_TEMPLATE_HEADER_ROW + '行目の見出しの下に配送先を貼り付けてください。',
    '配送先入力テンプレート', 15);

  return sheet;
}

function isBlankSheet(sheet) {
  return sheet.getDataRange().getValues().every(function(row) {
    return row.every(function(cell) {
      return cell === '' || cell === null || cell === undefined;
    });
  });
}

function formatInputTemplate(sheet) {
  const headerRange = sheet.getRange(INPUT_TEMPLATE_HEADER_ROW, 1, 1, INPUT_TEMPLATE_HEADERS.length);
  headerRange.setFontWeight('bold');
  headerRange.setBackground(HEADER_BACKGROUND);
  headerRange.setHorizontalAlignment('center');

  const labelRange = sheet.getRange(1, 1, 1, 2);
  labelRange.setBackground(META_BACKGROUND);
  sheet.getRange(1, 1).setFontWeight('bold');

  INPUT_TEMPLATE_COLUMN_WIDTHS.forEach(function(width, index) {
    sheet.setColumnWidth(index + 1, width);
  });

  sheet.setFrozenRows(INPUT_TEMPLATE_HEADER_ROW);
}

function resultMessage(sheetName, geocoded, stopCount) {
  const lines = ['「' + sheetName + '」に ' + stopCount + '件の配送順を作りました。'];

  if (geocoded.failed.length > 0) {
    lines.push('座標を取れなかった住所が ' + geocoded.failed.length + '件あります: '
      + geocoded.failed.slice(0, 3).join(' / '));
  }

  return lines.join('\n');
}

// 入力シートを見出し行と明細に分ける。見出しの上に「配送日」のセルがあってもよい。
function parseInputSheet(values) {
  const headerRowIndex = findHeaderRowIndex(values);

  if (headerRowIndex < 0) {
    throw new Error('見出し行が見つかりません。address (または 住所) を含む行を作ってください。');
  }

  const columns = {};
  values[headerRowIndex].forEach(function(header, index) {
    const key = INPUT_HEADER_ALIASES[String(header).trim()];
    if (key && columns[key] === undefined) {
      columns[key] = index;
    }
  });

  const destinations = [];
  let deliveryDate = findDeliveryDateCell(values, headerRowIndex);

  for (let row = headerRowIndex + 1; row < values.length; row++) {
    const address = cellText(values[row], columns.address);
    if (!address) {
      continue;
    }

    if (!deliveryDate) {
      deliveryDate = normalizeDate(cellValue(values[row], columns.delivery_date));
    }

    const id = cellText(values[row], columns.id);
    const name = cellText(values[row], columns.name);

    destinations.push({
      rowIndex: row,
      id: id || 'D' + padNumber(destinations.length + 1),
      name: name || address,
      address: address,
      priority: Number(cellText(values[row], columns.priority)) || 9,
      lat: toNumberOrNull(cellValue(values[row], columns.lat)),
      lng: toNumberOrNull(cellValue(values[row], columns.lng)),
      time_window_start: cellText(values[row], columns.time_window_start),
      time_window_end: cellText(values[row], columns.time_window_end),
      service_minutes: Number(cellText(values[row], columns.service_minutes)) || 0,
    });
  }

  return {
    columns: columns,
    headerRowIndex: headerRowIndex,
    destinations: destinations,
    deliveryDate: deliveryDate,
  };
}

function findHeaderRowIndex(values) {
  for (let row = 0; row < values.length; row++) {
    const hasAddress = values[row].some(function(cell) {
      return INPUT_HEADER_ALIASES[String(cell).trim()] === 'address';
    });
    if (hasAddress) {
      return row;
    }
  }
  return -1;
}

// 見出し行より上にある「配送日」ラベルの右隣のセルを探す。
function findDeliveryDateCell(values, headerRowIndex) {
  for (let row = 0; row < headerRowIndex; row++) {
    for (let col = 0; col < values[row].length - 1; col++) {
      if (String(values[row][col]).trim() === DELIVERY_DATE_LABEL) {
        const date = normalizeDate(values[row][col + 1]);
        if (date) {
          return date;
        }
      }
    }
  }
  return '';
}

// Date でも "2026-08-15" でも "2026/8/15" でも YYYY-MM-DD にそろえる。
function normalizeDate(value) {
  if (value === null || value === undefined || value === '') {
    return '';
  }

  if (Object.prototype.toString.call(value) === '[object Date]') {
    return Utilities.formatDate(value, Session.getScriptTimeZone(), 'yyyy-MM-dd');
  }

  const match = String(value).trim().match(/^(\d{4})[-\/](\d{1,2})[-\/](\d{1,2})$/);

  if (!match) {
    return '';
  }

  return match[1] + '-' + padNumber(Number(match[2])) + '-' + padNumber(Number(match[3]));
}

// 同じ日付のシートがあるときは上書きせず、_2 / _3 と連番を付ける。
function uniqueSheetName(existingNames, baseName) {
  if (existingNames.indexOf(baseName) < 0) {
    return baseName;
  }

  let suffix = 2;
  while (existingNames.indexOf(baseName + '_' + suffix) >= 0) {
    suffix++;
  }

  return baseName + '_' + suffix;
}

function getGeocodingApiKey() {
  const apiKey = PropertiesService.getScriptProperties().getProperty('GOOGLE_MAPS_API_KEY');

  if (!apiKey) {
    throw new Error(
      'スクリプトプロパティに GOOGLE_MAPS_API_KEY を設定してください。'
      + ' (拡張機能 > Apps Script > プロジェクトの設定 > スクリプト プロパティ)'
    );
  }

  return apiKey;
}

// 既に座標が入っている行はAPIを呼ばない。同じ住所も1回だけ問い合わせる。
function geocodeDestinations(destinations, apiKey) {
  const cache = {};
  const failed = [];
  let calls = 0;
  let remaining = 0;

  destinations.forEach(function(item) {
    if (hasCoordinates(item)) {
      cache[item.address] = { lat: item.lat, lng: item.lng };
    }
  });

  destinations.forEach(function(item) {
    if (hasCoordinates(item)) {
      return;
    }

    const cached = cache[item.address];
    if (cached) {
      item.lat = cached.lat;
      item.lng = cached.lng;
      return;
    }

    if (calls >= GEOCODE_LIMIT_PER_RUN) {
      remaining++;
      return;
    }

    calls++;
    const point = geocodeAddress(item.address, apiKey);

    if (point) {
      item.lat = point.lat;
      item.lng = point.lng;
      cache[item.address] = point;
    } else {
      failed.push(item.address);
    }
  });

  return { destinations: destinations, failed: failed, remaining: remaining };
}

function geocodeAddress(address, apiKey) {
  const url = GEOCODE_ENDPOINT
    + '?address=' + encodeURIComponent(address)
    + '&language=ja&region=jp&key=' + encodeURIComponent(apiKey);

  const response = UrlFetchApp.fetch(url, { method: 'get', muteHttpExceptions: true });
  const status = response.getResponseCode();

  if (status !== 200) {
    throw new Error(
      'ジオコーディングに失敗しました (' + status + ')。APIキーの設定を確認してください。'
    );
  }

  const body = JSON.parse(response.getContentText());

  if (body.status === 'OK' && body.results.length > 0) {
    const location = body.results[0].geometry.location;
    return { lat: location.lat, lng: location.lng };
  }

  // 住所が見つからないだけならその行を飛ばす。設定や割当の問題は実行を止める。
  if (body.status === 'ZERO_RESULTS') {
    return null;
  }

  throw new Error(
    'Google Geocoding API がエラーを返しました (' + body.status + ')。'
    + (body.error_message || '')
  );
}

// 取得した座標は入力シートに書き戻す。次回以降は同じ住所でAPIを呼ばない。
function writeBackCoordinates(inputSheet, parsed, destinations) {
  const latColumn = ensureColumn(inputSheet, parsed, 'lat');
  const lngColumn = ensureColumn(inputSheet, parsed, 'lng');

  destinations.forEach(function(item) {
    if (!hasCoordinates(item)) {
      return;
    }
    inputSheet.getRange(item.rowIndex + 1, latColumn + 1).setValue(item.lat);
    inputSheet.getRange(item.rowIndex + 1, lngColumn + 1).setValue(item.lng);
  });
}

function ensureColumn(inputSheet, parsed, key) {
  if (parsed.columns[key] !== undefined) {
    return parsed.columns[key];
  }

  const column = inputSheet.getLastColumn();
  inputSheet.getRange(parsed.headerRowIndex + 1, column + 1).setValue(key);
  parsed.columns[key] = column;
  return column;
}

// 起点はスクリプトプロパティで指定する。実住所をコードに書かないため。
function resolveOrigin(apiKey) {
  const props = PropertiesService.getScriptProperties();
  const name = props.getProperty('ROUTE_ORIGIN_NAME') || '会社センター';
  const address = props.getProperty('ROUTE_ORIGIN_ADDRESS');
  const lat = toNumberOrNull(props.getProperty('ROUTE_ORIGIN_LAT'));
  const lng = toNumberOrNull(props.getProperty('ROUTE_ORIGIN_LNG'));

  if (lat !== null && lng !== null) {
    return { id: 'START', name: name, address: address || '', lat: lat, lng: lng };
  }

  if (!address) {
    throw new Error(
      '起点が設定されていません。スクリプトプロパティに ROUTE_ORIGIN_ADDRESS'
      + ' (または ROUTE_ORIGIN_LAT と ROUTE_ORIGIN_LNG) を設定してください。'
    );
  }

  const point = geocodeAddress(address, apiKey);

  if (!point) {
    throw new Error('起点の住所を座標にできませんでした: ' + address);
  }

  return { id: 'START', name: name, address: address, lat: point.lat, lng: point.lng };
}

function hasCoordinates(item) {
  return typeof item.lat === 'number' && isFinite(item.lat)
    && typeof item.lng === 'number' && isFinite(item.lng);
}

function cellValue(row, index) {
  return index === undefined ? '' : row[index];
}

function cellText(row, index) {
  const value = cellValue(row, index);
  return value === null || value === undefined ? '' : String(value).trim();
}

function toNumberOrNull(value) {
  if (value === null || value === undefined || String(value).trim() === '') {
    return null;
  }

  const number = Number(value);
  return isFinite(number) ? number : null;
}

function padNumber(value) {
  return value < 10 ? '0' + value : String(value);
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
      formatTimeWindow(nextStop),
      nextStop.service_minutes,
      nextStop.priority,
      round2(legDistance),
      round2(totalDistance),
    ]);

    current = nextStop;
  }

  return route;
}

function formatTimeWindow(stop) {
  const start = stop.time_window_start || '';
  const end = stop.time_window_end || '';

  if (!start && !end) {
    return '';
  }

  return start + '-' + end;
}

// summary があれば上部にメタ情報を出し、空行をはさんで明細を出す。
// 段階1 (optimizeRoute) は summary = null で呼ぶので従来どおり明細だけ。
function writeRoute(spreadsheet, route, summary) {
  let outputSheet = spreadsheet.getSheetByName(ROUTE_SHEET_NAME);

  if (!outputSheet) {
    outputSheet = spreadsheet.insertSheet(ROUTE_SHEET_NAME);
  }

  writeRouteToSheet(outputSheet, route, summary);
}

// 書き出し先のシートを呼び出し側が決められるようにする。
// 段階1/2 は「ルート結果」、段階3 は配送日ごとのシート。
function writeRouteToSheet(outputSheet, route, summary) {
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
