FROM python:3.12-slim

WORKDIR /app

COPY . .

RUN pip install --no-cache-dir -r requirements.txt

RUN mkdir -p output

# 既定はSupabaseへ結果を保存するバッチ。
# CSVだけ作りたい場合は `--command "python3 src/route_optimizer.py"` で上書きする。
CMD ["python3", "src/save_route_to_supabase.py"]
