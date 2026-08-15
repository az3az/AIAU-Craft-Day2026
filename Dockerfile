FROM python:3.12-slim

WORKDIR /app

COPY . .

# 現状は標準ライブラリのみだが、将来 requirements.txt を追加した場合に備える
RUN if [ -f requirements.txt ]; then pip install --no-cache-dir -r requirements.txt; fi

RUN mkdir -p output

# 既定はSupabaseへ結果を保存するバッチ。
# CSVだけ作りたい場合は `--command "python3 src/route_optimizer.py"` で上書きする。
CMD ["python3", "src/save_route_to_supabase.py"]
