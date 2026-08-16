# AIAU Craft Day 2026 - 配送ルート作成

## 提出用サマリー

ランダムに並んだ配送先住所CSVから、Google Geocoding APIで緯度経度を取得し、会社センターを起点に配送順を作成する配送ルート支援ツールです。

現在の配送ルート作成は人手に依存しやすく、住所確認、順番決め、結果共有に手間がかかります。このプロジェクトでは、住所CSVを取り込み、座標化し、優先度と距離をもとに配送順を作成します。作成したルートはSupabaseに保存し、Google Sheets上で最新ルート、起点、合計距離、配送先件数、配送順を確認できます。

### デモで確認できること

- 住所CSVから配送先データを作成
- 会社センターを起点にした配送順の作成
- ルート結果のSupabase保存
- Google Sheetsでの最新ルート表示
- 配送順、配送先、住所、区間距離、累計距離の確認

### 技術構成

Python, Google Geocoding API, Supabase, Google Sheets, Apps Script, GitHub, Devin, Codex

### 今後やりたいこと

複数車両対応、配送時間帯制約、スタッフ稼働状況との連携、実配送結果との差分比較を追加したいです。また、今後はFly.ioなどにルート作成バッチを配置し、手元PCに依存しない実行や定期実行に対応したいです。

## 概要

配送先リストから、配送しやすい順番のルートを作り、最終的にGoogle Sheetsへ出力するためのハッカソン用プロジェクトです。

## まず作るもの

- 仮の配送先データ
- 配送順を並べ替えるロジック
- Google Sheetsに貼り付けやすい出力
- 会社のGoogle Workspace上で動かせるApps Script

## フォルダ構成

```text
data/
  sample_delivery_destinations.csv   仮の配送先リスト (緯度経度あり)
  sample_addresses.csv               住所だけのリスト (ジオコーディング用)
output/
  optimized_route.csv                作成された配送順
src/
  route_optimizer.py                 ローカル確認用
  geocoder.py                        住所 → 緯度経度 (キャッシュ付き)
  geocode_destinations.py            住所CSV → 配送先CSV
  extract_tasks_from_excel.py        スケジュールExcelから中間CSVを抽出する
  supabase_client.py                 Supabase REST APIへの最小クライアント
  import_destinations.py             配送先CSVをSupabaseに取り込む
  save_route_to_supabase.py          ルート結果をSupabaseに保存する
supabase/
  schema.sql                         Supabaseのテーブル定義
apps-script/
  Code.gs                            Google Sheetsで動かす用
docs/
  feature_ideas.md                   追加機能の案
```

## データの前提

SalesforceからCSVを書き出すときも、最終的には以下の列に寄せる想定です。

```text
id,name,address,lat,lng,time_window_start,time_window_end,service_minutes,priority
```

`lat` / `lng` が無い住所だけのCSVは、後述のジオコーディングでこの形に変換できます。

## ローカルで試す

```bash
python3 src/route_optimizer.py

# 別のCSV・別の起点で試す
python3 src/route_optimizer.py --input data/geocoded_destinations.csv --origin tokyo_station
```

実行すると、`output/optimized_route.csv` が作成されます。

## 住所だけのCSVからルートを作る (ジオコーディング)

`address` 列だけあるランダムな住所CSVを、緯度経度付きの配送先CSVに変換します。
`id` / `name` / `priority` / 時間帯の列は無ければ自動補完されます (`D001`、住所、`3`、9:00-18:00)。

```bash
# Google Geocoding API を使う (推奨)
export GOOGLE_MAPS_API_KEY=...   # .env / Fly secrets のみ。コードやCSVには書かない
python3 src/geocode_destinations.py \
  --input data/sample_addresses.csv \
  --output data/geocoded_destinations.csv

# キー無しで動作を見る (OpenStreetMap Nominatim。開発確認専用、1秒1リクエストに制限)
python3 src/geocode_destinations.py --provider nominatim --dry-run
```

### プロバイダの使い分け (重要)

| 用途 | プロバイダ |
| --- | --- |
| デモ本番・実運用 | **Google Geocoding API (`GEOCODER=google`) を前提とする** |
| 手元での開発確認 | Nominatim (`--provider nominatim`)。キー不要だが結果の精度は保証しない |

Nominatim は存在しない住所文字列 (例: 「あああああ」) を別の地点にマッチさせて
もっともらしい座標を返すことがあるため、誤った配送先がルートに入る。
デモ本番や実運用では必ず `GOOGLE_MAPS_API_KEY` を設定して Google を使うこと。

- 結果は `data/geocode_cache.json` にキャッシュされ、同じ住所は2回目以降APIを呼びません（見つからなかった住所も記録します）。キャッシュと変換結果は顧客情報を含むため `.gitignore` 対象です。
- `東京都港区海岸1-7-1` のような街区番号で当たらない場合は `東京都港区海岸1丁目` まで粒度を落として再検索します。それでも見つからない行は `[skip]` として出力から外します。

変換後はCSVは既存の形なので、そのまま取込み・保存に使えます。

```bash
python3 src/import_destinations.py --input data/geocoded_destinations.csv
python3 src/save_route_to_supabase.py --source supabase --label デモ便

# 住所だけのCSVを直接渡すこともできる (足りない座標だけその場でジオコーディングする)
python3 src/save_route_to_supabase.py --source csv --input data/sample_addresses.csv --dry-run
```

### 起点の指定

`--origin` (または環境変数 `ROUTE_ORIGIN`) でルートの起点を切り替えます。`src/route_optimizer.py` と `src/save_route_to_supabase.py` の両方で使えます。

| 指定 | 動作 |
| --- | --- |
| `tokyo_station` (既定) | 東京駅 (35.681236, 139.767125) を固定で使う |
| `center` | `ROUTE_ORIGIN_LAT` / `ROUTE_ORIGIN_LNG`、無ければ `ROUTE_ORIGIN_ADDRESS` をジオコーディングして使う (表示名は `ROUTE_ORIGIN_NAME`) |
| 任意の住所 | その住所をジオコーディングして起点にする |

```bash
ROUTE_ORIGIN_ADDRESS="東京都江東区新木場1丁目" \
  python3 src/save_route_to_supabase.py --source csv --origin center --dry-run
```

起点は `route_runs.start_name` / `start_address` / `start_lat` / `start_lng` にそのまま保存されるので、Google Sheets 側の表示経路は変えずに使えます。

## スケジュールExcelからタスク候補を抽出する

運用中の日別シート形式のExcel (例: `2026年8月スケジュール.xlsx`) を、そのままルート最適化に
使うのは無理があるので、**人が見て補正できる中間CSV** に落とすステップを用意しています。

```bash
pip install -r requirements.txt

python3 src/extract_tasks_from_excel.py \
  --input "2026年8月スケジュール.xlsx" \
  --output data/tasks_2026-08.csv

# 特定日だけ / 書き出さずに件数だけ見る
python3 src/extract_tasks_from_excel.py --input "..." --sheet 815 --sheet 820
python3 src/extract_tasks_from_excel.py --input "..." --dry-run
```

出力列:

```text
date,task_type,customer,venue_name,address,start_time,end_time,
required_vehicle,required_staff_count,assigned_vehicle,assigned_staff,origin,notes
```

読み取っているもの:

| 元のExcel | 出力列 |
| --- | --- |
| A列の案件記入欄 (11行1ブロックのテンプレート) | `task_type=案件` の行として1件 |
| C列以降の担当者列で「＠」を含むセル | 1タスク。`お客様名＠場所` を `customer` / `venue_name` に分割 |
| 見出しの `【設】` `【設/OP/撤】` など | `task_type` (`設営` / `設営/オペレート/撤去` など。タグ無しは `要確認`) |
| 2行目の担当者名 | `assigned_staff` |
| `【10号車】ｾﾝﾀｰ発` / `直行` / `直帰` | `assigned_vehicle` と `origin` (`センター` / `直行`) |
| `4t` / `2t` / `1BOX` / `ﾊｲﾙｰﾌ` | `required_vehicle` |
| `設営撤去12名` / `設営撤去+9名` | `required_staff_count` |
| `10:00 ～ 19:00` / `(11:30)` | `start_time` (指定時刻を優先) / `end_time` |
| `A12345678(◯◯会場)` | `venue_name=◯◯会場`、伝票番号は `notes` |

判定できなかった記述は捨てずに `notes` に残します。`address` は空で出るので、
住所と緯度経度は人が補ってから `data/*.csv` (`id,name,address,lat,lng,...`) に整形し、
`src/import_destinations.py` → `src/save_route_to_supabase.py` の既存の流れに乗せます。
抽出は読み取り専用で、Supabase保存やSheets表示の流れには手を入れていません。

## Fly.ioでのデプロイ手順

Dockerで動かすための `Dockerfile` と `fly.toml` をリポジトリのルートに用意しています。

このスクリプトは実行後すぐ終了するバッチのため、常駐アプリ向けの `fly deploy` ではなく「イメージをpush → 単発マシンで実行」の流れを使います。
コンテナ内のファイルは残らないため、既定の実行内容は `src/save_route_to_supabase.py`（Supabaseへ結果を保存）にしています。

```bash
# 初回のみ（アプリを作成。fly.toml の app 名を変えたい場合は先に書き換える）
fly apps create aiau-craft-day2026

# Supabaseの接続情報をシークレットとして登録（実行時に環境変数として渡される）
fly secrets set -a aiau-craft-day2026 \
  SUPABASE_URL="https://xxxxxxxx.supabase.co" \
  SUPABASE_SERVICE_ROLE_KEY="..." \
  GOOGLE_MAPS_API_KEY="..."   # ジオコーディングをFly上でも使う場合のみ

# イメージをビルドしてFlyのレジストリにpush（マシンは作らない）
fly deploy --build-only --push -a aiau-craft-day2026
# → 最後に image: registry.fly.io/aiau-craft-day2026:deployment-XXXX が表示される

# 単発実行（--detach を付ける。実行後にマシンは自動削除される）
# 既定のコマンドは python3 src/save_route_to_supabase.py（--source supabase）
fly machine run registry.fly.io/aiau-craft-day2026:deployment-XXXX \
  --env ROUTE_RUN_LABEL="2026-02-01_午前便" \
  --rm --detach -a aiau-craft-day2026 --region nrt

# 実行結果の確認（route_run_id=... に N件の配送順を保存しました と出る）
fly logs -a aiau-craft-day2026 --no-tail
```

配送先マスタがまだ空の場合は、先にCSVの取込みを流します。

```bash
fly machine run registry.fly.io/aiau-craft-day2026:deployment-XXXX \
  --command "python3 src/import_destinations.py" \
  --rm --detach -a aiau-craft-day2026 --region nrt
```

実行内容は `--command` で切り替えられます。

| やりたいこと | `--command` |
| --- | --- |
| Supabaseに保存（既定） | 指定なし |
| 手元CSVの配送先から作って保存 | `python3 src/save_route_to_supabase.py --source csv` |
| CSVを作るだけ（Supabase不要） | `python3 src/route_optimizer.py` |
| 配送先CSVの取込み | `python3 src/import_destinations.py` |

ローカルでDockerだけ試す場合は次の通りです。

```bash
docker build -t aiau-craft-day2026 .

# Supabaseに保存（.env に SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY がある想定）
docker run --rm --env-file .env aiau-craft-day2026

# CSVを作るだけ
docker run --rm aiau-craft-day2026 python3 src/route_optimizer.py
```

### 注意

- `src/route_optimizer.py` は一度実行して終了するバッチスクリプトです。Fly.ioの常駐アプリ（Webサーバー）用途とは異なるため、`fly.toml` には `[http_service]` を設定していません。
- そのため `fly deploy`（および `--detach` なしの `fly machine run`）は、マシンが起動状態を維持しないため `timeout reached waiting for machine's state to change` というエラーで終了します。処理自体は成功しており（`fly logs` に `配送順を作成しました` と `Main child exited normally with code: 0` が出ます）、上記の `--build-only --push` + `--detach` の手順を使えばエラーになりません。
- 常駐させてブラウザから使いたい場合は、別途HTTPサーバー化（Flask / FastAPI などでエンドポイントを用意する）が必要です。
- コンテナ内の `output/optimized_route.csv` はマシン停止時に消えます。そのためFly上では既定でSupabaseに保存する構成にしています。CSVを成果物として残したい場合はVolumeのマウントなどが別途必要です。
- `SUPABASE_SERVICE_ROLE_KEY` は `fly secrets set` で登録します（`fly.toml` の `[env]` には書かないでください。`fly.toml` はリポジトリにコミットされます）。

## Supabaseで使う

### テーブル構成

| テーブル | 役割 |
| --- | --- |
| `delivery_destinations` | 配送先マスタ。CSVの `id` は `external_id` に入り、再取込みは upsert になる |
| `route_runs` | ルート作成1回分。出発地点・合計距離・件数・状態を持つ |
| `route_stops` | ルート結果の明細。`route_runs` に紐づく配送順1件が1行 |
| `latest_route_stops` | 直近のルート結果の明細を、シートの列順で読むためのビュー |
| `latest_route_summary` | 同じルートのメタ情報 (ルート名・起点・合計距離・件数・作成日時) を1行だけ返すビュー |

定義は `supabase/schema.sql` にあります。Supabase Studio の SQL Editor に貼り付けて実行してください。

### キーの使い分け (重要)

| キー | 使う場所 | 見える範囲 |
| --- | --- | --- |
| service_role | 手元の管理スクリプト (`src/*.py`) だけ | 全テーブル (RLSをバイパス) |
| anon | Apps Script / 読み取り側 | `latest_route_stops` / `latest_route_summary` ビューのみ |

**service_role キーは Apps Script には置きません。** Apps Script のコードやスクリプトプロパティは
そのスプレッドシートの編集権を持つ人が見られるため、全テーブルに書き込めるキーを置くのは危険です。

テーブル本体は RLS を有効にした上で anon / authenticated のポリシーを一切作らず、
GRANT も外しています。外に公開するのは `latest_route_stops` と `latest_route_summary` の
2つのビューだけで、このビューに `grant select ... to anon` しています。

### 依存パッケージ

Supabaseに接続するスクリプト (`src/import_destinations.py` / `src/save_route_to_supabase.py`) は
certifi を使います (ジオコーディングも同じ SSLContext を使うため必要です)。

```bash
pip install -r requirements.txt
```

CA証明書が入っていない環境でも `SSL_CERT_FILE` を手で指定せずに接続できるよう、
certifi のCA束から作った `SSLContext` を使っています。

### 環境変数 (ローカルの管理スクリプト用)

```bash
export SUPABASE_URL="https://xxxxxxxx.supabase.co"
export SUPABASE_SERVICE_ROLE_KEY="..."

# ジオコーディングを使う場合
export GOOGLE_MAPS_API_KEY="..."
export GEOCODER="google"          # デモ本番は google 固定。nominatim は開発確認用
```

service_role キーは RLS をバイパスするため、リポジトリにはコミットせず `.env` などに置いてください
(`.gitignore` に `.env` が入っています)。
`GOOGLE_MAPS_API_KEY` も同じく `.env` / `fly secrets` のみで扱い、Apps Script には置きません。

### 配送先CSVの取込み

```bash
python3 src/import_destinations.py                 # data/sample_delivery_destinations.csv を取込み
python3 src/import_destinations.py --input path/to/salesforce.csv --source salesforce
python3 src/import_destinations.py --encoding cp932   # Excel由来のShift_JIS CSV
python3 src/import_destinations.py --dry-run       # 送信予定のJSONだけ表示
```

主なオプション:

| オプション | 既定 | 説明 |
| --- | --- | --- |
| `--encoding` | `utf-8-sig` | CSVの文字コード。Excelからの書き出しは `cp932` のことが多い |
| `--allow-duplicate-ids` | 無効 | 同じCSV内のid重複を許し、後の行を採用する |
| `--batch-size` | 200 | 1回の送信件数 |
| `--source` | `csv` | `source` 列に入れる取込み元の記録 |

#### id重複の扱い

同じCSV内に同じ `id` がある場合、既定では行番号付きでエラーにし、**1件も送信しません**。
意図的な上書きなら `--allow-duplicate-ids` を付けると、後の行を採用 (last-wins) して
警告を出しながら進みます。どちらの場合も、Supabaseに送る時点では `external_id` は一意です。

既にテーブルにある `external_id` は、別の実行であっても upsert で上書きされます。

#### 途中で失敗したとき

取込みは `--batch-size` 件ずつ送信するため、**全体でのトランザクションにはなっていません**。
途中でエラーになると、そこまでのバッチだけが反映された部分成功の状態になります
(何件反映済みかはエラー時に表示されます)。

安全な再実行方針: **同じCSVをそのままもう一度実行してください。**
`external_id` をキーにした upsert なので、反映済みの行は同じ内容で上書きされるだけで、
重複レコードはできません。完全に一括で反映させたい場合は、件数が多くないうちは
`--batch-size 100000` のように1回の送信に収めると、PostgREST側で同じトランザクションになります。

### ルート結果の保存

```bash
python3 src/save_route_to_supabase.py --source supabase --label 2026-02-01_午前便
python3 src/save_route_to_supabase.py --source csv --dry-run
```

`route_runs` に1行、`route_stops` に配送順が保存されます。既存の `output/optimized_route.csv` の出力はそのまま使えます。

## Google Sheetsで使う流れ (段階1: 今の形)

この手順は既存の `apps-script/Code.gs` (シート内でルート計算する版) を使います。Supabaseは使いません。

1. Google Sheetsを作る
2. シート名を `配送先` にする
3. `data/sample_delivery_destinations.csv` の中身を貼り付ける
4. Google Sheetsのメニューから `拡張機能 > Apps Script` を開く
5. `apps-script/Code.gs` の中身を貼り付ける
6. `optimizeRoute` を実行する (シートの `配送ルート` メニューからでも可)
7. `ルート結果` シートに配送順が出力される

## Google SheetsでSupabaseの結果を見る (段階2)

ルート計算は手元で済ませ、Apps Script は `latest_route_summary` と `latest_route_stops` を
読むだけにします。
使う関数は `importRouteFromSupabase` で、書き出し先は段階1と同じ `ルート結果` シートです。

シートの上部に最新 run のメタ情報を出し、空行をはさんで従来と同じ列順の明細を出します。

```text
A列        B列
ルート名    2026-02-01_午前便      ← run_label
起点        東京駅                ← start_name
起点住所    東京都千代田区丸の内1  ← start_address
合計距離km  42.7                  ← total_distance_km
作成日時    2026-02-01 09:12      ← created_at (スクリプトのタイムゾーンで整形)
配送先件数  10                    ← stop_count
(空行)
配送順 | ID | 配送先名 | 住所 | 希望時間 | 作業分数 | 優先度 | 区間距離km | 累計距離km
...
```

値が空の項目は `(未設定)` と表示します。段階1の `optimizeRoute` は従来どおり明細だけを書きます。

書式はスクリプト側で毎回付け直します。メタ情報エリアと明細ヘッダーに背景色、明細ヘッダーは
太字・中央揃えで固定 (`setFrozenRows`)、配送先名・住所・起点住所は折り返し、数値列は右寄せ、
列幅は住所や時刻が潰れない固定値にしています。

### 1. Supabase側を準備する

```bash
python3 src/import_destinations.py
python3 src/save_route_to_supabase.py --source supabase --label 2026-02-01_午前便
```

### 2. anonキーを控える

Supabaseダッシュボードの `Project Settings > API` から、`Project URL` と
`anon public` キーをコピーします。**service_role キーは使いません。**

### 3. スクリプトプロパティを設定する

1. Google Sheetsの `拡張機能 > Apps Script` を開く
2. `apps-script/Code.gs` の中身を貼り付けて保存する
3. 左のメニューで `プロジェクトの設定` (歯車アイコン) を開く
4. `スクリプト プロパティ` で `スクリプト プロパティを追加` を押し、以下の2つを登録する

| プロパティ名 | 値 |
| --- | --- |
| `SUPABASE_URL` | `https://xxxxxxxx.supabase.co` |
| `SUPABASE_ANON_KEY` | anon public キー |

キーを `Code.gs` に直書きしないでください。コードはリポジトリに戻すことがあります。

### 4. 実行する

`importRouteFromSupabase` を実行するか、シートを開き直して `配送ルート > Supabaseから取得 (段階2)`
を選びます。初回は UrlFetchApp の権限承認が出ます。

よくあるエラー:

| メッセージ | 原因 |
| --- | --- |
| スクリプトプロパティに ... を設定してください | 上の2つが未登録 |
| 読み取りに失敗しました (401/404) | anonキーが違う、またはビューへの `grant select ... to anon` 未実行。既存プロジェクトは `latest_route_summary` を追加するため `supabase/schema.sql` を再実行する |
| 完了済みのルートがありません | `route_runs` に `status = 'completed'` の行がない |

## Google Sheets出力との接続方針

Supabaseを入れても、配送担当者が見る画面はGoogle Sheetsのままにします。
Supabaseは「データの正」、Google Sheetsは「見る・直す場所」という分け方です。

### 段階1: 今の形 (ハッカソン当日)

```text
CSV → Google Sheets → Apps Scriptでルート作成 → ルート結果シート
```

Supabaseなしで完結します。当日のデモはこの経路を使います。
必要なもの: 現在の `apps-script/Code.gs` (`optimizeRoute`) 。変更は不要です。

### 段階2: Supabaseを裏に置く

```text
Salesforce CSV → src/import_destinations.py → delivery_destinations
                                                    ↓
                            src/save_route_to_supabase.py
                                                    ↓
                                      route_runs / route_stops
                                                    ↓
                            Apps Script が REST API で読み取り
                                                    ↓
                                        ルート結果シート
```

ルート計算は手元のスクリプト (service_role) 側で行い、Apps Script は表示だけの担当になります。
使うのは `apps-script/Code.gs` の `importRouteFromSupabase` で、手順は上の
「Google SheetsでSupabaseの結果を見る (段階2)」を参照してください。
段階1の `optimizeRoute` はそのまま残してあり、どちらも同じ `ルート結果` シートに書きます。

読み取りには **anon キー** を使い、`supabase/schema.sql` で `latest_route_stops` /
`latest_route_summary` ビューにだけ `grant select ... to anon` しています。
テーブル本体は RLS と GRANT の両方で閉じているので、anon キーが漏れても
見えるのは「直近の完了済みルート」だけです。

anon キーも外に出したくない場合は、Supabase Edge Function を間に入れ、
service_role をサーバ側に閉じ込めます。

```text
Apps Script → Edge Function (共有シークレットで認証 / service_roleは関数内だけ)
             → route_runs / route_stops
```

この場合は 2つのビューへの anon 向け grant をやめ、Apps Script には
関数専用のシークレットだけを持たせます。書き戻し (段階3) をやるならこちら推奨です。

### 段階3: シートでの調整を戻す

配送担当者がシート上で順番を入れ替えた結果を `route_stops` に書き戻します。
書き込みは anon キーではできないし、させるべきでもないので、上の Edge Function 経由
(または手元スクリプト) で行います。

### 決めておくこと

- service_role キーは手元の管理スクリプト専用。Apps Script には置かない
- Apps Script からは anon キーで `latest_route_stops` / `latest_route_summary` だけを読む。
  さらに閉じたい場合は Edge Function 経由にする
- キーはコードに直書きせず、必ず スクリプトプロパティ (`SUPABASE_URL` / `SUPABASE_ANON_KEY`) に入れる
- Supabaseに保存される `route_runs.status` は `completed` になって初めてビューに出る。
  作成中のものをシートに見せたくなければ `draft` で入れる
- 個人情報 (電話番号など) の列を増やす場合は、ビューに出す列を絞る
