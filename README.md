# AIAU Craft Day 2026 - 配送ルート作成

配送先リストから、配送しやすい順番のルートを作り、最終的にGoogle Sheetsへ出力するためのハッカソン用プロジェクトです。

## まず作るもの

- 仮の配送先データ
- 配送順を並べ替えるロジック
- Google Sheetsに貼り付けやすい出力
- 会社のGoogle Workspace上で動かせるApps Script

## フォルダ構成

```text
data/
  sample_delivery_destinations.csv   仮の配送先リスト
output/
  optimized_route.csv                作成された配送順
src/
  route_optimizer.py                 ローカル確認用
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

今回の仮データは、住所だけではなく緯度・経度も入れています。
住所だけから正確な距離を出すにはGoogle Maps APIなどが必要になるため、まずはハッカソンで動く形を優先します。

SalesforceからCSVを書き出すときも、最終的には以下の列に寄せる想定です。

```text
id,name,address,lat,lng,time_window_start,time_window_end,service_minutes,priority
```

## ローカルで試す

```bash
python3 src/route_optimizer.py
```

実行すると、`output/optimized_route.csv` が作成されます。

## Supabaseで使う

### テーブル構成

| テーブル | 役割 |
| --- | --- |
| `delivery_destinations` | 配送先マスタ。CSVの `id` は `external_id` に入り、再取込みは upsert になる |
| `route_runs` | ルート作成1回分。出発地点・合計距離・件数・状態を持つ |
| `route_stops` | ルート結果の明細。`route_runs` に紐づく配送順1件が1行 |
| `latest_route_stops` | 直近のルート結果を、シートの列順で読むためのビュー |

定義は `supabase/schema.sql` にあります。Supabase Studio の SQL Editor に貼り付けて実行してください。

### 環境変数

```bash
export SUPABASE_URL="https://xxxxxxxx.supabase.co"
export SUPABASE_SERVICE_ROLE_KEY="..."
```

service_role キーは RLS をバイパスするため、リポジトリにはコミットせず `.env` などに置いてください。

### 配送先CSVの取込み

```bash
python3 src/import_destinations.py                 # data/sample_delivery_destinations.csv を取込み
python3 src/import_destinations.py --input path/to/salesforce.csv --source salesforce
python3 src/import_destinations.py --dry-run       # 送信予定のJSONだけ表示
```

### ルート結果の保存

```bash
python3 src/save_route_to_supabase.py --source supabase --label 2026-02-01_午前便
python3 src/save_route_to_supabase.py --source csv --dry-run
```

`route_runs` に1行、`route_stops` に配送順が保存されます。既存の `output/optimized_route.csv` の出力はそのまま使えます。

## Google Sheetsで使う流れ

1. Google Sheetsを作る
2. シート名を `配送先` にする
3. `data/sample_delivery_destinations.csv` の中身を貼り付ける
4. Google Sheetsのメニューから `拡張機能 > Apps Script` を開く
5. `apps-script/Code.gs` の中身を貼り付ける
6. `optimizeRoute` を実行する
7. `ルート結果` シートに配送順が出力される

## Google Sheets出力との接続方針

Supabaseを入れても、配送担当者が見る画面はGoogle Sheetsのままにします。
Supabaseは「データの正」、Google Sheetsは「見る・直す場所」という分け方です。

### 段階1: 今の形 (ハッカソン当日)

```text
CSV → Google Sheets → Apps Scriptでルート作成 → ルート結果シート
```

Supabaseなしで完結します。当日のデモはこの経路を使います。

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

Apps Script 側は `latest_route_stops` ビューを `GET /rest/v1/latest_route_stops` で取得し、
今の `writeRoute` と同じ列順でシートに書き込みます。ルート計算をSupabase側に寄せるので、
Apps Script は表示だけの担当になります。

```javascript
// Apps Script 側の想定 (キーは スクリプトプロパティ に入れる)
const props = PropertiesService.getScriptProperties();
const response = UrlFetchApp.fetch(
  props.getProperty('SUPABASE_URL') + '/rest/v1/latest_route_stops?select=*&order=stop_no.asc',
  { headers: { apikey: props.getProperty('SUPABASE_KEY'),
               Authorization: 'Bearer ' + props.getProperty('SUPABASE_KEY') } }
);
const stops = JSON.parse(response.getContentText());
```

### 段階3: シートでの調整を戻す

配送担当者がシート上で順番を入れ替えた結果を、`route_stops` に書き戻します
(`PATCH /rest/v1/route_stops?id=eq.<id>`)。この段階まで来ると、実績もSupabaseに残ります。

### 決めておくこと

- Apps Script から使うキー: 読み取り専用の anon キー + `authenticated` 向けSELECTポリシー、
  もしくは service_role キーをスクリプトプロパティに置く。社内利用なら後者が簡単
- キーはコードに直書きせず、必ず スクリプトプロパティ に入れる
- 個人情報 (電話番号など) の列を増やす場合は、Sheetsに出す列を絞る
