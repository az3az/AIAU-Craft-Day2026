---
name: testing-geocode-route
description: How to test the AIAU-Craft-Day2026 CLI batch scripts (route optimizer, geocoding, Supabase save) locally without API keys.
---

# ローカル検証の手引き (AIAU-Craft-Day2026)

Python 3 の CLI/バッチのみ。UI は無いので検証はすべてシェルで行う。GUI ターミナル
(xterm/gnome-terminal) はこの環境には入っていないため、画面録画は基本不要。

## 依存

`pip install -r requirements.txt` で足りる。静的チェックは `python3 -m pyflakes src/*.py`。

## キー無しで動かす方法

- ジオコーディング: `--provider nominatim`（または `GEOCODER=nominatim`）で
  OpenStreetMap Nominatim を使う。APIキー不要。**1秒1リクエスト**のスロットルが
  `src/geocoder.py` に入っているので、10件で 20 秒程度かかる（街区番号→丁目の
  フォールバックで住所1件あたり最大2回呼ぶ）。exec のタイムアウトを長めに。
- Supabase を叩くコマンドは `--dry-run --source csv` ならキー不要でネットワークも使わない。
  `--source supabase` や dry-run なしは `SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY` が必要。

## キャッシュを壊さない

`data/geocode_cache.json` は既定のキャッシュ先。`geocode_destinations.py` は `--cache` で
差し替えられるが、**`save_route_to_supabase.py` / `route_optimizer.py` の
`ensure_coordinates()` と起点ジオコーディングは既定パス固定**なので、
テスト前に `cp data/geocode_cache.json /tmp/backup.json` を取り、終わったら戻す。

## ネットワーク未使用の証明

`https_proxy=http://127.0.0.1:9 http_proxy=http://127.0.0.1:9` を設定して実行すると、
外向き通信をするコードだけが `ジオコーディングに接続できません: [Errno 111]` で落ちる。
既存 CSV パス（座標入り）はこの状態でも成功するので「APIを呼んでいない」証拠になる。

## 起点 (--origin) の検証観点

`tokyo_station`（既定, 35.681236/139.767125, 表示名は「出発地点」）/ `center`
(`ROUTE_ORIGIN_LAT`+`ROUTE_ORIGIN_LNG` 優先、無ければ `ROUTE_ORIGIN_ADDRESS` を
ジオコーディング、名前は `ROUTE_ORIGIN_NAME` 既定「センター」) / 任意住所。
`--dry-run` の JSON は末尾に日本語のサマリ行が付くので、JSON パース時は
最後の `}` までで切ること。起点が効いているかは `start_*` だけでなく
`total_distance_km` と最初の stop の並びが変わることまで確認する。

## 既知の粗さ（テスト時に踏みやすい）

- ヘッダより列数の多い CSV 行 → `AttributeError: 'list' object has no attribute 'strip'` のトレースバック。
- 壊れた JSON キャッシュ / 文字コード違いの CSV → `json.JSONDecodeError` / `UnicodeDecodeError` のトレースバック。
- Ctrl-C 中断時はキャッシュは保存されるが KeyboardInterrupt のトレースバックが出る。

## Devin Secrets Needed

- `GOOGLE_MAPS_API_KEY`（google プロバイダの検証に必要。無い場合は nominatim のみ検証可）
- `SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY`（実書き込み経路の検証に必要）
