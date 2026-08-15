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
  const sheetName = 'ルート結果';
  let outputSheet = spreadsheet.getSheetByName(sheetName);

  if (!outputSheet) {
    outputSheet = spreadsheet.insertSheet(sheetName);
  }

  outputSheet.clear();
  outputSheet.getRange(1, 1, 1, 9).setValues([[
    '配送順',
    'ID',
    '配送先名',
    '住所',
    '希望時間',
    '作業分数',
    '優先度',
    '区間距離km',
    '累計距離km',
  ]]);

  if (route.length > 0) {
    outputSheet.getRange(2, 1, route.length, 9).setValues(route);
  }

  outputSheet.autoResizeColumns(1, 9);
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
