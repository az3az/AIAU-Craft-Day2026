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

### キーの使い分け (重要)

| キー | 使う場所 | 見える範囲 |
| --- | --- | --- |
| service_role | 手元の管理スクリプト (`src/*.py`) だけ | 全テーブル (RLSをバイパス) |
| anon | Apps Script / 読み取り側 | `latest_route_stops` ビューのみ |

**service_role キーは Apps Script には置きません。** Apps Script のコードやスクリプトプロパティは
そのスプレッドシートの編集権を持つ人が見られるため、全テーブルに書き込めるキーを置くのは危険です。

テーブル本体は RLS を有効にした上で anon / authenticated のポリシーを一切作らず、
GRANT も外しています。外に公開するのは `latest_route_stops` ビューだけで、
このビューに `grant select ... to anon` しています。

### 環境変数 (ローカルの管理スクリプト用)

```bash
export SUPABASE_URL="https://xxxxxxxx.supabase.co"
export SUPABASE_SERVICE_ROLE_KEY="..."
```

service_role キーは RLS をバイパスするため、リポジトリにはコミットせず `.env` などに置いてください
(`.gitignore` に `.env` が入っています)。

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

**必要な作業**: 段階1の `Code.gs` はシート内で計算する実装なので、Supabaseを読む関数
(例: `importRouteFromSupabase`) を `apps-script/Code.gs` に追加する必要があります。未実装です。

読み取りには **anon キー** を使い、`supabase/schema.sql` で `latest_route_stops` ビューにだけ
`grant select ... to anon` しています。テーブル本体は RLS と GRANT の両方で閉じているので、
anon キーが漏れても見えるのは「直近の完了済みルート」だけです。

```javascript
// apps-script/Code.gs に追加する想定 (キーは スクリプトプロパティ に入れる)
const props = PropertiesService.getScriptProperties();
const anonKey = props.getProperty('SUPABASE_ANON_KEY');  // service_role は置かない
const response = UrlFetchApp.fetch(
  props.getProperty('SUPABASE_URL') + '/rest/v1/latest_route_stops?select=*&order=stop_no.asc',
  { headers: { apikey: anonKey, Authorization: 'Bearer ' + anonKey } }
);
const stops = JSON.parse(response.getContentText());
```

anon キーも外に出したくない場合は、Supabase Edge Function を間に入れ、
service_role をサーバ側に閉じ込めます。

```text
Apps Script → Edge Function (共有シークレットで認証 / service_roleは関数内だけ)
             → route_runs / route_stops
```

この場合は `latest_route_stops` への anon 向け grant をやめ、Apps Script には
関数専用のシークレットだけを持たせます。書き戻し (段階3) をやるならこちら推奨です。

### 段階3: シートでの調整を戻す

配送担当者がシート上で順番を入れ替えた結果を `route_stops` に書き戻します。
書き込みは anon キーではできないし、させるべきでもないので、上の Edge Function 経由
(または手元スクリプト) で行います。

### 決めておくこと

- service_role キーは手元の管理スクリプト専用。Apps Script には置かない
- Apps Script からは anon キーで `latest_route_stops` だけを読む。
  さらに閉じたい場合は Edge Function 経由にする
- キーはコードに直書きせず、必ず スクリプトプロパティ に入れる
- Supabaseに保存される `route_runs.status` は `completed` になって初めてビューに出る。
  作成中のものをシートに見せたくなければ `draft` で入れる
- 個人情報 (電話番号など) の列を増やす場合は、ビューに出す列を絞る
