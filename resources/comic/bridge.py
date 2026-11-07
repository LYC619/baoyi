"""JMComic adapter. One bounded JSON request, JSONL events, no user plugins/config.

Started with Python -I -S; the only third-party import path is this runtime's
site-packages. Downloads stay in the job directory provided by the host.
"""
from __future__ import annotations
import hashlib
import ipaddress
import json
import os
from pathlib import Path
import re
import socket
import sys
import threading
import time
from urllib.parse import urlsplit

API_HOSTS = ('www.cdnhjk.net', 'www.cdngwc.cc', 'www.cdngwc.net', 'www.cdngwc.club')
IMAGE_HOSTS = ('cdn-msp.jmapiproxy1.cc', 'cdn-msp.jmapiproxy2.cc', 'cdn-msp2.jmapiproxy2.cc',
               'cdn-msp3.jmapiproxy2.cc', 'cdn-msp.jmapinodeudzn.net', 'cdn-msp3.jmapinodeudzn.net')
ADAPTER_VERSION = 'jmcomic-2.7.11/baoyi-1'
MAX_BYTES = 64 * 1024 ** 2
cancelled = threading.Event()
lock = threading.Lock()
sequence = 0
job_id = ''
job_handle = None


class AdapterError(Exception):
    def __init__(self, code, message, retry_at=0):
        super().__init__(message)
        self.code, self.retry_at = code, retry_at


def check_cancel():
    if cancelled.is_set():
        raise AdapterError('cancelled', '下载已停止，已完成页面保留')


def own_windows_job():
    """The audited adapter needs threads only; prohibit descendant processes."""
    global job_handle
    if os.name != 'nt':
        return
    import ctypes
    from ctypes import wintypes as w
    class Basic(ctypes.Structure):
        _fields_=[('user',ctypes.c_longlong),('job',ctypes.c_longlong),('flags',w.DWORD),('min',ctypes.c_size_t),('max',ctypes.c_size_t),('active',w.DWORD),('affinity',ctypes.c_size_t),('priority',w.DWORD),('scheduling',w.DWORD)]
    class Extended(ctypes.Structure):
        _fields_=[('basic',Basic),('io',ctypes.c_ulonglong*6),('process_memory',ctypes.c_size_t),('job_memory',ctypes.c_size_t),('peak_process',ctypes.c_size_t),('peak_job',ctypes.c_size_t)]
    kernel=ctypes.WinDLL('kernel32',use_last_error=True)
    kernel.CreateJobObjectW.restype=w.HANDLE;kernel.CreateJobObjectW.argtypes=[ctypes.c_void_p,w.LPCWSTR]
    kernel.SetInformationJobObject.argtypes=[w.HANDLE,ctypes.c_int,ctypes.c_void_p,w.DWORD]
    kernel.AssignProcessToJobObject.argtypes=[w.HANDLE,w.HANDLE]
    kernel.GetCurrentProcess.restype=w.HANDLE
    limits=Extended();limits.basic.flags=0x2000|0x8|0x100;limits.basic.active=1;limits.process_memory=1024**3
    job_handle=kernel.CreateJobObjectW(None,None)
    if not job_handle or not kernel.SetInformationJobObject(job_handle,9,ctypes.byref(limits),ctypes.sizeof(limits)) or not kernel.AssignProcessToJobObject(job_handle,kernel.GetCurrentProcess()):
        raise AdapterError('process', '无法建立漫画下载进程的资源限制')


def emit(event, **data):
    global sequence
    with lock:
        sequence += 1
        text = json.dumps(dict(protocolVersion=1, jobId=job_id, sequence=sequence, event=event, **data), ensure_ascii=False)
        if len(text.encode()) > 65536:
            raise AdapterError('protocol_size', '来源事件超过大小限制')
        try:
            print(text, flush=True)
        except (BrokenPipeError, OSError):
            cancelled.set()


def allowed_url(value, image=False, resolve=True):
    url = urlsplit(value)
    hosts = IMAGE_HOSTS if image else API_HOSTS
    if url.scheme != 'https' or url.hostname not in hosts or url.username or url.password or url.port not in (None, 443) or url.fragment:
        raise AdapterError('source_url', '来源返回了尚未支持的地址，请更新来源适配器')
    if image and not re.fullmatch(r'/media/(?:photos/\d+/[A-Za-z0-9_.-]+|albums/\d+(?:_[A-Za-z0-9]+)?\.[A-Za-z0-9]+)', url.path):
        raise AdapterError('source_url', '图片地址与作品路径不符')
    if resolve:
        addresses = socket.getaddrinfo(url.hostname, 443, type=socket.SOCK_STREAM)
        if not addresses or any(not ipaddress.ip_address(row[4][0]).is_global for row in addresses):
            raise AdapterError('source_address', '来源域名解析到非公网地址，未发送请求')
    return value


def safe_directory(root: Path, relative: str):
    if not relative or '/' in relative or '\\' in relative or relative in ('.', '..') or re.search(r'[<>:"|?*\x00-\x1f]', relative) or relative.endswith(('.', ' ')):
        raise AdapterError('path', '章节目录无效')
    target = root / relative
    target.mkdir(exist_ok=True)
    if target.is_symlink() or target.resolve() != target.absolute():
        raise AdapterError('path', '章节目录不是独立目录')
    return target


def load_library(site_packages):
    site = Path(site_packages).resolve()
    if not (site / 'jmcomic/__init__.py').is_file():
        raise AdapterError('runtime', '漫画运行组件缺失，请使用完整的抱一程序目录')
    sys.path.insert(0, str(site))
    import jmcomic
    if jmcomic.__version__ != '2.7.11':
        raise AdapterError('runtime', '漫画运行组件版本不一致')
    config = jmcomic.JmModuleConfig
    config.FLAG_ENABLE_JM_LOG = False
    config.FLAG_API_CLIENT_AUTO_UPDATE_DOMAIN = False
    config.FLAG_USE_VERSION_NEWER_IF_BEHIND = False
    config.FLAG_DUMP_HTML_ON_REGEX_ERROR = False
    config.DOMAIN_API_LIST = list(API_HOSTS)
    config.DOMAIN_IMAGE_LIST = list(IMAGE_HOSTS)
    from PIL import Image
    Image.MAX_IMAGE_PIXELS = 40_000_000
    return jmcomic


def network(jm, proxies, api_host):
    from curl_cffi import requests
    from jmcomic.common import CurlCffiSessionPostman

    class BoundedPostman(CurlCffiSessionPostman):
        def get(self, url, **kwargs):
            # Upstream retry_times=0 avoids a second retry loop. Only transport
            # failures rotate fixed API mirrors; access/limit errors stay visible.
            host = urlsplit(url).hostname
            candidates = (host, *(h for h in API_HOSTS if h != host)) if host in API_HOSTS else (host,)
            for index, candidate in enumerate(candidates):
                try:
                    return self.fetch(url.replace('https://'+str(host)+'/', 'https://'+str(candidate)+'/', 1), **kwargs)
                except AdapterError:
                    raise
                except requests.RequestsError:
                    if index == len(candidates)-1:
                        raise AdapterError('network', '漫画来源连接失败，请检查代理或稍后重试')

        def post(self, url, **kwargs):
            raise AdapterError('method', '漫画摄入仅使用来源读取接口')

        def fetch(self, url, output=None, image=False, max_bytes=None, **kwargs):
            check_cancel()
            image = image or output is not None
            host = urlsplit(url).hostname
            route = proxies.get(host, '')
            if route and not re.fullmatch(r'(?:http|https|socks5h?)://(?:\[[0-9a-fA-F:]+\]|[A-Za-z0-9_.-]+):\d{1,5}', route):
                raise AdapterError('proxy', '当前代理不能用于漫画来源，请选择本机 HTTP 或 SOCKS5 代理')
            # A configured proxy owns DNS resolution (including common fake-IP
            # modes). Direct requests still reject private/local DNS answers.
            allowed_url(url, image=image, resolve=not route)
            kwargs.update(allow_redirects=False, timeout=(10, 30), stream=True, proxies={'all': route} if route else {})
            limit = max_bytes or (MAX_BYTES if image else 8 * 1024 ** 2)
            response = self.session.get(url, **kwargs)
            try:
                if response.status_code == 429:
                    value = response.headers.get('retry-after', '60')
                    seconds = int(value) if str(value).isdigit() else 60
                    raise AdapterError('rate_limited', '来源请求较多，请稍后重试', int((time.time()+max(1, min(seconds, 86400)))*1000))
                if response.status_code in (401, 403):
                    raise AdapterError('access_required', '来源拒绝访问或需要验证，请检查代理及来源访问状态')
                if response.status_code != 200:
                    raise AdapterError('http', f'来源响应 HTTP {response.status_code}')
                size, chunks = 0, []
                handle = open(output, 'xb') if output else None
                try:
                    for chunk in response.iter_content(65536):
                        check_cancel()
                        size += len(chunk)
                        if size > limit:
                            raise AdapterError('size', '来源内容超过允许大小')
                        if handle:
                            handle.write(chunk)
                        else:
                            chunks.append(chunk)
                    if handle:
                        handle.flush()
                        os.fsync(handle.fileno())
                    else:
                        response.content = b''.join(chunks)
                finally:
                    if handle:
                        handle.close()
                return response
            finally:
                response.close()

    # Python's UTF-8 mode changes locale.getpreferredencoding(), while libcurl
    # still opens Windows CA files through the native ANSI filesystem API.
    # Pass explicit native bytes; TLS verification remains enabled.
    options = {'impersonate': 'chrome', 'trust_env': False}
    if os.name == 'nt':
        import certifi
        from curl_cffi import CurlOpt
        ca_path = certifi.where().encode('mbcs')
        options['curl_options'] = {CurlOpt.CAINFO: ca_path, CurlOpt.PROXY_CAINFO: ca_path}
    postman = BoundedPostman(options)
    client = jm.JmApiClient(postman, [api_host], retry_times=0)
    return client, postman


def client_for(jm, proxies):
    error = None
    for host in API_HOSTS:
        try:
            return network(jm, proxies, host)
        except AdapterError as cause:
            if cause.code in ('access_required', 'rate_limited', 'source_url', 'source_address', 'proxy', 'cancelled'):
                raise
            error = cause
        except Exception as cause:
            error = cause
    raise AdapterError('network', '漫画来源连接失败，请检查代理或稍后重试') from error


def catalog(client, work_id, send=True):
    album = client.get_album_detail(work_id, allow_redirect=False)
    if album.id != work_id or album.series_id not in ('0', '', work_id):
        raise AdapterError('identity', '这是章节编号，请使用所属作品编号')
    work = dict(provider='jm', workId=work_id, name=album.name, authors=list(dict.fromkeys(album.authors)), description=album.description,
                tags=list(dict.fromkeys(album.tags)), publication='ongoing', adapterVersion=ADAPTER_VERSION, catalogFingerprint='')
    if send:
        emit('work', value=work)
    chapters, photos = [], {}
    for part in album:
        check_cancel()
        photo = client.get_photo_detail(part.id, fetch_album=False)
        if photo.id != part.id or photo.album_id != work_id:
            raise AdapterError('identity', '来源章节归属与作品不一致')
        page_ids = list(photo.page_arr)
        if not page_ids or len(page_ids) > 20000 or len(set(page_ids)) != len(page_ids) or any(not re.fullmatch(r'[A-Za-z0-9_.-]{1,200}', p) for p in page_ids):
            raise AdapterError('catalog', '来源页面编号无效')
        chapter = dict(id=part.id, title=part.name, order=int(part.sort), pageIds=page_ids)
        chapters.append(chapter)
        photos[part.id] = photo
        if len(chapters) > 1000 or sum(len(c['pageIds']) for c in chapters) > 50000:
            raise AdapterError('catalog', '作品过大，请分卷处理')
        if send:
            for offset in range(0, len(page_ids), 200):
                emit('chapter', id=part.id, title=part.name, order=int(part.sort), offset=offset, pageIds=page_ids[offset:offset+200])
    return work, chapters, photos


def preview_cover(jm, postman, work_id):
    """A small, decoded thumbnail stays in the preview, never an external img URL."""
    import base64
    from io import BytesIO
    from PIL import Image
    try:
        url = jm.JmcomicText.get_album_cover_url(work_id, IMAGE_HOSTS[0], '_3x4')
        response = postman.fetch(url, image=True, max_bytes=2*1024**2, headers=jm.JmModuleConfig.new_html_headers())
        with Image.open(BytesIO(response.content)) as original:
            if original.width*original.height > 40_000_000:
                return
            original.thumbnail((180, 240))
            output = BytesIO()
            original.convert('RGB').save(output, format='JPEG', quality=70)
        if output.tell() <= 40000:
            emit('cover', value='data:image/jpeg;base64,'+base64.b64encode(output.getvalue()).decode('ascii'))
    except Exception:
        check_cancel()  # A missing cover must not prevent choosing chapters.


def decode_page(jm, source: Path, destination: Path, image):
    from PIL import Image
    with Image.open(source) as original:
        width, height = original.size
        if width*height > 40_000_000 or width <= 0 or height <= 0:
            raise AdapterError('pixels', '图片超过 40 MP 解码限制')
        original.load()
        count = jm.JmImageTool.get_num(image.scramble_id, image.aid, image.img_file_name)
        jm.JmImageTool.decode_and_save(count, original, str(destination))
    if destination.stat().st_size > MAX_BYTES:
        raise AdapterError('size', '还原后的图片超过 64 MiB')
    with Image.open(destination) as decoded:
        decoded.verify()
    with destination.open('rb') as handle:
        checksum = hashlib.file_digest(handle, 'sha256').hexdigest()
    return dict(sha256=checksum, size=destination.stat().st_size, width=width, height=height)


def download(jm, client, postman, request):
    from concurrent.futures import ThreadPoolExecutor
    root = Path(request['directory']).absolute()
    if root.resolve() != root or root.is_symlink() or not root.is_dir():
        raise AdapterError('path', '暂存目录不可用')
    _, chapters, photos = catalog(client, request['workId'], send=False)
    available = {c['id']: c for c in chapters}
    tasks = []
    for selected in request['chapters']:
        chapter = available.get(selected['id'])
        if not chapter or chapter['pageIds'] != selected['pageIds']:
            raise AdapterError('catalog_changed', '来源章节内容已变化，请重新解析后核对')
        folder = safe_directory(root, selected['directory'])
        skip = set(selected.get('skip', []))
        for index, page_id in enumerate(chapter['pageIds']):
            if page_id not in skip:
                tasks.append((folder, selected['id'], index, page_id, photos[selected['id']][index]))

    def one(task):
        folder, chapter_id, index, page_id, image = task
        final = folder / f'{index+1:05d}.png'
        raw, decoded = folder / f'{index+1:05d}.part', folder / f'{index+1:05d}.part.png'
        if final.exists():
            raise AdapterError('collision', '暂存页面已存在且未通过断点核验，请检查任务')
        began = time.monotonic()
        emit('page_start',chapterId=chapter_id,pageId=page_id)
        for attempt in range(4):
            check_cancel()
            try:
                for file in (raw, decoded):
                    file.unlink(missing_ok=True)
                postman.fetch(image.img_url, output=raw, headers=jm.JmModuleConfig.new_html_headers())
                value = decode_page(jm, raw, decoded, image)
                check_cancel()
                # Windows rename does not overwrite an existing destination.
                decoded.rename(final)
                emit('page', chapterId=chapter_id, pageId=page_id, file=final.relative_to(root).as_posix(), **value)
                return
            except AdapterError as error:
                cancelled.set()
                raise
            except Exception as error:
                if attempt == 3 or time.monotonic()-began >= 115:
                    cancelled.set()
                    raise AdapterError('page_failed', '图片下载或还原失败，已完成页面保留') from error
                emit('retry', chapterId=chapter_id, pageId=page_id, attempt=attempt+1)
                if cancelled.wait(2 ** attempt):
                    check_cancel()
            finally:
                raw.unlink(missing_ok=True)
                decoded.unlink(missing_ok=True)
    with ThreadPoolExecutor(max_workers=2) as pool:
        for _ in pool.map(one, tasks, buffersize=2):
            pass


def browse(jm, client, request):
    page = request.get('page', 1)
    if type(page) is not int or not 1 <= page <= 1000:
        raise AdapterError('input', '页码无效')
    if request.get('mode') == 'search':
        query = request.get('query', '').strip()
        scope = request.get('scope', 'all')
        if not query or len(query) > 200 or scope not in ('all', 'author', 'tag'):
            raise AdapterError('input', '搜索条件无效')
        method = {'all': client.search_site, 'author': client.search_author, 'tag': client.search_tag}[scope]
        result = method(query, page=page)
    elif request.get('mode') == 'ranking':
        period = request.get('period', 'day')
        if period == 'all':
            result = client.categories_filter(page, jm.JmMagicConstants.TIME_ALL, jm.JmMagicConstants.CATEGORY_ALL, jm.JmMagicConstants.ORDER_BY_VIEW)
        elif period in ('day', 'week', 'month'):
            result = getattr(client, period + '_ranking')(page)
        else:
            raise AdapterError('input', '榜单周期无效')
    else:
        raise AdapterError('input', '浏览方式无效')
    check_cancel()
    # Stream bounded summaries; never resolve every result's chapter/page catalog.
    if getattr(result, 'is_album', lambda: False)():
        emit('browse_item', value=dict(id=str(result.id), title=str(result.name)[:500], tags=list(result.tags)[:20]))
        emit('browse_page', page=page, pages=1)
        return
    rows = list(result.iter_id_title_tag())
    if len(rows) > 100:
        raise AdapterError('source', '来源单页结果过多')
    for work_id, title, tags in rows:
        if not re.fullmatch(r'[1-9]\d{0,11}', str(work_id)):
            raise AdapterError('source', '来源作品编号无效')
        emit('browse_item', value=dict(id=str(work_id), title=str(title)[:500], tags=[str(tag)[:100] for tag in tags[:20]]))
    emit('browse_page', page=page, pages=min(1000, max(page, int(result.page_count))))


def main():
    global job_id
    raw = sys.stdin.buffer.readline(8*1024**2+1)
    if len(raw) > 8*1024**2:
        raise AdapterError('input', '任务输入过大')
    request = json.loads(raw)
    job_id = request['jobId']
    if request.get('protocolVersion') != 1 or request.get('action') not in ('resolve', 'download', 'browse', 'cover'):
        raise AdapterError('input', '任务操作无效')
    if request['action'] != 'browse' and not re.fullmatch(r'[1-9]\d{0,11}', request.get('workId', '')):
        raise AdapterError('input', '任务编号无效')
    def listen():
        for _ in sys.stdin:
            cancelled.set()
        cancelled.set()
        # Parent exit must not leave a blocked source client running indefinitely.
        time.sleep(5)
        os._exit(1)
    def heartbeat():
        while not cancelled.wait(5):
            emit('heartbeat')
    threading.Thread(target=listen, daemon=True).start()
    threading.Thread(target=heartbeat, daemon=True).start()
    own_windows_job()
    jm = load_library(sys.argv[1])
    client, postman = client_for(jm, request.get('proxies', {}))
    try:
        if request['action'] == 'resolve':
            catalog(client, request['workId'])
            preview_cover(jm, postman, request['workId'])
        elif request['action'] == 'download':
            download(jm, client, postman, request)
        elif request['action'] == 'browse':
            browse(jm, client, request)
        elif request['action'] == 'cover':
            preview_cover(jm, postman, request['workId'])
        else:
            raise AdapterError('action', '未知漫画操作')
        emit('complete')
    finally:
        postman.session.close()
        cancelled.set()


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        cancelled.set()
        emit('error', code=error.code if isinstance(error, AdapterError) else 'source',
             message=str(error) if isinstance(error, AdapterError) else '来源返回异常，已完成页面保留，请检查代理或稍后重试',
             retryAt=error.retry_at if isinstance(error, AdapterError) else 0)
        sys.exit(1)
