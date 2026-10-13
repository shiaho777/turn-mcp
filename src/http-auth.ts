import { timingSafeEqual } from 'crypto';
import { IncomingMessage, ServerResponse } from 'http';
import { APP_CONFIG } from './config.js';
import { headerString, readCookie, sendJson, sendJsonRpcError } from './http-util.js';
import type { EventLogger } from './event-log.js';

export type ApiRole = 'none' | 'viewer' | 'operator';

export function extractApiKey(req: IncomingMessage): string | undefined {
    const fromCustom = headerString(req, 'x-turn-mcp-api-key');
    if (fromCustom && fromCustom.trim()) {
        return fromCustom.trim();
    }
    const auth = headerString(req, 'authorization');
    if (auth && auth.toLowerCase().startsWith('bearer ')) {
        const token = auth.slice('bearer '.length).trim();
        if (token) {
            return token;
        }
    }
    const fromCookie = readCookie(req, 'turn_mcp_key');
    if (fromCookie && fromCookie.trim()) {
        return fromCookie.trim();
    }
    return undefined;
}

function safeEqual(a: string, b: string): boolean {
    if (a.length !== b.length) {
        return false;
    }
    return timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

export function resolveRequestRole(req: IncomingMessage): ApiRole {
    if (!APP_CONFIG.requireApiKey) {
        return 'operator';
    }
    const incoming = extractApiKey(req);
    if (!incoming) {
        return 'none';
    }
    if (APP_CONFIG.operatorApiKey && safeEqual(incoming, APP_CONFIG.operatorApiKey)) {
        return 'operator';
    }
    if (APP_CONFIG.viewerApiKey && safeEqual(incoming, APP_CONFIG.viewerApiKey)) {
        return 'viewer';
    }
    return 'none';
}

export function hasRequiredRole(role: ApiRole, required: Exclude<ApiRole, 'none'>): boolean {
    if (required === 'viewer') {
        return role === 'viewer' || role === 'operator';
    }
    return role === 'operator';
}

export function rejectUnauthorized(req: IncomingMessage, res: ServerResponse, eventLogger: EventLogger, target: 'mcp' | 'api', path: string, requiredRole: Exclude<ApiRole, 'none'>, asJsonRpc: boolean): boolean {
    const role = resolveRequestRole(req);
    if (hasRequiredRole(role, requiredRole)) {
        return true;
    }
    eventLogger.log('auth_reject', {
        target,
        method: req.method || null,
        path,
        remote: req.socket.remoteAddress || null,
        requiredRole,
        actualRole: role,
    });
    if (asJsonRpc) {
        sendJsonRpcError(res, 401, 'Unauthorized: missing or invalid API key.');
    }
    else {
        sendJson(res, 401, { error: `Unauthorized: requires role "${requiredRole}".` });
    }
    return false;
}
