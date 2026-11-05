from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from google.auth.transport.requests import Request
from google.oauth2.credentials import Credentials
from google_auth_oauthlib.flow import InstalledAppFlow
from googleapiclient.discovery import build
from googleapiclient.http import MediaFileUpload


YOUTUBE_SCOPES = (
    "https://www.googleapis.com/auth/youtube.upload",
    "https://www.googleapis.com/auth/youtube.readonly",
)


@dataclass(slots=True)
class YouTubeVideoUploadRequest:
    account_file: Path
    video_file: Path
    title: str
    description: str
    tags: list[str]
    category_id: str = "28"
    privacy_status: str = "private"
    thumbnail_file: Path | None = None


def youtube_client_secret_file(runtime_root: Path) -> Path:
    return runtime_root / "youtube" / "client_secret.json"


def _load_credentials(account_file: Path) -> Credentials:
    if not account_file.is_file():
        raise RuntimeError(f"YouTube OAuth token is missing: {account_file}")
    credentials = Credentials.from_authorized_user_file(str(account_file), list(YOUTUBE_SCOPES))
    if credentials.expired and credentials.refresh_token:
        credentials.refresh(Request())
        account_file.write_text(credentials.to_json(), encoding="utf-8")
    if not credentials.valid:
        raise RuntimeError(f"YouTube OAuth token is invalid or expired: {account_file}")
    return credentials


def _service(account_file: Path):
    return build("youtube", "v3", credentials=_load_credentials(account_file), cache_discovery=False)


def login_youtube_account(account_file: Path, client_secret_file: Path) -> dict[str, str]:
    if not client_secret_file.is_file():
        raise RuntimeError(
            "YouTube OAuth desktop client file is missing: "
            f"{client_secret_file}. Create a Desktop app OAuth client with YouTube Data API v3 enabled."
        )
    flow = InstalledAppFlow.from_client_secrets_file(str(client_secret_file), list(YOUTUBE_SCOPES))
    credentials = flow.run_local_server(port=0, open_browser=True, authorization_prompt_message="Open this URL to authorize YouTube upload access:\n{url}")
    account_file.parent.mkdir(parents=True, exist_ok=True)
    account_file.write_text(credentials.to_json(), encoding="utf-8")
    channel = check_youtube_account(account_file)
    return {"account_file": str(account_file), **channel}


def check_youtube_account(account_file: Path, youtube_service: Any | None = None) -> dict[str, str]:
    service = youtube_service or _service(account_file)
    response = service.channels().list(part="id,snippet", mine=True, maxResults=1).execute()
    items = response.get("items") or []
    if not items:
        raise RuntimeError("YouTube OAuth token is valid but no channel is available for this account")
    channel = items[0]
    return {
        "channel_id": str(channel.get("id") or ""),
        "channel_title": str((channel.get("snippet") or {}).get("title") or ""),
    }


def upload_youtube_video(request: YouTubeVideoUploadRequest, youtube_service: Any | None = None) -> dict[str, Any]:
    if not request.video_file.is_file():
        raise RuntimeError(f"YouTube video file is missing: {request.video_file}")
    if not request.title.strip() or len(request.title) > 100:
        raise RuntimeError("YouTube title must contain 1 to 100 characters")
    if len(request.description) > 5000:
        raise RuntimeError("YouTube description must contain at most 5000 characters")
    if request.privacy_status not in {"private", "unlisted", "public"}:
        raise RuntimeError("YouTube privacy status must be private, unlisted, or public")
    if not request.category_id.isdigit():
        raise RuntimeError("YouTube category ID must be numeric")

    service = youtube_service or _service(request.account_file)
    body = {
        "snippet": {
            "title": request.title,
            "description": request.description,
            "tags": request.tags,
            "categoryId": request.category_id,
        },
        "status": {
            "privacyStatus": request.privacy_status,
            "selfDeclaredMadeForKids": False,
        },
    }
    video_media = MediaFileUpload(str(request.video_file), chunksize=-1, resumable=True)
    try:
        insert = service.videos().insert(part="snippet,status", body=body, media_body=video_media)
        response = None
        while response is None:
            _, response = insert.next_chunk()
    finally:
        video_media.stream().close()
    video_id = str((response or {}).get("id") or "")
    if not video_id:
        raise RuntimeError("YouTube upload completed without returning a video ID")

    thumbnail_set = False
    if request.thumbnail_file is not None:
        if not request.thumbnail_file.is_file():
            raise RuntimeError(f"YouTube thumbnail file is missing: {request.thumbnail_file}")
        thumbnail_media = MediaFileUpload(str(request.thumbnail_file), resumable=False)
        try:
            service.thumbnails().set(videoId=video_id, media_body=thumbnail_media).execute()
        finally:
            thumbnail_media.stream().close()
        thumbnail_set = True

    return {
        "video_id": video_id,
        "video_url": f"https://www.youtube.com/watch?v={video_id}",
        "privacy_status": request.privacy_status,
        "thumbnail_set": thumbnail_set,
    }


def result_json(value: dict[str, Any]) -> str:
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"))
