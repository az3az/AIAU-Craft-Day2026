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
  writeRoute(spreadsheet, route);
}

// 段階2: Supabaseの latest_route_stops ビューを読んで、ルート結果シートに書く。
// ルート計算は手元の src/save_route_to_supabase.py 側で済ませておく。
// キーは anon キーを使う (service_role はここには置かない)。
function importRouteFromSupabase() {
  const config = getSupabaseConfig();
  const stops = fetchLatestRouteStops(config);

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

  writeRoute(SpreadsheetApp.getActiveSpreadsheet(), route);
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

function fetchLatestRouteStops(config) {
  const endpoint = config.url + '/rest/v1/latest_route_stops?select=*&order=stop_no.asc';
  const response = UrlFetchApp.fetch(endpoint, {
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

function writeRoute(spreadsheet, route) {
  let outputSheet = spreadsheet.getSheetByName(ROUTE_SHEET_NAME);

  if (!outputSheet) {
    outputSheet = spreadsheet.insertSheet(ROUTE_SHEET_NAME);
  }

  outputSheet.clear();
  outputSheet.getRange(1, 1, 1, ROUTE_HEADERS.length).setValues([ROUTE_HEADERS]);

  if (route.length > 0) {
    outputSheet.getRange(2, 1, route.length, ROUTE_HEADERS.length).setValues(route);
  }

  outputSheet.autoResizeColumns(1, ROUTE_HEADERS.length);
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
