from __future__ import annotations

import argparse
import asyncio
import sys
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Sequence

from conf import BASE_DIR
from uploader.bilibili_uploader.runtime import run_biliup_command
from uploader.douyin_uploader.main import (
    DOUYIN_PUBLISH_STRATEGY_IMMEDIATE,
    DOUYIN_PUBLISH_STRATEGY_SCHEDULED,
    DouYinVideo,
    inspect_recent_publications,
    cookie_auth as douyin_cookie_auth,
    douyin_setup,
)
from uploader.tencent_uploader.main import (
    TENCENT_PUBLISH_STRATEGY_IMMEDIATE,
    TENCENT_PUBLISH_STRATEGY_SCHEDULED,
    TencentVideo,
    cookie_auth as tencent_cookie_auth,
    tencent_setup,
)
from uploader.youtube_uploader.main import (
    YouTubeVideoUploadRequest,
    check_youtube_account,
    login_youtube_account,
    result_json,
    upload_youtube_video,
    youtube_client_secret_file,
)

SCHEDULE_FORMAT = "%Y-%m-%d %H:%M"


@dataclass(slots=True)
class DouyinVideoUploadRequest:
    account_name: str
    video_file: Path
    title: str
    description: str
    tags: list[str]
    publish_date: datetime | int
    thumbnail_file: Path | None = None
    thumbnail_landscape_file: Path | None = None
    thumbnail_portrait_file: Path | None = None
    product_link: str = ""
    product_title: str = ""
    self_declaration: str | None = None
    publish_strategy: str = DOUYIN_PUBLISH_STRATEGY_IMMEDIATE
    debug: bool = False
    headless: bool = True


@dataclass(slots=True)
class BilibiliVideoUploadRequest:
    account_name: str
    video_file: Path
    title: str
    description: str
    tid: int
    tags: list[str]
    publish_date: datetime | int
    cover_file: Path | None = None
    submit_api: str = "app"


@dataclass(slots=True)
class TencentVideoUploadRequest:
    account_name: str
    video_file: Path
    title: str
    description: str
    tags: list[str]
    publish_date: datetime | int
    thumbnail_file: Path | None = None
    thumbnail_landscape_file: Path | None = None
    thumbnail_portrait_file: Path | None = None
    short_title: str | None = None
    category: str | None = None
    is_draft: bool = False
    publish_strategy: str = TENCENT_PUBLISH_STRATEGY_IMMEDIATE
    debug: bool = False
    headless: bool = True


def resolve_account_file(platform: str, account_name: str) -> Path:
    account_file = Path(BASE_DIR) / "cookies" / f"{platform}_{account_name}.json"
    account_file.parent.mkdir(parents=True, exist_ok=True)
    return account_file


def parse_tags(raw_tags: str | None) -> list[str]:
    if not raw_tags:
        return []
    return [cleaned for item in raw_tags.split(",") if (cleaned := item.strip().lstrip("#"))]


def existing_file_path(value: str) -> Path:
    path = Path(value)
    if not path.is_file():
        raise argparse.ArgumentTypeError(f"File not found: {value}")
    return path


def schedule_value(value: str) -> datetime:
    try:
        return datetime.strptime(value, SCHEDULE_FORMAT)
    except ValueError as exc:
        raise argparse.ArgumentTypeError(
            f"Invalid schedule '{value}'. Expected format: {SCHEDULE_FORMAT}"
        ) from exc


def has_interactive_terminal() -> bool:
    return bool(sys.stdin and sys.stdin.isatty() and sys.stdout and sys.stdout.isatty())


def add_runtime_flags(parser: argparse.ArgumentParser) -> None:
    parser.add_argument("--debug", action="store_true", help="Enable debug mode")
    headless_group = parser.add_mutually_exclusive_group()
    headless_group.add_argument("--headed", dest="headless", action="store_false", help="Run with browser UI")
    headless_group.add_argument("--headless", dest="headless", action="store_true", help="Run in headless mode")
    parser.set_defaults(headless=True)


def add_common_video_arguments(parser: argparse.ArgumentParser, platform_name: str) -> None:
    parser.add_argument("--account", required=True, help=f"{platform_name} account alias")
    parser.add_argument("--file", required=True, type=existing_file_path, help="Video file path")
    parser.add_argument("--title", required=True, help="Video title")
    parser.add_argument("--desc", default="", help="Optional video description")
    parser.add_argument("--tags", default="", help="Comma-separated tags")
    parser.add_argument("--schedule", type=schedule_value, help="Schedule time in " + SCHEDULE_FORMAT.replace("%", "%%"))
    parser.add_argument("--thumbnail", type=existing_file_path, help="Optional shared portrait thumbnail")
    parser.add_argument("--thumbnail-landscape", type=existing_file_path, help="Optional landscape thumbnail")
    parser.add_argument("--thumbnail-portrait", type=existing_file_path, help="Optional portrait thumbnail")
    add_runtime_flags(parser)


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="sau", description="Video-platform local social uploader")
    platforms = parser.add_subparsers(dest="platform", required=True)

    douyin_parser = platforms.add_parser("douyin", help="Douyin operations")
    douyin_actions = douyin_parser.add_subparsers(dest="action", required=True)
    for action_name in ("login", "check"):
        action = douyin_actions.add_parser(action_name)
        action.add_argument("--account", required=True)
        if action_name == "login":
            add_runtime_flags(action)
    douyin_upload = douyin_actions.add_parser("upload-video")
    add_common_video_arguments(douyin_upload, "Douyin")
    douyin_upload.add_argument("--product-link", default="")
    douyin_upload.add_argument("--product-title", default="")
    douyin_upload.add_argument("--self-declaration", choices=("内容由AI生成", "内容为个人观点或见解"))
    douyin_inspect = douyin_actions.add_parser("inspect-recent")
    douyin_inspect.add_argument("--account", required=True)
    douyin_inspect.add_argument("--output", required=True, type=Path)

    bilibili_parser = platforms.add_parser("bilibili", help="Bilibili operations")
    bilibili_actions = bilibili_parser.add_subparsers(dest="action", required=True)
    for action_name in ("login", "check"):
        action = bilibili_actions.add_parser(action_name)
        action.add_argument("--account", required=True)
    bilibili_upload = bilibili_actions.add_parser("upload-video")
    bilibili_upload.add_argument("--account", required=True)
    bilibili_upload.add_argument("--file", required=True, type=existing_file_path)
    bilibili_upload.add_argument("--title", required=True)
    bilibili_upload.add_argument("--desc", required=True)
    bilibili_upload.add_argument("--tid", required=True, type=int)
    bilibili_upload.add_argument("--tags", default="")
    bilibili_upload.add_argument("--schedule", type=schedule_value)
    bilibili_upload.add_argument("--cover", type=existing_file_path)
    bilibili_upload.add_argument("--submit", choices=("app", "web", "b-cut-android"), default="app")

    tencent_parser = platforms.add_parser("tencent", help="Tencent/WeChat Channels operations")
    tencent_actions = tencent_parser.add_subparsers(dest="action", required=True)
    for action_name in ("login", "check"):
        action = tencent_actions.add_parser(action_name)
        action.add_argument("--account", required=True)
        if action_name == "login":
            add_runtime_flags(action)
    tencent_upload = tencent_actions.add_parser("upload-video")
    add_common_video_arguments(tencent_upload, "Tencent/WeChat Channels")
    tencent_upload.add_argument("--short-title")
    tencent_upload.add_argument("--category")
    tencent_upload.add_argument("--draft", action="store_true")

    youtube_parser = platforms.add_parser("youtube", help="YouTube Data API operations")
    youtube_actions = youtube_parser.add_subparsers(dest="action", required=True)
    youtube_login = youtube_actions.add_parser("login")
    youtube_login.add_argument("--account", required=True)
    youtube_login.add_argument("--client-secret", type=existing_file_path)
    youtube_check = youtube_actions.add_parser("check")
    youtube_check.add_argument("--account", required=True)
    youtube_upload = youtube_actions.add_parser("upload-video")
    youtube_upload.add_argument("--account", required=True)
    youtube_upload.add_argument("--file", required=True, type=existing_file_path)
    youtube_upload.add_argument("--title", required=True)
    youtube_upload.add_argument("--desc", default="")
    youtube_upload.add_argument("--tags", default="")
    youtube_upload.add_argument("--category-id", default="28")
    youtube_upload.add_argument("--privacy", choices=("private", "unlisted", "public"), default="private")
    youtube_upload.add_argument("--cover", type=existing_file_path)
    return parser


async def check_douyin_account(account_name: str) -> bool:
    account_file = resolve_account_file("douyin", account_name)
    return account_file.exists() and await douyin_cookie_auth(str(account_file))


async def check_bilibili_account(account_name: str) -> bool:
    account_file = resolve_account_file("bilibili", account_name)
    if not account_file.exists():
        return False
    return run_biliup_command(["-u", str(account_file), "renew"]).returncode == 0


async def login_bilibili_account(account_name: str) -> dict:
    account_file = resolve_account_file("bilibili", account_name)
    if not has_interactive_terminal():
        return {
            "success": False,
            "message": (
                "Bilibili login requires a local interactive terminal. "
                f"Run `sau bilibili login --account {account_name}` yourself. "
                "If the terminal QR code is incomplete, open ./qrcode.png and scan it."
            ),
            "account_file": str(account_file),
        }
    result = run_biliup_command(["-u", str(account_file), "login"], interactive=True)
    output = (result.stderr or result.stdout or "").strip()
    return {
        "success": result.returncode == 0,
        "message": output or ("Bilibili login completed" if result.returncode == 0 else "Bilibili login failed"),
        "account_file": str(account_file),
    }


async def check_tencent_account(account_name: str) -> bool:
    account_file = resolve_account_file("tencent", account_name)
    return account_file.exists() and await tencent_cookie_auth(str(account_file))


async def upload_douyin_video(request: DouyinVideoUploadRequest) -> Path:
    account_file = resolve_account_file("douyin", request.account_name)
    if not await douyin_setup(str(account_file), handle=False):
        raise RuntimeError(f"Douyin login state is missing or expired: {account_file}")
    app = DouYinVideo(
        request.title,
        str(request.video_file),
        request.tags,
        request.publish_date,
        str(account_file),
        desc=request.description,
        thumbnail_landscape_path=str(request.thumbnail_landscape_file) if request.thumbnail_landscape_file else None,
        thumbnail_portrait_path=str(request.thumbnail_portrait_file or request.thumbnail_file)
        if request.thumbnail_portrait_file or request.thumbnail_file
        else None,
        productLink=request.product_link,
        productTitle=request.product_title,
        self_declaration=request.self_declaration,
        publish_strategy=request.publish_strategy,
        debug=request.debug,
        headless=request.headless,
    )
    await app.douyin_upload_video()
    return account_file


async def upload_bilibili_video(request: BilibiliVideoUploadRequest) -> Path:
    account_file = resolve_account_file("bilibili", request.account_name)
    if not account_file.exists():
        raise RuntimeError(
            f"Bilibili account file is missing: {account_file}. "
            f"Run `sau bilibili login --account {request.account_name}` first."
        )
    arguments = [
        "-u", str(account_file), "upload", "--submit", request.submit_api,
        str(request.video_file), "--title", request.title, "--desc", request.description,
        "--tid", str(request.tid),
    ]
    if request.cover_file is not None:
        arguments.extend(["--cover", str(request.cover_file)])
    if request.tags:
        arguments.extend(["--tag", ",".join(request.tags)])
    if isinstance(request.publish_date, datetime):
        arguments.extend(["--dtime", str(int(request.publish_date.timestamp()))])
    result = run_biliup_command(arguments)
    if result.returncode != 0:
        raise RuntimeError((result.stderr or result.stdout or "").strip() or "Bilibili upload failed")
    return account_file


async def upload_tencent_video(request: TencentVideoUploadRequest) -> Path:
    account_file = resolve_account_file("tencent", request.account_name)
    if not await tencent_setup(str(account_file), handle=False):
        raise RuntimeError(f"Tencent/WeChat Channels login state is missing or expired: {account_file}")
    app = TencentVideo(
        title=request.title,
        file_path=str(request.video_file),
        tags=request.tags,
        publish_date=request.publish_date,
        account_file=str(account_file),
        category=request.category,
        is_draft=request.is_draft,
        desc=request.description,
        thumbnail_path=str(request.thumbnail_file) if request.thumbnail_file else None,
        thumbnail_landscape_path=str(request.thumbnail_landscape_file) if request.thumbnail_landscape_file else None,
        thumbnail_portrait_path=str(request.thumbnail_portrait_file) if request.thumbnail_portrait_file else None,
        short_title=request.short_title,
        publish_strategy=request.publish_strategy,
        debug=request.debug,
        headless=request.headless,
    )
    await app.tencent_upload_video()
    return account_file


async def dispatch(args: argparse.Namespace) -> int:
    if args.platform == "youtube":
        account_file = resolve_account_file("youtube", args.account)
        if args.action == "login":
            client_secret = args.client_secret or youtube_client_secret_file(Path(BASE_DIR))
            result = await asyncio.to_thread(login_youtube_account, account_file, client_secret)
            print(result_json({"platform": "youtube", "status": "authorized", **result}))
            return 0
        if args.action == "check":
            result = await asyncio.to_thread(check_youtube_account, account_file)
            print(result_json({"platform": "youtube", "status": "valid", **result}))
            return 0
        request = YouTubeVideoUploadRequest(
            account_file=account_file,
            video_file=args.file,
            title=args.title,
            description=args.desc,
            tags=parse_tags(args.tags),
            category_id=args.category_id,
            privacy_status=args.privacy,
            thumbnail_file=args.cover,
        )
        result = await asyncio.to_thread(upload_youtube_video, request)
        print(result_json({"platform": "youtube", "status": "submitted", **result}))
        return 0

    if args.platform == "bilibili":
        if args.action == "login":
            result = await login_bilibili_account(args.account)
            if not result["success"]:
                raise RuntimeError(result["message"])
            print(f"Bilibili login flow completed: {result['account_file']}")
            return 0
        if args.action == "check":
            is_valid = await check_bilibili_account(args.account)
            print("valid" if is_valid else "invalid")
            return 0 if is_valid else 1
        request = BilibiliVideoUploadRequest(
            account_name=args.account,
            video_file=args.file,
            title=args.title,
            description=args.desc,
            tid=args.tid,
            tags=parse_tags(args.tags),
            publish_date=args.schedule or 0,
            cover_file=args.cover,
            submit_api=args.submit,
        )
        await upload_bilibili_video(request)
        print(f"Bilibili video upload submitted: {request.video_file}")
        return 0

    if args.platform == "douyin" and args.action == "inspect-recent":
        account_file = resolve_account_file("douyin", args.account)
        if not account_file.is_file():
            raise RuntimeError("Registered Douyin account state is missing")
        await inspect_recent_publications(account_file, args.output)
        print("Read-only recent publications inspection completed")
        return 0

    if args.action == "login":
        setup = douyin_setup if args.platform == "douyin" else tencent_setup
        account_file = resolve_account_file(args.platform, args.account)
        result = await setup(str(account_file), handle=True, return_detail=True, headless=args.headless)
        if not result["success"]:
            raise RuntimeError(result["message"])
        print(f"{args.platform} login flow completed: {account_file}")
        return 0

    if args.action == "check":
        check = check_douyin_account if args.platform == "douyin" else check_tencent_account
        is_valid = await check(args.account)
        print("valid" if is_valid else "invalid")
        return 0 if is_valid else 1

    if args.platform == "douyin":
        request = DouyinVideoUploadRequest(
            account_name=args.account,
            video_file=args.file,
            title=args.title,
            description=args.desc,
            tags=parse_tags(args.tags),
            publish_date=args.schedule or 0,
            thumbnail_file=args.thumbnail,
            thumbnail_landscape_file=args.thumbnail_landscape,
            thumbnail_portrait_file=args.thumbnail_portrait,
            product_link=args.product_link,
            product_title=args.product_title,
            self_declaration=args.self_declaration,
            publish_strategy=DOUYIN_PUBLISH_STRATEGY_SCHEDULED if args.schedule else DOUYIN_PUBLISH_STRATEGY_IMMEDIATE,
            debug=args.debug,
            headless=args.headless,
        )
        await upload_douyin_video(request)
        print(f"Douyin video upload submitted: {request.video_file}")
        return 0

    request = TencentVideoUploadRequest(
        account_name=args.account,
        video_file=args.file,
        title=args.title,
        description=args.desc,
        tags=parse_tags(args.tags),
        publish_date=args.schedule or 0,
        thumbnail_file=args.thumbnail,
        thumbnail_landscape_file=args.thumbnail_landscape,
        thumbnail_portrait_file=args.thumbnail_portrait,
        short_title=args.short_title,
        category=args.category,
        is_draft=args.draft,
        publish_strategy=TENCENT_PUBLISH_STRATEGY_SCHEDULED if args.schedule else TENCENT_PUBLISH_STRATEGY_IMMEDIATE,
        debug=args.debug,
        headless=args.headless,
    )
    await upload_tencent_video(request)
    print(f"Tencent/WeChat Channels video upload submitted: {request.video_file}")
    return 0


def main(argv: Sequence[str] | None = None) -> int:
    args = build_parser().parse_args(list(argv) if argv is not None else None)
    try:
        return asyncio.run(dispatch(args))
    except Exception as exc:
        print(str(exc), file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
