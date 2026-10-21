"""Public-web URLs and bounded, DNS-pinned downloads for offline articles."""
import gzip
import hashlib
import http.client
import ipaddress
import re
import socket
from urllib.parse import urlsplit, urlunsplit, parse_qsl, urlencode, urljoin, quote
from networking import tls_context


def normalize_url(raw):
    if not isinstance(raw, str) or len(raw) > 4000 or re.search(r'[\x00-\x20\\]', raw):
        raise ValueError('请输入有效的公开 Blog 链接')
    try:
        u = urlsplit(raw)
        host = (u.hostname or '').encode('idna').decode().lower().rstrip('.')
        if u.scheme not in ('http', 'https') or not host or u.username or u.password or u.port not in (None, 80, 443):
            raise ValueError()
        if host == 'localhost' or host.endswith(('.localhost', '.local', '.internal')):
            raise ValueError()
        try:
            if not ipaddress.ip_address(host).is_global:
                raise ValueError('private address')
        except ValueError as exc:
            if str(exc) == 'private address': raise
        if host.startswith(('arxiv.org.', 'www.arxiv.org.', 'export.arxiv.org.')):
            raise ValueError()
        query = [(k, v) for k, v in parse_qsl(u.query, keep_blank_values=True)
                 if not k.lower().startswith('utm_') and k.lower() not in ('fbclid', 'gclid', 'mc_cid', 'mc_eid')]
        authority = '[' + host + ']' if ':' in host else host
        if u.port and u.port != (443 if u.scheme == 'https' else 80): authority += ':' + str(u.port)
        path = quote(u.path or '/', safe="/%:@!$&'()*+,;=-._~")
        return urlunsplit((u.scheme, authority, path, urlencode(query), ''))
    except (ValueError, UnicodeError):
        raise ValueError('仅支持公开 HTTP(S) 文章链接，不支持本机地址、凭证或特殊端口') from None


def source_id(url):
    return hashlib.sha256(('blog:' + normalize_url(url)).encode()).hexdigest()[:20]


def public_address(host, port, tls=False):
    addresses = socket.getaddrinfo(host, port, type=socket.SOCK_STREAM)
    def allowed(value):
        address = ipaddress.ip_address(value)
        # TUN proxies commonly return benchmark-range fake DNS addresses. Only
        # HTTPS hostnames may use these; TLS still verifies the original hostname.
        # Literal non-public URLs and ordinary LAN/loopback DNS remain forbidden.
        fake = address in ipaddress.ip_network('198.18.0.0/15') if address.version == 4 else address in ipaddress.ip_network('2001:2::/48')
        return address.is_global or (tls and fake)
    if not addresses or any(not allowed(a[4][0]) for a in addresses):
        raise ValueError('文章及图片必须来自公开网站，不能访问本机或内网')
    return addresses[0][4][0]


def fetch(url, limit=8_000_000):
    """Resolve once per hop and connect to that exact public IP (including redirects)."""
    url = normalize_url(url)
    for _ in range(6):
        u = urlsplit(url)
        port = u.port or (443 if u.scheme == 'https' else 80)
        address = public_address(u.hostname, port, tls=u.scheme == 'https')
        conn = http.client.HTTPConnection(u.hostname, port, timeout=35)
        raw = socket.create_connection((address, port), timeout=35)
        try:
            conn.sock = tls_context().wrap_socket(raw, server_hostname=u.hostname) if u.scheme == 'https' else raw
            conn.request('GET', urlunsplit(('', '', u.path, u.query, '')),
                         headers={'Host': u.netloc, 'User-Agent': 'PaperArchive/0.6 (offline research reader)', 'Accept-Encoding': 'identity'})
            response = conn.getresponse()
            if response.status in (301, 302, 303, 307, 308):
                target = response.getheader('Location')
                if not target: raise RuntimeError('网站重定向缺少目标')
                url = normalize_url(urljoin(url, target))
                continue
            if response.status != 200:
                raise RuntimeError(f'网站返回 HTTP {response.status}，请检查文章是否需要登录')
            body = response.read(limit + 1)
            if len(body) > limit: raise RuntimeError('网页或图片超过离线保存大小限制')
            if response.getheader('Content-Encoding', '').lower() == 'gzip':
                import io
                with gzip.GzipFile(fileobj=io.BytesIO(body)) as stream: body = stream.read(limit + 1)
                if len(body) > limit: raise RuntimeError('网页解压后超过大小限制')
            return body, response.getheader('Content-Type', ''), url
        finally:
            conn.close()
            raw.close()
    raise RuntimeError('网站重定向次数过多')
