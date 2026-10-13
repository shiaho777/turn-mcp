import { IncomingMessage, ServerResponse } from 'http';

export function applySecurityHeaders(res: ServerResponse): void {
    res.setHeader('x-content-type-options', 'nosniff');
    res.setHeader('referrer-policy', 'no-referrer');
    res.setHeader('x-frame-options', 'DENY');
    res.setHeader('content-security-policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'");
}

export function sendJson(res: ServerResponse, statusCode: number, payload: unknown): void {
    if (res.headersSent) {
        return;
    }
    applySecurityHeaders(res);
    res.statusCode = statusCode;
    res.setHeader('content-type', 'application/json; charset=utf-8');
    res.end(JSON.stringify(payload));
}

export function sendJsonRpcError(res: ServerResponse, statusCode: number, message: string): void {
    sendJson(res, statusCode, {
        jsonrpc: '2.0',
        error: { code: -32000, message },
        id: null,
    });
}

export function headerString(req: IncomingMessage, name: string): string | undefined {
    const raw = req.headers[name];
    if (Array.isArray(raw)) {
        return raw[0];
    }
    return raw || undefined;
}

export function readCookie(req: IncomingMessage, name: string): string | undefined {
    const raw = headerString(req, 'cookie');
    if (!raw) {
        return undefined;
    }
    for (const part of raw.split(';')) {
        const separator = part.indexOf('=');
        if (separator < 0) {
            continue;
        }
        const key = part.slice(0, separator).trim();
        if (key !== name) {
            continue;
        }
        try {
            return decodeURIComponent(part.slice(separator + 1).trim());
        }
        catch {
            return undefined;
        }
    }
    return undefined;
}
