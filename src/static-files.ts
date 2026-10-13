import { createHash } from 'crypto';
import { existsSync, readFileSync } from 'fs';
import { IncomingMessage, ServerResponse } from 'http';
import * as path from 'path';
import { gzipSync } from 'zlib';
import { applySecurityHeaders, headerString, sendJson } from './http-util.js';

const STATIC_ALLOWED = ['index.html', 'app.js', 'styles.css', 'i18n.js', 'manifest.json', 'sw.js'] as const;
const staticCache = new Map<string, Buffer>();
const staticCacheGzip = new Map<string, Buffer>();
const staticCacheEtag = new Map<string, string>();

export function loadStaticFiles(publicDir: string): void {
    for (const fileName of STATIC_ALLOWED) {
        const fullPath = path.join(publicDir, fileName);
        if (!existsSync(fullPath)) {
            continue;
        }
        const content = readFileSync(fullPath);
        staticCache.set(fileName, content);
        staticCacheGzip.set(fileName, gzipSync(content, { level: 9 }));
        staticCacheEtag.set(fileName, '"' + createHash('sha256').update(content).digest('hex').slice(0, 16) + '"');
    }
}

function contentType(fileName: string): string {
    if (fileName.endsWith('.html')) {
        return 'text/html; charset=utf-8';
    }
    if (fileName.endsWith('.js')) {
        return 'application/javascript; charset=utf-8';
    }
    if (fileName.endsWith('.css')) {
        return 'text/css; charset=utf-8';
    }
    if (fileName.endsWith('.json')) {
        return 'application/manifest+json; charset=utf-8';
    }
    return 'application/octet-stream';
}

export function serveStatic(req: IncomingMessage, res: ServerResponse, pathname: string): void {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
        sendJson(res, 404, { error: 'Not found' });
        return;
    }
    const fileName = pathname === '/' ? 'index.html' : pathname.slice(1);
    const content = staticCache.get(fileName);
    if (!content) {
        sendJson(res, 404, { error: 'Not found' });
        return;
    }
    applySecurityHeaders(res);
    res.setHeader('content-type', contentType(fileName));
    res.setHeader('cache-control', 'no-cache');
    const etag = staticCacheEtag.get(fileName);
    if (etag) {
        res.setHeader('etag', etag);
        if (headerString(req, 'if-none-match') === etag) {
            res.statusCode = 304;
            res.end();
            return;
        }
    }
    if (req.method === 'HEAD') {
        res.statusCode = 200;
        res.end();
        return;
    }
    const gzipped = staticCacheGzip.get(fileName);
    if (gzipped && (headerString(req, 'accept-encoding') || '').includes('gzip')) {
        res.setHeader('content-encoding', 'gzip');
        res.setHeader('vary', 'accept-encoding');
        res.statusCode = 200;
        res.end(gzipped);
        return;
    }
    res.statusCode = 200;
    res.end(content);
}
