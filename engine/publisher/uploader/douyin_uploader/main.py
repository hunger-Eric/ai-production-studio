# -*- coding: utf-8 -*-
from datetime import datetime

import asyncio
import inspect
import json
import os
import re
import subprocess
import sys
import time
from pathlib import Path
from urllib.parse import urlsplit

from patchright.async_api import Page
from patchright.async_api import Playwright
from patchright.async_api import async_playwright

from conf import DEBUG_MODE, LOCAL_CHROME_HEADLESS, LOCAL_CHROME_PATH
from uploader.base_video import BaseVideoUploader
from utils.base_social_media import set_init_script
from utils.login_qrcode import build_login_qrcode_path
from utils.login_qrcode import decode_qrcode_from_path
from utils.login_qrcode import print_terminal_qrcode
from utils.login_qrcode import remove_qrcode_file
from utils.login_qrcode import save_data_url_image
from utils.log import douyin_logger

DOUYIN_PUBLISH_STRATEGY_IMMEDIATE = "immediate"
DOUYIN_PUBLISH_STRATEGY_SCHEDULED = "scheduled"
DOUYIN_EDITOR_READY_TIMEOUT_SECONDS = 120
DOUYIN_VIDEO_UPLOAD_TIMEOUT_SECONDS = 600
DOUYIN_PUBLISH_CONFIRM_TIMEOUT_SECONDS = 120
DOUYIN_PUBLISH_SECURITY_GATE_TIMEOUT_SECONDS = 30
DOUYIN_PUBLISH_VERIFICATION_TEXTS = ("接收短信验证码", "请输入当前手机号", "使用原设备扫码", "获取验证码")


async def _video_upload_status(page):
    error = 'div.progress-div > div:has-text("上传失败")'
    ready = '[class^="long-card"] div:has-text("重新上传")'
    return {"failed": await page.locator(error + ":visible").count(), "complete": await page.locator(ready + ":visible").count(),
            "failed_present": await page.locator(error).count(), "complete_present": await page.locator(ready).count()}


class _UploadEvidence:
    """Run-local phase evidence, never credentials, headers, request bodies or signed URLs."""
    def __init__(self):
        directory = os.environ.get("VIDEO_PLATFORM_UPLOAD_EVIDENCE_DIR")
        self.path = Path(directory) / "upload.json" if directory else None
        self.data = {"schema_version": "douyin_upload_phase_evidence.v1", "stage": "not_started", "publish_may_have_been_clicked": False, "network": [], "progress": []}
        if self.path:
            self.path.parent.mkdir(parents=True, exist_ok=True)
            if self.path.exists():
                raise RuntimeError("Existing upload evidence must not be overwritten")

    @staticmethod
    def endpoint(url):
        parsed = urlsplit(url)
        return {"host": parsed.hostname or "", "path": parsed.path[:160]}

    def network(self, request, *, status=None, failure=None):
        endpoint = self.endpoint(request.url)
        if request.resource_type not in ("xhr", "fetch") or not any(part in endpoint["host"] for part in ("douyin", "byted", "snssdk", "volc", "toutiao", "pstatp")):
            return
        self.data["network"].append({**endpoint, "method": request.method, "status": status, "failure": failure})
        self.data["network"] = self.data["network"][-80:]

    def record(self, stage, **values):
        self.data.update(stage=stage, updated_at=datetime.now().astimezone().isoformat(), **values)
        if self.path:
            temporary = self.path.with_suffix(".tmp")
            try:
                temporary.write_text(json.dumps(self.data, ensure_ascii=False, indent=2), encoding="utf-8")
                temporary.replace(self.path)
            except OSError as exc:
                # Diagnostics must not turn an accepted publication into a false upload failure.
                douyin_logger.warning("Run-local upload evidence write failed: " + type(exc).__name__)

    async def failed(self, page, error):
        # Do not persist potentially signed URLs from browser exception messages.
        message = re.sub(r"https?://[^\s\"']+", lambda m: self.endpoint(m.group())['host'] + self.endpoint(m.group())['path'], str(error))
        self.record(self.data["stage"], outcome="failed", error=message[:2000])
        if self.path and page:
            try:
                text = await page.locator("div.progress-div").all_inner_texts()
                self.record(self.data["stage"], progress_text=[s[:1000] for s in text[:8]])
                await page.screenshot(path=str(self.path.with_suffix(".png")), full_page=True)
            except Exception:
                pass


async def inspect_recent_publications(account_file, output):
    """Read the existing account's content manager; never upload or persist a session."""
    target = Path(output)
    if target.exists():
        raise RuntimeError("Existing publication inspection must not be overwritten")
    report = {"schema_version": "douyin_recent_publications.v1", "read_only": True, "responses": [], "checked_at": datetime.now().astimezone().isoformat()}
    async with async_playwright() as playwright:
        browser = await playwright.chromium.launch(headless=True, channel="chrome")
        context = await browser.new_context(storage_state=str(account_file))
        page = await context.new_page()
        tasks = set()
        async def collect(response):
            if urlsplit(response.url).hostname != "creator.douyin.com" or response.request.resource_type not in ("xhr", "fetch"):
                return
            try:
                body = await response.json()
                rows = []
                def visit(value):
                    if isinstance(value, dict):
                        if "aweme_id" in value or ("item_id" in value and ("desc" in value or "title" in value)):
                            rows.append({k: value[k] for k in ("aweme_id", "item_id", "desc", "title", "create_time", "status", "video_status", "duration") if k in value})
                        for v in value.values():
                            visit(v)
                    elif isinstance(value, list):
                        for v in value:
                            visit(v)
                visit(body)
                report["responses"].append({"endpoint": _UploadEvidence.endpoint(response.url), "status": response.status, "keys": list(body)[:30] if isinstance(body, dict) else [], "rows": rows[:40], "pagination": {k: body[k] for k in ("has_more", "max_cursor", "min_cursor", "total", "status_code") if isinstance(body, dict) and k in body}})
            except Exception:
                pass
        def schedule(response):
            task = asyncio.create_task(collect(response)); tasks.add(task); task.add_done_callback(tasks.discard)
        page.on("response", schedule)
        await page.goto("https://creator.douyin.com/creator-micro/content/manage")
        await page.locator("body").wait_for(state="visible", timeout=30000)
        await page.wait_for_timeout(5000)
        if tasks:
            await asyncio.gather(*list(tasks), return_exceptions=True)
        report["url"] = _UploadEvidence.endpoint(page.url)
        report["body_text"] = (await page.locator("body").inner_text())[:14000]
        report["selected_tabs"] = await page.locator('[role="tab"][aria-selected="true"]').all_inner_texts()
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
        await page.screenshot(path=str(target.with_suffix(".png")), full_page=True)
        await context.close()
        await browser.close()


def _msg(emoji: str, text: str) -> str:
    return f"{emoji} {text}"


async def _emit_qrcode_callback(qrcode_callback, payload: dict):
    if not qrcode_callback:
        return

    callback_result = qrcode_callback(payload)
    if inspect.isawaitable(callback_result):
        await callback_result


async def _wait_until(predicate, *, timeout_seconds: float, poll_seconds: float, timeout_message: str):
    try:
        async with asyncio.timeout(timeout_seconds):
            while not await predicate():
                await asyncio.sleep(poll_seconds)
    except TimeoutError as error:
        raise RuntimeError(timeout_message) from error


async def _wait_for_publication_readback(page: Page, *, timeout_seconds: float) -> bool:
    async def publication_redirected():
        return page.url.startswith("https://creator.douyin.com/creator-micro/content/manage")

    await _wait_until(
        publication_redirected,
        timeout_seconds=timeout_seconds,
        poll_seconds=1,
        timeout_message="Timed out waiting for Douyin publication redirect",
    )
    return True


async def _wait_for_post_publish_gate(page: Page, *, timeout_seconds: float) -> str | None:
    gate: str | None = None

    async def post_publish_gate_visible():
        nonlocal gate
        if page.url.startswith("https://creator.douyin.com/creator-micro/content/manage"):
            gate = "content_manage"
            return True
        try:
            body_text = await page.locator("body").inner_text(timeout=2000)
        except Exception:
            return False
        if any(text in body_text for text in DOUYIN_PUBLISH_VERIFICATION_TEXTS):
            gate = "verification"
            return True
        return False

    try:
        await _wait_until(
            post_publish_gate_visible,
            timeout_seconds=timeout_seconds,
            poll_seconds=0.5,
            timeout_message="Timed out waiting for Douyin post-publish gate",
        )
    except RuntimeError:
        return None
    return gate


def _build_login_result(success: bool, status: str, message: str, account_file: str, qrcode: dict | None = None, current_url: str = "") -> dict:
    return {
        "success": success,
        "status": status,
        "message": message,
        "account_file": str(account_file),
        "qrcode": qrcode,
        "current_url": current_url,
    }


async def cookie_auth(account_file):
    async with async_playwright() as playwright:
        browser = await playwright.chromium.launch(headless=True, channel="chrome")
        try:
            context = await browser.new_context(storage_state=account_file)
            context = await set_init_script(context)
            page = await context.new_page()
            await page.goto("https://creator.douyin.com/creator-micro/content/upload")
            try:
                await page.wait_for_url("https://creator.douyin.com/creator-micro/content/upload", timeout=5000)
            except Exception:
                return False

            if await page.get_by_text("手机号登录").count() or await page.get_by_text("扫码登录").count():
                return False

            return True
        finally:
            await browser.close()


async def douyin_setup(account_file, handle=False, return_detail=False, qrcode_callback=None, headless: bool = LOCAL_CHROME_HEADLESS):
    if not os.path.exists(account_file) or not await cookie_auth(account_file):
        if not handle:
            result = _build_login_result(False, "cookie_invalid", "cookie文件不存在或已失效", account_file)
            return result if return_detail else False
        douyin_logger.info(_msg("🥹", "cookie 失效了，准备打开浏览器重新登录"))
        result = await douyin_cookie_gen(account_file, qrcode_callback=qrcode_callback, headless=headless)
        return result if return_detail else result["success"]

    result = _build_login_result(True, "cookie_valid", "cookie有效", account_file)
    return result if return_detail else True


async def _extract_douyin_qrcode_src(page: Page) -> str:
    scan_login_tab = page.get_by_text("扫码登录", exact=True).first
    await scan_login_tab.wait_for(timeout=30000)

    qrcode_img = (
        scan_login_tab
        .locator("..")
        .locator("xpath=following-sibling::div[1]")
        .locator('img[aria-label="二维码"]')
        .first
    )

    if not await qrcode_img.count():
        qrcode_img = page.get_by_role("img", name="二维码").first

    await qrcode_img.wait_for(state="visible", timeout=30000)
    src = await qrcode_img.get_attribute("src")
    if not src:
        raise RuntimeError("未获取到抖音登录二维码地址")

    return src


async def _save_douyin_qrcode(page: Page, account_file: str, previous_qrcode_path: Path | None = None, qrcode_callback=None) -> dict:
    qrcode_src = await _extract_douyin_qrcode_src(page)
    qrcode_path = save_data_url_image(qrcode_src, build_login_qrcode_path(account_file))
    if previous_qrcode_path and previous_qrcode_path != qrcode_path:
        if remove_qrcode_file(previous_qrcode_path):
            douyin_logger.info(_msg("🧹", f"临时二维码文件已清理: {previous_qrcode_path}"))
    douyin_logger.info(_msg("🖼️", f"二维码已经准备好啦，已保存到: {qrcode_path}"))
    qrcode_content = decode_qrcode_from_path(qrcode_path)
    if qrcode_content:
        print_terminal_qrcode(qrcode_content, qrcode_path, "抖音APP")
    else:
        douyin_logger.warning(_msg("😵", f"终端没法完整显示二维码，请打开 {qrcode_path} 扫码"))
    qrcode_info = {
        "image_path": str(qrcode_path),
        "image_data_url": qrcode_src,
    }
    await _emit_qrcode_callback(qrcode_callback, qrcode_info)
    return qrcode_info


async def _is_douyin_login_completed(page: Page) -> bool:
    if not page.url.startswith("https://creator.douyin.com/creator-micro/home"):
        return False

    login_markers = [
        page.get_by_text("扫码登录", exact=True).first,
        page.get_by_text("手机号登录", exact=True).first,
        page.get_by_text("二维码失效", exact=True).first,
        page.get_by_role("img", name="二维码").first,
    ]

    for marker in login_markers:
        if not await marker.count():
            continue
        try:
            if await marker.is_visible():
                return False
        except Exception:
            continue

    return True


async def _wait_for_douyin_login(page: Page, account_file: str, qrcode_info: dict, qrcode_callback=None, poll_interval: int = 3, max_checks: int = 100) -> dict:
    qrcode_path = Path(qrcode_info["image_path"])
    for _ in range(max_checks):
        if await _is_douyin_login_completed(page):
            douyin_logger.info(_msg("🥳", f"扫码成功，已经跳转到登录后页面: {page.url}"))
            return _build_login_result(True, "success", "抖音扫码登录成功", account_file, qrcode_info, page.url)

        expired_box = page.get_by_text("二维码失效", exact=True).locator("..").first
        if await expired_box.count() and await expired_box.is_visible():
            douyin_logger.warning(_msg("😵", "二维码失效了，小人马上去刷新"))
            await expired_box.click()
            await asyncio.sleep(1)
            qrcode_info = await _save_douyin_qrcode(page, account_file, qrcode_path, qrcode_callback=qrcode_callback)
            qrcode_path = Path(qrcode_info["image_path"])

        await asyncio.sleep(poll_interval)

    return _build_login_result(False, "timeout", "等待抖音扫码登录超时", account_file, qrcode_info, page.url)


async def douyin_cookie_gen(
    account_file,
    qrcode_callback=None,
    poll_interval: int = 3,
    max_checks: int = 100,
    headless: bool = LOCAL_CHROME_HEADLESS,
):
    async with async_playwright() as playwright:
        browser = await playwright.chromium.launch(headless=headless, channel="chrome")
        context = await browser.new_context()
        context = await set_init_script(context)
        qrcode_path = None
        result = _build_login_result(False, "failed", "抖音登录失败", account_file)
        try:
            page = await context.new_page()
            await page.goto("https://creator.douyin.com/")
            qrcode_info = await _save_douyin_qrcode(page, account_file, qrcode_callback=qrcode_callback)
            qrcode_path = Path(qrcode_info["image_path"])
            douyin_logger.info(_msg("🧍", "请扫码，小人正在耐心等待登录完成"))
            result = await _wait_for_douyin_login(
                page,
                account_file,
                qrcode_info,
                qrcode_callback=qrcode_callback,
                poll_interval=poll_interval,
                max_checks=max_checks,
            )
            if result["success"]:
                await asyncio.sleep(2)
                await context.storage_state(path=account_file)
                if not await cookie_auth(account_file):
                    result = _build_login_result(
                        False,
                        "cookie_invalid",
                        "抖音扫码流程结束，但 cookie 校验失败",
                        account_file,
                        qrcode_info,
                        page.url,
                    )
        except Exception as exc:
            result = _build_login_result(False, "failed", str(exc), account_file, current_url=page.url if "page" in locals() else "")
        finally:
            if remove_qrcode_file(qrcode_path):
                douyin_logger.info(_msg("🧹", f"临时二维码文件已清理: {qrcode_path}"))
            if not result["success"]:
                douyin_logger.error(_msg("😢", f"登录失败: {result['message']}"))
            await context.close()
            await browser.close()
        return result


class DouYinBaseUploader(BaseVideoUploader):
    def __init__(
        self,
        publish_date: datetime | int,
        account_file,
        publish_strategy: str = DOUYIN_PUBLISH_STRATEGY_IMMEDIATE,
        debug: bool = DEBUG_MODE,
        headless: bool = LOCAL_CHROME_HEADLESS,
    ):
        self.publish_date = publish_date
        self.account_file = account_file
        self.publish_strategy = publish_strategy
        self.debug = debug
        self.date_format = "%Y年%m月%d日 %H:%M"
        self.local_executable_path = LOCAL_CHROME_PATH
        self.headless = headless

    async def validate_base_args(self):
        if not os.path.exists(self.account_file):
            raise RuntimeError(f"cookie文件不存在，请先完成抖音登录: {self.account_file}")
        if not await cookie_auth(self.account_file):
            raise RuntimeError(f"cookie文件已失效，请先完成抖音登录: {self.account_file}")
        if self.publish_strategy not in {DOUYIN_PUBLISH_STRATEGY_IMMEDIATE, DOUYIN_PUBLISH_STRATEGY_SCHEDULED}:
            raise ValueError(f"不支持的发布策略: {self.publish_strategy}")

        if self.publish_strategy == DOUYIN_PUBLISH_STRATEGY_SCHEDULED:
            self.publish_date = self.validate_publish_date(self.publish_date)
        else:
            self.publish_date = 0

    async def set_schedule_time_douyin(self, page, publish_date):
        label_element = page.locator("[class^='radio']:has-text('定时发布')")
        await label_element.click()
        await asyncio.sleep(1)
        publish_date_hour = publish_date.strftime("%Y-%m-%d %H:%M")

        await asyncio.sleep(1)
        await page.locator('.semi-input[placeholder="日期和时间"]').click()
        await page.keyboard.press("Control+KeyA")
        await page.keyboard.type(str(publish_date_hour))
        await page.keyboard.press("Enter")
        await asyncio.sleep(1)

    async def fill_title_and_description(self, page: Page, title: str, description: str, tags: list[str] | None = None):
        submitted_description = description + "".join(" #" + tag + " " for tag in tags or [])
        submitted_units = len(submitted_description.encode("utf-16-le")) // 2
        if submitted_units > 1000:
            raise ValueError("抖音作品描述含话题超过1000个UTF-16字符，禁止截断提交")
        try:
            description_section = (
                page.get_by_text("作品描述", exact=True)
                .locator("xpath=ancestor::div[2]")
                .locator("xpath=following-sibling::div[1]")
            )

            title_input = description_section.locator('input[type="text"]').first
            await title_input.wait_for(state="visible", timeout=10000)
            await title_input.fill(title[:30])

            description_editor = description_section.locator('.zone-container[contenteditable="true"]').first
            await description_editor.wait_for(state="visible", timeout=10000)
        except Exception as primary_error:
            douyin_logger.warning(_msg("🧭", f"作品描述固定结构未命中，改用新版发布页兜底定位: {primary_error}"))
            title_input = await self.first_visible_locator(
                page,
                [
                    'input[placeholder*="标题"]',
                    'input[placeholder*="请输入"]',
                    'input.semi-input[type="text"]',
                    'input[type="text"]',
                ],
                timeout=12000,
            )
            await title_input.fill(title[:30])
            description_editor = await self.first_visible_locator(
                page,
                [
                    '[contenteditable="true"][data-placeholder*="描述"]',
                    '[contenteditable="true"][placeholder*="描述"]',
                    '.zone-container[contenteditable="true"]',
                    '[contenteditable="true"]',
                ],
                timeout=12000,
            )

        await description_editor.click()
        await page.keyboard.press("Control+KeyA")
        await page.keyboard.press("Delete")
        await page.keyboard.type(description)

        for tag in tags or []:
            await page.keyboard.type(" #" + tag)
            await page.keyboard.press("Space")

        # Account health restrictions may lower the current editor's capacity.
        editor_context = await description_editor.locator("xpath=../../..").inner_text()
        counters = re.findall(r"(?<!\d)(\d+)\s*/\s*(\d+)(?!\d)", editor_context)
        if counters and submitted_units > max(int(limit) for _, limit in counters):
            raise RuntimeError("抖音当前编辑器描述容量不足，禁止截断提交")
        normalize = lambda value: " ".join(value.replace("\u200b", "").replace("\ufeff", "").split())
        actual = normalize(await description_editor.inner_text())
        if not actual.startswith(normalize(description)) or any("#" + tag not in actual for tag in tags or []):
            raise RuntimeError("抖音描述回读不完整，正文、音乐署名或话题发生截断；禁止发布")
        douyin_logger.info(_msg("📝", f"完整描述及话题回读通过：{submitted_units}/1000 UTF-16字符"))

    async def first_visible_locator(self, page: Page, selectors: list[str], timeout: int = 10000):
        deadline = time.monotonic() + timeout / 1000
        last_error = None
        while time.monotonic() < deadline:
            for selector in selectors:
                locator = page.locator(selector)
                try:
                    count = await locator.count()
                except Exception as exc:
                    last_error = exc
                    continue
                for index in range(count):
                    candidate = locator.nth(index)
                    try:
                        if await candidate.is_visible():
                            box = await candidate.bounding_box()
                            if box and box.get("width", 0) > 0 and box.get("height", 0) > 0:
                                return candidate
                    except Exception as exc:
                        last_error = exc
            await asyncio.sleep(0.25)
        raise RuntimeError(f"could not find visible locator from {selectors}: {last_error}")

    async def set_location(self, page: Page, location: str = ""):
        if not location:
            return
        await page.locator('div.semi-select span:has-text("输入地理位置")').click()
        await page.keyboard.press("Backspace")
        await page.wait_for_timeout(2000)
        await page.keyboard.type(location)
        await page.wait_for_selector('div[role="listbox"] [role="option"]', timeout=5000)
        await page.locator('div[role="listbox"] [role="option"]').first.click()

    async def handle_product_dialog(self, page: Page, product_title: str):
        await page.wait_for_timeout(2000)
        await page.wait_for_selector('input[placeholder="请输入商品短标题"]', timeout=10000)
        short_title_input = page.locator('input[placeholder="请输入商品短标题"]')
        if not await short_title_input.count():
            douyin_logger.error(_msg("😵", "没找到商品短标题输入框"))
            return False

        product_title = product_title[:10]
        await short_title_input.fill(product_title)
        await page.wait_for_timeout(1000)

        finish_button = page.locator('button:has-text("完成编辑")')
        if "disabled" not in await finish_button.get_attribute("class"):
            await finish_button.click()
            douyin_logger.debug(_msg("🥳", "已点击“完成编辑”按钮"))
            await page.wait_for_selector(".semi-modal-content", state="hidden", timeout=5000)
            return True

        douyin_logger.error(_msg("😵", "“完成编辑”按钮是灰的，小人先把弹窗关掉"))
        cancel_button = page.locator('button:has-text("取消")')
        if await cancel_button.count():
            await cancel_button.click()
        else:
            close_button = page.locator(".semi-modal-close")
            await close_button.click()
        await page.wait_for_selector(".semi-modal-content", state="hidden", timeout=5000)
        return False

    async def set_product_link(self, page: Page, product_link: str, product_title: str):
        await page.wait_for_timeout(2000)
        try:
            await page.wait_for_selector("text=添加标签", timeout=10000)
            dropdown = page.get_by_text("添加标签").locator("..").locator("..").locator("..").locator(".semi-select").first
            if not await dropdown.count():
                douyin_logger.error(_msg("😵", "没找到标签下拉框"))
                return False
            douyin_logger.debug(_msg("🧍", "找到标签下拉框，小人准备选择“购物车”"))
            await dropdown.click()
            await page.wait_for_selector('[role="listbox"]', timeout=5000)
            await page.locator('[role="option"]:has-text("购物车")').click()
            douyin_logger.debug(_msg("🥳", "已经选中“购物车”"))

            await page.wait_for_selector('input[placeholder="粘贴商品链接"]', timeout=5000)
            input_field = page.locator('input[placeholder="粘贴商品链接"]')
            await input_field.fill(product_link)
            douyin_logger.debug(_msg("🔗", f"商品链接已经填好了: {product_link}"))

            add_button = page.locator('span:has-text("添加链接")')
            button_class = await add_button.get_attribute("class")
            if "disable" in button_class:
                douyin_logger.error(_msg("😵", "“添加链接”按钮现在点不了"))
                return False
            await add_button.click()
            douyin_logger.debug(_msg("🥳", "已点击“添加链接”按钮"))

            await page.wait_for_timeout(2000)
            error_modal = page.locator("text=未搜索到对应商品")
            if await error_modal.count():
                confirm_button = page.locator('button:has-text("确定")')
                await confirm_button.click()
                douyin_logger.error(_msg("😢", "这个商品链接无效"))
                return False

            if not await self.handle_product_dialog(page, product_title):
                return False

            douyin_logger.debug(_msg("🥳", "商品链接设置好了"))
            return True
        except Exception as e:
            douyin_logger.error(_msg("😢", f"设置商品链接时出错: {str(e)}"))
            return False

    async def set_self_declaration(self, page: Page, declaration: str = "内容为个人观点或见解", *, required: bool = False) -> None:
        """抖音「自主声明」为发布必选项：打开声明弹窗 → 选指定类型 → 确定。

        入口和弹窗都是异步渲染。普通兼容调用等不到时记 warning；当上层冻结了
        required 声明时必须在点击发布前失败，不能无声明继续提交。
        """
        try:
            # 发布页底部「自主声明」行，未选时显示占位文案「请选择自主声明」
            entry = page.get_by_text("请选择自主声明").first
            await entry.wait_for(state="visible", timeout=6000)
            await entry.click()

            # 弹窗标题「对作品内容添加声明」
            dialog = page.locator(".semi-modal-content").filter(has_text="对作品内容添加声明").first
            await dialog.wait_for(state="visible", timeout=6000)

            # 单选项：Semi 的文字是 .semi-radio-addon（常带 pointer-events:none，直接点会卡 30s 超时），
            # 要点可交互的 .semi-radio 外层；找不到外层再退回 force 强制点文字。exact 避免误命中预览「作者声明：…」。
            option = dialog.locator(".semi-radio").filter(has_text=declaration).first
            if await option.count():
                await option.click(timeout=6000)
            else:
                await dialog.get_by_text(declaration, exact=True).first.click(timeout=6000, force=True)
            await dialog.get_by_role("button", name="确定").click(timeout=6000)
            await dialog.wait_for(state="hidden", timeout=6000)
            douyin_logger.info(_msg("🧾", f"自主声明已选择「{declaration}」"))
        except Exception as exc:
            if required:
                raise RuntimeError(f"抖音自主声明未能设置为「{declaration}」") from exc
            douyin_logger.warning(_msg("🧾", f"自主声明设置失败，跳过该步骤继续发布：{exc}"))


class DouYinVideo(DouYinBaseUploader):
    def __init__(
        self,
        title,
        file_path,
        tags,
        publish_date: datetime | int,
        account_file,
        thumbnail_landscape_path=None,
        productLink="",
        productTitle="",
        thumbnail_portrait_path=None,
        desc: str | None = None,
        self_declaration: str | None = None,
        publish_strategy: str = DOUYIN_PUBLISH_STRATEGY_IMMEDIATE,
        debug: bool = DEBUG_MODE,
        headless: bool = LOCAL_CHROME_HEADLESS,
    ):
        super().__init__(
            publish_date=publish_date,
            account_file=account_file,
            publish_strategy=publish_strategy,
            debug=debug,
            headless=headless,
        )
        self.title = title
        self.file_path = file_path
        self.tags = tags
        self.thumbnail_landscape_path = thumbnail_landscape_path
        self.thumbnail_portrait_path = thumbnail_portrait_path
        self.productLink = productLink
        self.productTitle = productTitle
        self.desc = desc or ""
        self.self_declaration = self_declaration

    async def validate_upload_args(self):
        await self.validate_base_args()
        if not self.title or not str(self.title).strip():
            raise ValueError("视频模式下，title 是必须的")

        self.file_path = str(self.validate_video_file(self.file_path))
        if self.thumbnail_landscape_path:
            self.thumbnail_landscape_path = str(self.validate_image_file(self.thumbnail_landscape_path))
        if self.thumbnail_portrait_path:
            self.thumbnail_portrait_path = str(self.validate_image_file(self.thumbnail_portrait_path))

    async def dismiss_blocking_guides(self, page: Page):
        """Close transient Douyin guide overlays before clicking editor controls."""
        await page.keyboard.press("Escape")
        await page.wait_for_timeout(300)
        for text in ("知道了", "我知道了", "跳过", "暂不体验", "关闭"):
            locator = page.get_by_text(text, exact=True).first
            try:
                if await locator.count() and await locator.is_visible():
                    await locator.click(timeout=1000)
                    await page.wait_for_timeout(300)
            except Exception:
                pass
        await page.evaluate(
            """
            () => {
              for (const selector of [
                '.shepherd-element',
                '.douyin-creator-pc-master__wrap',
                '[data-douyin-creator-pc-master-shepherd-step-id]'
              ]) {
                document.querySelectorAll(selector).forEach((el) => el.remove());
              }
            }
            """
        )

    async def open_thumbnail_dialog(self, page: Page):
        await self.dismiss_blocking_guides(page)
        cover_locator_str = 'div[id*="creator-content-modal"], div[class*="semi-modal"], div[role="dialog"]'

        selector_candidates = [
            'button:has-text("选择封面")',
            'button:has-text("设置封面")',
            '[role="button"]:has-text("选择封面")',
            '[role="button"]:has-text("设置封面")',
            'div[class*="cover"]:has-text("选择封面")',
            'div[class*="cover"]:has-text("设置封面")',
            'text="选择封面"',
            'text="设置封面"',
        ]
        for selector in selector_candidates:
            locator = page.locator(selector)
            try:
                count = await locator.count()
            except Exception:
                continue
            for index in reversed(range(count)):
                candidate = locator.nth(index)
                try:
                    if not await candidate.is_visible():
                        continue
                    await candidate.scroll_into_view_if_needed(timeout=1000)
                    await candidate.click(force=True, timeout=3000)
                    await page.wait_for_selector(cover_locator_str, state="visible", timeout=3000)
                    return page.locator(cover_locator_str).first
                except Exception:
                    await self.dismiss_blocking_guides(page)
                    continue

        # Current Douyin creator pages sometimes render the cover entry as a styled
        # div/span rather than an accessible button. Fall back to a DOM text click
        # and prefer elements near preview/cover controls, not the right-side
        # assistant suggestion text.
        clicked = await page.evaluate(
            """
            () => {
              const visible = (el) => {
                const r = el.getBoundingClientRect();
                const s = getComputedStyle(el);
                return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none';
              };
              const texts = ['设置封面', '选择封面'];
              const candidates = Array.from(document.querySelectorAll('button, [role="button"], div, span'))
                .filter((el) => visible(el) && texts.some((t) => (el.innerText || el.textContent || '').trim().includes(t)))
                .filter((el) => {
                  const text = (el.innerText || el.textContent || '').trim();
                  if (text.includes('封面优化建议') || text.includes('横/竖双封面缺失')) return false;
                  const r = el.getBoundingClientRect();
                  // Prefer main editor area; right assistant panel is usually far right.
                  return r.left < window.innerWidth * 0.82;
                });
              candidates.sort((a, b) => {
                const ar = a.getBoundingClientRect(), br = b.getBoundingClientRect();
                return (br.top - ar.top) || (br.left - ar.left);
              });
              const el = candidates[0];
              if (!el) return false;
              el.scrollIntoView({block:'center', inline:'center'});
              el.click();
              return true;
            }
            """
        )
        if clicked:
            try:
                await page.wait_for_selector(cover_locator_str, state="visible", timeout=5000)
                return page.locator(cover_locator_str).first
            except Exception:
                pass

        debug_path = Path(self.account_file).parent.parent / "douyin_cover_entry_not_found.png"
        try:
            await page.screenshot(path=str(debug_path), full_page=True)
        except Exception:
            pass
        raise RuntimeError(f"Could not open Douyin thumbnail dialog; screenshot={debug_path}")

    async def set_thumbnail(self, page: Page):
        if not self.thumbnail_landscape_path and not self.thumbnail_portrait_path:
            return

        douyin_logger.info(_msg("🏃", "小人正在设置视频封面"))
        cover_locator = await self.open_thumbnail_dialog(page)

        upload_input = cover_locator.locator(
            "div[class^='semi-upload upload'] >> input.semi-upload-hidden-input, input[type='file']"
        ).first

        if self.thumbnail_landscape_path:
            await page.wait_for_timeout(1000)
            await upload_input.set_input_files(self.thumbnail_landscape_path)
            await page.wait_for_timeout(2000)
            douyin_logger.info(_msg("🖼️", "横版封面上传完成"))

        if self.thumbnail_portrait_path:
            await cover_locator.locator("div[class*='steps'] div").nth(1).click()
            await page.wait_for_timeout(1000)
            await upload_input.set_input_files(self.thumbnail_portrait_path)
            await page.wait_for_timeout(2000)
            douyin_logger.info(_msg("🖼️", "竖版封面上传完成"))

        await cover_locator.locator('button:visible:has-text("完成")').click()
        douyin_logger.info(_msg("🥳", "视频封面设置完成"))
        await page.wait_for_selector("div.extractFooter", state="detached")

    async def handle_sms_verification_if_present(self, page: Page) -> bool:
        """Handle Douyin publish-time SMS challenge by waiting for a human code."""
        gate = await _wait_for_post_publish_gate(
            page,
            timeout_seconds=DOUYIN_PUBLISH_SECURITY_GATE_TIMEOUT_SECONDS,
        )
        if gate != "verification":
            return False

        debug_path = Path(self.account_file).parent.parent / "douyin_sms_verification_required.png"
        try:
            await page.screenshot(path=str(debug_path), full_page=True)
        except Exception:
            pass
        douyin_logger.warning(_msg("📱", f"发布触发短信验证，截图已保存: {debug_path}"))

        # Ask Douyin to send the SMS when the button is available.
        for text in ("获取验证码", "重新获取"):
            button = page.get_by_text(text, exact=True).first
            try:
                if await button.count() and await button.is_visible():
                    await button.click(timeout=3000)
                    await page.wait_for_timeout(1000)
                    break
            except Exception:
                pass

        print("\n[Douyin SMS Verification]")
        print("抖音发布需要短信验证码。请查看手机号 199******48 收到的验证码。")
        print(f"页面截图: {debug_path}")
        code_file = Path(self.account_file).parent.parent / "douyin_sms_code.txt"
        code = ""
        if sys.stdin and sys.stdin.isatty():
            code = (await asyncio.to_thread(input, "请输入短信验证码后回车；如果要取消请输入 cancel: ")).strip()
        else:
            prompt = (
                "抖音发布需要短信验证码。\\n"
                "请查看手机号 199******48 收到的验证码并输入。\\n\\n"
                f"页面截图：{debug_path}"
            )
            ps = (
                "Add-Type -AssemblyName Microsoft.VisualBasic; "
                f"[Microsoft.VisualBasic.Interaction]::InputBox('{prompt}', '抖音短信验证码', '')"
            )
            try:
                result = await asyncio.to_thread(
                    lambda: subprocess.run(
                        ["powershell.exe", "-NoProfile", "-STA", "-Command", ps],
                        capture_output=True,
                        text=True,
                        timeout=600,
                    )
                )
                code = (result.stdout or "").strip()
            except Exception:
                code = ""
            if not code and code_file.exists():
                code = code_file.read_text(encoding="utf-8").strip()
                try:
                    code_file.unlink()
                except Exception:
                    pass
        if not code or code.lower() in {"cancel", "取消", "q", "quit"}:
            raise RuntimeError("Douyin SMS verification cancelled by user")

        filled = False
        input_candidates = [
            'input[placeholder*="验证码"]',
            'input[maxlength="6"]',
            'input[maxlength="4"]',
            'input[type="text"]',
            'input',
        ]
        for selector in input_candidates:
            locator = page.locator(selector)
            try:
                count = await locator.count()
            except Exception:
                continue
            for index in reversed(range(count)):
                candidate = locator.nth(index)
                try:
                    if not await candidate.is_visible():
                        continue
                    await candidate.fill(code, timeout=3000)
                    filled = True
                    break
                except Exception:
                    continue
            if filled:
                break

        if not filled:
            raise RuntimeError("Could not fill Douyin SMS verification code input")

        for text in ("验证", "确定", "提交"):
            button = page.get_by_text(text, exact=True).first
            try:
                if await button.count() and await button.is_visible():
                    await button.click(timeout=5000)
                    await page.wait_for_timeout(2000)
                    douyin_logger.info(_msg("📱", "短信验证码已提交"))
                    return True
            except Exception:
                pass

        raise RuntimeError("Could not click Douyin SMS verification submit button")

    async def upload(self, playwright: Playwright) -> None:
        douyin_logger.info(_msg("🧍", "小人先检查 cookie、视频文件、封面和发布时间"))
        await self.validate_upload_args()
        douyin_logger.info(_msg("🥳", "上传前检查通过"))

        browser = await playwright.chromium.launch(headless=self.headless, channel="chrome")
        context = await browser.new_context(
            storage_state=f"{self.account_file}",
            permissions=["geolocation"],
        )
        context = await set_init_script(context)

        page = await context.new_page()
        evidence = getattr(self, "_upload_evidence", None)
        if evidence:
            self._diagnostic_page = page
            page.on("requestfailed", lambda request: evidence.network(request, failure=request.failure))
            page.on("response", lambda response: evidence.network(response.request, status=response.status))
            evidence.record("file_upload")
        await page.goto("https://creator.douyin.com/creator-micro/content/upload")
        douyin_logger.info(_msg("🏃", f"小人开始搬运视频: {self.title}.mp4"))
        douyin_logger.info(_msg("🧭", "小人正在赶往上传主页"))
        await page.wait_for_url("https://creator.douyin.com/creator-micro/content/upload")
        await page.locator("div[class^='container'] input").set_input_files(self.file_path)

        publish_urls = (
            "https://creator.douyin.com/creator-micro/content/publish?enter_from=publish_page",
            "https://creator.douyin.com/creator-micro/content/post/video?enter_from=publish_page",
        )

        async def editor_is_ready():
            return page.url in publish_urls

        await _wait_until(
            editor_is_ready,
            timeout_seconds=DOUYIN_EDITOR_READY_TIMEOUT_SECONDS,
            poll_seconds=0.5,
            timeout_message="Timed out waiting for the Douyin video editor",
        )
        douyin_logger.info(_msg("🥳", "已经进入视频发布页面"))

        await asyncio.sleep(1)
        douyin_logger.info(_msg("✍️", "小人开始填标题、描述和话题"))
        await self.fill_title_and_description(page, self.title, self.desc or self.title, self.tags)
        douyin_logger.info(_msg("🏷️", f"小人一共贴了 {len(self.tags)} 个话题"))

        async def video_upload_is_complete():
            status = await _video_upload_status(page)
            if evidence and (not evidence.data["progress"] or evidence.data["progress"][-1]["status"] != status):
                evidence.data["progress"].append({"at": datetime.now().astimezone().isoformat(), "status": status})
                evidence.record("file_upload")
            if status["failed"]:
                raise RuntimeError("Douyin reported that the video upload failed; automatic retry is disabled")
            return status["complete"] > 0

        await _wait_until(
            video_upload_is_complete,
            timeout_seconds=DOUYIN_VIDEO_UPLOAD_TIMEOUT_SECONDS,
            poll_seconds=2,
            timeout_message="Timed out waiting for the Douyin video upload to complete",
        )
        douyin_logger.success(_msg("🥳", "视频已经传完啦"))
        if evidence:
            evidence.record("file_upload_complete")

        if self.productLink and self.productTitle:
            douyin_logger.info(_msg("🛒", "小人正在设置商品链接"))
            await self.set_product_link(page, self.productLink, self.productTitle)
            douyin_logger.info(_msg("🥳", "商品链接设置完成"))

        await self.set_thumbnail(page)

        await self.set_self_declaration(
            page,
            self.self_declaration or "内容为个人观点或见解",
            required=self.self_declaration is not None,
        )

        third_part_element = '[class^="info"] > [class^="first-part"] div div.semi-switch'
        if await page.locator(third_part_element).count():
            if "semi-switch-checked" not in await page.eval_on_selector(third_part_element, "div => div.className"):
                await page.locator(third_part_element).locator("input.semi-switch-native-control").click()

        if self.publish_strategy == DOUYIN_PUBLISH_STRATEGY_SCHEDULED and self.publish_date != 0:
            await self.set_schedule_time_douyin(page, self.publish_date)

        publish_button = page.get_by_role("button", name="发布", exact=True)
        if not await publish_button.count():
            raise RuntimeError("Douyin publish button is unavailable")
        douyin_logger.info(_msg("🚀", "准备点击发布"))
        if evidence:
            evidence.record("publish_click_pending", publish_may_have_been_clicked=True)
        try:
            await publish_button.click(force=True, timeout=8000)
        except Exception:
            clicked = await page.evaluate(
                """
                () => {
                  const visible = (el) => {
                    const r = el.getBoundingClientRect();
                    const s = getComputedStyle(el);
                    return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none';
                  };
                  const buttons = Array.from(document.querySelectorAll('button, [role="button"], div, span'))
                    .filter((el) => visible(el) && (el.innerText || el.textContent || '').trim() === '发布');
                  const el = buttons.pop();
                  if (!el) return false;
                  el.scrollIntoView({block:'center', inline:'center'});
                  el.click();
                  return true;
                }
                """
            )
            if not clicked:
                debug_path = Path(self.account_file).parent.parent / "douyin_publish_button_click_failed.png"
                try:
                    await page.screenshot(path=str(debug_path), full_page=True)
                except Exception:
                    pass
                raise RuntimeError(f"Could not click Douyin publish button; screenshot={debug_path}")
        douyin_logger.info(_msg("🚀", "已点击发布"))

        # Some accounts/pages show a second confirmation dialog after the first publish click.
        for text in ("发布", "确定", "确认发布"):
            confirm_button = page.get_by_text(text, exact=True).last
            try:
                if await confirm_button.count() and await confirm_button.is_visible():
                    await confirm_button.click(force=True, timeout=5000)
                    await page.wait_for_timeout(1000)
                    douyin_logger.info(_msg("🚀", f"已处理发布二次确认：{text}"))
                    break
            except Exception:
                pass

        await self.handle_sms_verification_if_present(page)
        try:
            await _wait_for_publication_readback(
                page,
                timeout_seconds=DOUYIN_PUBLISH_CONFIRM_TIMEOUT_SECONDS,
            )
        except RuntimeError as exc:
            debug_path = Path(self.account_file).parent.parent / "douyin_publication_readback_failed.png"
            try:
                await page.screenshot(path=str(debug_path), full_page=True)
            except Exception:
                pass
            raise RuntimeError(f"Douyin publication was not confirmed by content-management readback; screenshot={debug_path}") from exc
        douyin_logger.success(_msg("🥳", "视频发布后已进入内容管理页"))
        if evidence:
            evidence.record("publication_readback", outcome="submitted_unverified")

        await context.storage_state(path=self.account_file)
        douyin_logger.success(_msg("🥳", "cookie 更新完毕"))
        await asyncio.sleep(2)
        await context.close()
        await browser.close()

    async def douyin_upload_video(self):
        self._upload_evidence = _UploadEvidence()
        async with async_playwright() as playwright:
            try:
                await self.upload(playwright)
            except Exception as exc:
                await self._upload_evidence.failed(getattr(self, "_diagnostic_page", None), exc)
                raise

    async def main(self):
        await self.douyin_upload_video()


class DouYinNote(DouYinBaseUploader):
    def __init__(
        self,
        image_paths,
        note,
        tags,
        publish_date: datetime | int,
        account_file,
        title: str | None = None,
        publish_strategy: str = DOUYIN_PUBLISH_STRATEGY_IMMEDIATE,
        debug: bool = DEBUG_MODE,
        headless: bool = LOCAL_CHROME_HEADLESS,
    ):
        super().__init__(
            publish_date=publish_date,
            account_file=account_file,
            publish_strategy=publish_strategy,
            debug=debug,
            headless=headless,
        )
        self.image_paths = image_paths
        self.note = note or ""
        self.title = title or (self.note[:30] if self.note else "")
        self.tags = tags or []

    async def validate_upload_args(self):
        await self.validate_base_args()
        if not self.title or not str(self.title).strip():
            raise ValueError("图文模式下，title 是必须的")
        if not self.image_paths:
            raise ValueError("图文模式下，图片是必须的")

        if isinstance(self.image_paths, (str, Path)):
            self.image_paths = [self.image_paths]

        if len(self.image_paths) > 35:
            raise ValueError("图文模式下最多只支持上传 35 张图片")

        normalized_image_paths = []
        for image_path in self.image_paths:
            normalized_image_paths.append(str(self.validate_image_file(image_path)))
        self.image_paths = normalized_image_paths

    async def upload_note_content(self, page: Page) -> None:
        douyin_logger.info(_msg("🏃", f"小人开始搬运图文，共 {len(self.image_paths)} 张图片"))
        douyin_logger.info(_msg("🔀", "小人正在切换到图文发布"))
        await page.get_by_text("发布图文", exact=True).click()
        await page.wait_for_timeout(1000)

        douyin_logger.info(_msg("📤", "小人正在上传图片"))
        await page.locator("div[class^='container'] input[accept*='image']").set_input_files(self.image_paths)

        while True:
            try:
                await page.wait_for_url(
                    "**/creator-micro/content/post/image?**",
                    timeout=3000,
                )
                douyin_logger.info(_msg("🥳", "已经进入图文发布页面"))
                break
            except Exception:
                douyin_logger.debug(_msg("🧍", "小人还在等图片上传完成"))
                await asyncio.sleep(0.5)

        await asyncio.sleep(1)
        douyin_logger.info(_msg("✍️", "小人开始填标题、描述和话题"))
        await self.fill_title_and_description(page, self.title, self.note, self.tags)
        douyin_logger.info(_msg("🏷️", f"小人一共贴了 {len(self.tags)} 个话题"))

        if self.publish_strategy == DOUYIN_PUBLISH_STRATEGY_SCHEDULED and self.publish_date != 0:
            await self.set_schedule_time_douyin(page, self.publish_date)

        while True:
            try:
                publish_button = page.get_by_role("button", name="发布", exact=True)
                if await publish_button.count():
                    await publish_button.click()
                await page.wait_for_url(
                    "**/creator-micro/content/manage?enter_from=publish**",
                    timeout=3000,
                )
                douyin_logger.success(_msg("🥳", "图文发布成功，小人开心收工"))
                break
            except Exception:
                douyin_logger.info(_msg("🏃", "小人正在冲刺发布图文"))
                await asyncio.sleep(0.5)

    async def upload(self, playwright: Playwright) -> None:
        douyin_logger.info(_msg("🧍", "小人先检查 cookie、图片和发布时间"))
        await self.validate_upload_args()
        douyin_logger.info(_msg("🥳", "图文上传前检查通过"))

        browser = await playwright.chromium.launch(headless=self.headless, channel="chrome")
        context = await browser.new_context(
            storage_state=f"{self.account_file}",
            permissions=["geolocation"],
        )
        context = await set_init_script(context)

        upload_success = False
        try:
            page = await context.new_page()
            await page.goto("https://creator.douyin.com/creator-micro/content/upload")
            douyin_logger.info(_msg("🧭", "小人正在赶往图文发布页"))
            await page.wait_for_url("https://creator.douyin.com/creator-micro/content/upload")

            await self.upload_note_content(page)
            upload_success = True
        finally:
            if upload_success:
                await context.storage_state(path=self.account_file)
                douyin_logger.success(_msg("🥳", "cookie 更新完毕"))
                await asyncio.sleep(2)
            await context.close()
            await browser.close()

    async def douyin_upload_note(self):
        async with async_playwright() as playwright:
            await self.upload(playwright)
