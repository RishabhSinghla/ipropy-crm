"""The one way this worker talks to the CRM.

Every AI call goes through the CRM rather than straight to a model. The worker
could hold an OpenRouter key of its own, and that is the trap this project keeps
walking into: two copies of one setting, one of them editable in the admin
panel, quietly disagreeing. The key lives in the CRM where an admin can rotate
it or switch provider, and the pipeline follows without anybody touching a
container.

Everything here returns None rather than raising when the CRM is unreachable or
has no provider configured. A property still gets its photos, its shapes and its
watermark when there is no voice to put on the video.
"""
from __future__ import annotations

import base64
import json
import os
import urllib.error
import urllib.request

CRM_URL = os.environ.get("CRM_URL", "").rstrip("/")
CRM_SECRET = os.environ.get("CRM_N8N_SECRET", "")


class CrmUnavailable(RuntimeError):
    """Raised only where a caller genuinely cannot continue without the CRM."""


def configured() -> bool:
    return bool(CRM_URL and CRM_SECRET)


def _post(path: str, body: dict, timeout: int = 300) -> dict | None:
    if not configured():
        return None
    request = urllib.request.Request(
        f"{CRM_URL}{path}",
        data=json.dumps(body).encode(),
        headers={"Content-Type": "application/json", "x-n8n-secret": CRM_SECRET},
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            return json.loads(response.read().decode())
    except (urllib.error.URLError, TimeoutError, json.JSONDecodeError, OSError) as err:
        print(f"  crm: {path} failed: {err}", flush=True)
        return None


def text(prompt: str, system: str | None = None, max_tokens: int = 4000,
         record_id: str | None = None) -> str | None:
    """Ask a model a question with no picture attached."""
    return vision(prompt, [], system=system, max_tokens=max_tokens, record_id=record_id)


def vision(prompt: str, images: list[bytes], system: str | None = None,
           max_tokens: int = 4000, record_id: str | None = None) -> str | None:
    """Ask a model to look at photos and answer in JSON.

    Batched at eight because that is what the endpoint accepts: a preview is
    about 200KB and the CRM parses a 5MB body, so nine would be refused rather
    than truncated. Callers with more photos than that chunk and merge.
    """
    body = {
        "prompt": prompt,
        "images": [{"data": base64.b64encode(i).decode(), "mimeType": "image/jpeg"} for i in images[:8]],
        "maxTokens": max_tokens,
    }
    if system:
        body["system"] = system
    if record_id:
        body["recordId"] = record_id
    result = _post("/api/webhooks/n8n/ai/vision", body)
    if not result or not result.get("ok"):
        if result:
            print(f"  vision unavailable: {result.get('reason')}", flush=True)
        return None
    return result.get("text")


def speech(text: str, voice: str | None = None, speed: float | None = None,
           record_id: str | None = None) -> bytes | None:
    body: dict = {"text": text, "format": "mp3"}
    if voice:
        body["voice"] = voice
    if speed:
        body["speed"] = speed
    if record_id:
        body["recordId"] = record_id
    result = _post("/api/webhooks/n8n/ai/speech", body)
    if not result or not result.get("ok"):
        if result:
            print(f"  voice unavailable: {result.get('reason')}", flush=True)
        return None
    return base64.b64decode(result["audio"])


def music(brief: str, seconds: int = 30, record_id: str | None = None) -> bytes | None:
    body: dict = {"brief": brief, "seconds": seconds}
    if record_id:
        body["recordId"] = record_id
    result = _post("/api/webhooks/n8n/ai/music", body)
    if not result or not result.get("ok"):
        if result:
            print(f"  music unavailable: {result.get('reason')}", flush=True)
        return None
    return base64.b64decode(result["audio"])


def parse_json(text: str | None):
    """Pull the JSON out of a model's answer.

    Models wrap JSON in prose and in code fences however firmly you ask them not
    to, so the first `{` or `[` to the last matching bracket is the reliable
    read. Returning None on a mangled answer is deliberate: a half-parsed photo
    index would rename half a folder.
    """
    if not text:
        return None
    cleaned = text.strip()
    if cleaned.startswith("```"):
        cleaned = cleaned.split("```", 2)[1]
        if cleaned.startswith("json"):
            cleaned = cleaned[4:]
    for opener, closer in (("[", "]"), ("{", "}")):
        start = cleaned.find(opener)
        end = cleaned.rfind(closer)
        if start != -1 and end > start:
            try:
                return json.loads(cleaned[start:end + 1])
            except json.JSONDecodeError:
                continue
    return None
