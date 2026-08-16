# Google Sheets 設定手順

配車担当者が「ルート結果」を見るための Google Sheets 側の手順です。
プロジェクト全体の状況は [project_handover.md](project_handover.md) を参照してください。

このドキュメントに実際のキー・URL・顧客名は書きません。設定値はスクリプトプロパティに入れます。

- 初回の管理者作業（Code.gs の貼り替え、APIキーの制限、予算アラート）: [admin_setup.md](admin_setup.md)
- スタッフの日々の操作: [staff_manual.md](staff_manual.md)

## 0. 2つのモード

| モード | ルート計算をする場所 | 必要なもの | 使いどころ |
| --- | --- | --- | --- |
| 段階1 | Google Sheets 内（`optimizeRoute`） | スプレッドシートだけ | すぐ試したいとき。座標入りのデータが前提 |
| 段階2 | 手元のPython（結果をSupabaseへ保存） | Supabase の URL と anon キー | 履歴を Supabase に残したいとき |
| 段階3 | Google Sheets 内（`createRouteFromInputSheet`） | Google Geocoding API キー | ターミナルを使わず、住所だけで作りたいとき |

スタッフが日々使うのは段階3です（4章）。段階1は座標を手で用意する必要があり、
段階2は手元で Python を実行する前提です。

## 1. スプレッドシートを用意する

1. 新しいスプレッドシートを作る
2. シート名を `配送先` にする
3. 1行目に次の見出しを入れる

```text
id,name,address,lat,lng,time_window_start,time_window_end,service_minutes,priority
```

4. 動作確認だけなら `data/sample_delivery_destinations.csv` の中身をそのまま貼り付ける

各列の意味:

| 列 | 内容 |
| --- | --- |
| `id` | 配送先の識別子。Supabase 側の `external_id` と対応する |
| `name` | 配送先名 |
| `address` | 住所 |
| `lat` / `lng` | 緯度・経度。段階1では必須 |
| `time_window_start` / `time_window_end` | 希望時間帯（`HH:MM`）。現状は表示のみで順序には使わない |
| `service_minutes` | 現地での作業分数 |
| `priority` | 優先度（1が最優先）。小さいほど先に回る |

## 2. スクリプトを貼り付ける

1. `拡張機能 > Apps Script` を開く
2. `apps-script/Code.gs` の中身をすべて貼り付けて保存する
3. スプレッドシートを開き直すと、メニューに `配送ルート` が出る

## 3. 段階1: シート内でルートを作る

1. メニュー `配送ルート > シートからルート作成 (段階1)` を実行する
2. 初回は Google アカウントの承認画面が出るので許可する
3. `ルート結果` シートに配送順が書き出される

起点は現在スクリプト内で東京駅に固定されています（`optimizeRoute` 内の `startPoint`）。
順序は「優先度が高い順、同じ優先度なら近い順」の貪欲法で、距離は直線距離（Haversine）です。

## 4. 段階3: 「配送先入力」シートだけでルートを作る

ターミナルを使わず、住所の貼り付けだけで配送順を作る手順です。Supabase には書きません。

### 4.1 管理者が最初に1回だけやること

Apps Script の `プロジェクトの設定 > スクリプト プロパティ` に登録します。

| プロパティ名 | 必須 | 内容 |
| --- | --- | --- |
| `GOOGLE_MAPS_API_KEY` | 必須 | Geocoding API を有効にした API キー |
| `ROUTE_ORIGIN_ADDRESS` | どちらか必須 | 会社センターの住所。実行時に座標化される |
| `ROUTE_ORIGIN_LAT` / `ROUTE_ORIGIN_LNG` | どちらか必須 | センターの座標。設定すれば住所の座標化を省く |
| `ROUTE_ORIGIN_NAME` | 任意 | 起点の表示名。未設定なら `会社センター` |

API キーは `Code.gs` に直書きしないでください。キーには Geocoding API だけの制限をかけることを推奨します。
`SUPABASE_SERVICE_ROLE_KEY` はここにも置きません。

### 4.2 スタッフの手順

1. シート名 `配送先入力` を作る
2. 受付書や Salesforce から書き出した配送先CSVを、見出しごと貼り付ける
3. 配送日を入れる（どちらか1つ）
   - 見出し行より上の行に `配送日` と書き、その右のセルに `2026-08-15` を入れる
   - または `delivery_date` 列を作って日付を入れる
4. メニュー `配送ルート > 配送ルート作成 (配送先入力シートから)` を実行する
5. `2026-08-15_配送ルート` タブが新しく作られ、配送順が入る

入力例（見出しは英語でも日本語でも可。`住所` = `address` など）:

```text
配送日   2026-08-15

id,name,address,priority
,,東京都江東区有明3-11-1,1
D002,渋谷会場,東京都渋谷区神南1-19-8,2
```

- `id` や `name` が空でも動きます。`id` は `D01` からの連番、`name` は住所が使われます。
- `priority` が空の行は `9`（一番後）扱いです。
- `address` が空の行は飛ばします。
- 任意で `time_window_start` / `time_window_end` / `service_minutes` 列も使えます。

### 4.3 実行すると起きること

- 座標のない住所だけ Google Geocoding API に問い合わせます（1回の実行につき最大 80件）。
- 80件を超えた回は、座標の書き戻しだけ行ってルートタブは作りません（途中までのルートは出しません）。
  メッセージに従ってもう一度実行してください。全件の座標が揃った回にルートを作ります。
- 取得した座標は `配送先入力` シートの `lat` / `lng` 列に書き戻され、次回以降は問い合わせません（列が無ければ自動で追加）。
- 同じ日付のタブが既にある場合は上書きせず、`2026-08-15_配送ルート_2` のように連番を付けます。
- 出力タブの形式は段階2の `ルート結果` シートと同じ（上部にメタ情報、下に明細）です。
- 座標を取れなかった住所はルートから外れ、実行後の通知に件数と住所が出ます。住所を直して再実行してください。

## 5. 段階2: Supabase の結果を表示する

### 5.1 事前準備（管理者が手元で実施）

```bash
# Supabase の SQL Editor で supabase/schema.sql を実行しておく
python3 src/import_destinations.py --input data/sample_delivery_destinations.csv
python3 src/save_route_to_supabase.py --source supabase --label 2026-02-01_午前便
```

### 5.2 スクリプトプロパティを設定する

Apps Script の `プロジェクトの設定 > スクリプト プロパティ` に次の2つだけを登録します。

| プロパティ名 | 値の取得元 |
| --- | --- |
| `SUPABASE_URL` | Supabase ダッシュボード `Project Settings > API` の Project URL |
| `SUPABASE_ANON_KEY` | 同ページの `anon public` キー |

**`service_role` キーは絶対に登録しないでください。** スクリプトプロパティは
そのスプレッドシートの編集者が閲覧できるため、書き込み権限が漏れます。

### 5.3 実行する

1. メニュー `配送ルート > Supabaseから取得 (段階2)` を実行する
2. `ルート結果` シートが次の形で書き換わる

```text
A列        B列
ルート名    2026-02-01_午前便      ← run_label
起点        東京駅                 ← start_name
起点住所    （起点の住所）          ← start_address
合計距離km  42.7                   ← total_distance_km
作成日時    2026-02-01 09:12       ← created_at
配送先件数  10                     ← stop_count
(空行)
配送順 | ID | 配送先名 | 住所 | 希望時間 | 作業分数 | 優先度 | 区間距離km | 累計距離km
...
```

値が空の項目は `(未設定)` と表示されます。書式（背景色・列幅・折り返し・ヘッダー固定）は
実行のたびにスクリプトが付け直します。

## 6. 読み取り範囲とセキュリティ

- Apps Script が読むのは `latest_route_stops` と `latest_route_summary` の2ビューだけです。
- 元テーブル（`delivery_destinations` / `route_runs` / `route_stops`）は RLS 有効で、
  anon からは読めません。
- 表示されるのは「最新の完了ルート1件」です
  （`status in ('completed','exported')` の中で `created_at` が最新のもの）。
- メタ情報と明細は別リクエストのため、取得中に新しいルートが保存されると食い違う可能性があります。
  スクリプトは `route_run_id` が揃うまで最大3回読み直し、揃わない場合はメタ情報を出さずに
  明細だけを表示します。

## 7. よくあるエラー

| 症状 | 原因と対処 |
| --- | --- |
| `スクリプトプロパティに SUPABASE_URL と SUPABASE_ANON_KEY を設定してください。` | 5.2 の設定漏れ。プロパティ名の綴りも確認する |
| `スクリプトプロパティに GOOGLE_MAPS_API_KEY を設定してください。` | 4.1 の設定漏れ |
| `起点が設定されていません。` | 4.1 で `ROUTE_ORIGIN_ADDRESS` か `ROUTE_ORIGIN_LAT`/`ROUTE_ORIGIN_LNG` を入れる |
| `配送日が分かりません。` | `配送日` セルか `delivery_date` 列が無い。日付は `2026-08-15` 形式で入れる |
| `見出し行が見つかりません。` | `address`（または `住所`）という見出しの行が無い |
| `Google Geocoding API がエラーを返しました (REQUEST_DENIED)` | API キーで Geocoding API が有効でない、または制限設定で弾かれている |
| `未処理の住所が ○件残っているため、ルートは作っていません` | 1回の上限（80件）を超えた。もう一度実行すれば続きから処理され、全件揃った回にルートができる |
| `Supabaseの読み取りに失敗しました (401)` | anon キーが違う、またはビューへの grant がされていない。`supabase/schema.sql` を再実行する |
| `Supabaseの読み取りに失敗しました (404)` | ビューが存在しない。`supabase/schema.sql` を再実行する |
| `Supabaseに完了済みのルートがありません。` | `save_route_to_supabase.py` をまだ実行していない。または `status` が `completed` / `exported` になっていない |
| `配送先シートが見つかりません。` | 段階1でシート名が `配送先` になっていない |
| 段階1で距離が `NaN` になる | `lat` / `lng` が空、または数値になっていない |

## 8. スキーマを変更したとき

`supabase/schema.sql` を更新したら、既存のSupabaseプロジェクトでも SQL Editor で
再実行してください。ビューの追加や grant の変更は自動で反映されません。
