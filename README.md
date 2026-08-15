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
  SUPABASE_SERVICE_ROLE_KEY="..."

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

### 依存パッケージ

Supabaseに接続するスクリプト (`src/import_destinations.py` / `src/save_route_to_supabase.py`) は
certifi を使います。`src/route_optimizer.py` だけを動かす場合は不要です。

```bash
pip install -r requirements.txt
```

CA証明書が入っていない環境でも `SSL_CERT_FILE` を手で指定せずに接続できるよう、
certifi のCA束から作った `SSLContext` を使っています。

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
6. `optimizeRoute` を実行する (シートの `配送ルート` メニューからでも可)
7. `ルート結果` シートに配送順が出力される

## Google SheetsでSupabaseの結果を見る (段階2)

ルート計算は手元で済ませ、Apps Script は `latest_route_stops` を読むだけにします。
使う関数は `importRouteFromSupabase` で、書き出し先は段階1と同じ `ルート結果` シート・同じ列順です。

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
| 読み取りに失敗しました (401/404) | anonキーが違う、またはビューへの `grant select ... to anon` 未実行 |
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

読み取りには **anon キー** を使い、`supabase/schema.sql` で `latest_route_stops` ビューにだけ
`grant select ... to anon` しています。テーブル本体は RLS と GRANT の両方で閉じているので、
anon キーが漏れても見えるのは「直近の完了済みルート」だけです。

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
- キーはコードに直書きせず、必ず スクリプトプロパティ (`SUPABASE_URL` / `SUPABASE_ANON_KEY`) に入れる
- Supabaseに保存される `route_runs.status` は `completed` になって初めてビューに出る。
  作成中のものをシートに見せたくなければ `draft` で入れる
- 個人情報 (電話番号など) の列を増やす場合は、ビューに出す列を絞る
