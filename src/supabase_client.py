"""Supabase (PostgREST) への最小クライアント。

追加ライブラリを入れずに動かせるように、標準ライブラリだけで書いています。

必要な環境変数:
    SUPABASE_URL               例: https://xxxxxxxx.supabase.co
    SUPABASE_SERVICE_ROLE_KEY  service_role キー (RLSをバイパスするため取込み用に使う)
"""

import json
import os
import urllib.error
import urllib.request


class SupabaseError(RuntimeError):
    pass


class SupabaseClient:
    def __init__(self, url=None, service_role_key=None):
        self.url = (url or os.environ.get("SUPABASE_URL", "")).rstrip("/")
        self.service_role_key = service_role_key or os.environ.get(
            "SUPABASE_SERVICE_ROLE_KEY", ""
        )

        if not self.url or not self.service_role_key:
            raise SupabaseError(
                "SUPABASE_URL と SUPABASE_SERVICE_ROLE_KEY を環境変数に設定してください。"
            )

    def _request(self, method, path, payload=None, prefer=None, query=None):
        endpoint = f"{self.url}/rest/v1/{path}"
        if query:
            endpoint = f"{endpoint}?{query}"

        body = None if payload is None else json.dumps(payload).encode("utf-8")
        request = urllib.request.Request(endpoint, data=body, method=method)
        request.add_header("apikey", self.service_role_key)
        request.add_header("Authorization", f"Bearer {self.service_role_key}")
        request.add_header("Content-Type", "application/json")
        if prefer:
            request.add_header("Prefer", prefer)

        try:
            with urllib.request.urlopen(request) as response:
                raw = response.read().decode("utf-8")
        except urllib.error.HTTPError as error:
            detail = error.read().decode("utf-8", errors="replace")
            raise SupabaseError(f"Supabaseの呼び出しに失敗しました: {error.code} {detail}") from error

        return json.loads(raw) if raw else []

    def upsert(self, table, rows, on_conflict):
        """on_conflict の列をキーにして insert または update する。"""
        return self._request(
            "POST",
            table,
            payload=rows,
            prefer="resolution=merge-duplicates,return=representation",
            query=f"on_conflict={on_conflict}",
        )

    def insert(self, table, rows):
        return self._request(
            "POST",
            table,
            payload=rows,
            prefer="return=representation",
        )

    def select(self, table, query=None):
        return self._request("GET", table, query=query)
