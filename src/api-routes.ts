import { randomUUID } from 'crypto';
import { IncomingMessage, ServerResponse } from 'http';
import { TARGETED_CLIENTS, checkClientStatus, configureBatch, unconfigureBatch } from './auto-configure.js';
import { APP_CONFIG, runtimeConfig, saveSettings } from './config.js';
import type { EventLogger } from './event-log.js';
import { rejectUnauthorized, resolveRequestRole } from './http-auth.js';
import { sendJson } from './http-util.js';
import { advertisedHttpHost, webhookUrlError } from './net-policy.js';
import { readJsonBody } from './read-body.js';
import type { SseManager } from './sse-manager.js';
import { parseTurnArgs } from './turn-args.js';
import type { WaitStore } from './wait-store.js';

export interface ApiDeps {
    waitStore: WaitStore;
    eventLogger: EventLogger;
    sseManager: SseManager;
    mcpServerUrl: () => string;
    replaceWebhook: () => void;
}

function parseWaitApiPath(pathname: string): { id: string; action: 'respond' | 'cancel' | 'extend' } | null {
    const segs = pathname.split('/').filter(Boolean);
    if (segs.length !== 4 || segs[0] !== 'api' || segs[1] !== 'waits') {
        return null;
    }
    const id = segs[2];
    const action = segs[3];
    if (!id) {
        return null;
    }
    if (action !== 'respond' && action !== 'cancel' && action !== 'extend') {
        return null;
    }
    return { id, action };
}

function parseHistoryResolution(value: string | null): 'message' | 'timeout' | 'canceled' | 'interrupted' | undefined {
    if (value === 'message' || value === 'timeout' || value === 'canceled' || value === 'interrupted') {
        return value;
    }
    return undefined;
}

function sessionIdError(value: unknown): string | null {
    if (value === undefined) {
        return null;
    }
    if (typeof value !== 'string' || !value.trim() || value.trim().length > 200 || /[\r\n]/.test(value)) {
        return 'Invalid field: "sessionId" must be a single-line string of at most 200 characters.';
    }
    return null;
}

export async function handleApiRequest(req: IncomingMessage, res: ServerResponse, pathname: string, deps: ApiDeps): Promise<void> {
    const { waitStore, eventLogger, sseManager } = deps;
    if (req.method === 'OPTIONS') {
        res.statusCode = 204;
        res.end();
        return;
    }
    if (req.method === 'GET' && pathname === '/api/public-config') {
        sendJson(res, 200, {
            requireApiKey: APP_CONFIG.requireApiKey,
            hasOperatorApiKeyConfigured: Boolean(APP_CONFIG.operatorApiKey),
            hasViewerApiKeyConfigured: Boolean(APP_CONFIG.viewerApiKey),
            mcpPath: APP_CONFIG.mcpPath,
            eventLogEnabled: eventLogger.isFileEnabled(),
            waitHistoryMaxItems: APP_CONFIG.waitHistoryMaxItems,
            timeoutEnabled: runtimeConfig.timeoutEnabled,
            defaultTimeoutSeconds: runtimeConfig.defaultTimeoutSeconds,
            verbatimReplies: true,
        });
        return;
    }
    if (pathname === '/api/settings' && req.method === 'POST') {
        if (!rejectUnauthorized(req, res, eventLogger, 'api', pathname, 'operator', false)) {
            return;
        }
        const body = await readJsonBody(req) as Record<string, unknown> | undefined;
        if (body && typeof body.webhookUrl === 'string') {
            const urlError = webhookUrlError(body.webhookUrl);
            if (urlError) {
                sendJson(res, 400, { error: urlError });
                return;
            }
        }
        if (body && typeof body.timeoutEnabled === 'boolean') {
            runtimeConfig.timeoutEnabled = body.timeoutEnabled;
        }
        if (body && typeof body.defaultTimeoutSeconds === 'number') {
            const val = Math.floor(body.defaultTimeoutSeconds);
            if (val >= 0 && val <= 3600) {
                runtimeConfig.defaultTimeoutSeconds = val;
            }
        }
        let webhookChanged = false;
        if (body && typeof body.webhookUrl === 'string') {
            const newUrl = body.webhookUrl.trim();
            if (newUrl !== runtimeConfig.webhookUrl) {
                runtimeConfig.webhookUrl = newUrl;
                webhookChanged = true;
            }
        }
        if (body && typeof body.webhookEvents === 'string') {
            const newEvents = body.webhookEvents.trim();
            if (newEvents !== runtimeConfig.webhookEvents) {
                runtimeConfig.webhookEvents = newEvents;
                webhookChanged = true;
            }
        }
        if (webhookChanged) {
            deps.replaceWebhook();
        }
        saveSettings();
        eventLogger.log('settings_updated', {
            timeoutEnabled: runtimeConfig.timeoutEnabled,
            defaultTimeoutSeconds: runtimeConfig.defaultTimeoutSeconds,
            webhookConfigured: Boolean(runtimeConfig.webhookUrl),
        });
        sendJson(res, 200, {
            ok: true,
            timeoutEnabled: runtimeConfig.timeoutEnabled,
            defaultTimeoutSeconds: runtimeConfig.defaultTimeoutSeconds,
            webhookUrl: runtimeConfig.webhookUrl,
            webhookEvents: runtimeConfig.webhookEvents,
        });
        return;
    }
    if (req.method === 'GET' && pathname === '/api/history') {
        if (!rejectUnauthorized(req, res, eventLogger, 'api', pathname, 'viewer', false)) {
            return;
        }
        const requestUrl = new URL(req.url || '/api/history', `http://${req.headers.host || 'localhost'}`);
        const limit = Number(requestUrl.searchParams.get('limit') || 100);
        const offset = Number(requestUrl.searchParams.get('offset') || 0);
        const sessionId = (requestUrl.searchParams.get('sessionId') || '').trim() || undefined;
        const resolution = parseHistoryResolution(requestUrl.searchParams.get('resolution'));
        const keyword = (requestUrl.searchParams.get('q') || '').trim() || undefined;
        const { items: history, total } = waitStore.queryHistory({ limit, offset, sessionId, resolution, keyword });
        const safeLimit = Number.isInteger(limit) ? Math.max(1, Math.min(1000, limit)) : 100;
        const safeOffset = Number.isInteger(offset) ? Math.max(0, offset) : 0;
        sendJson(res, 200, {
            count: history.length,
            total,
            history,
            maxStored: APP_CONFIG.waitHistoryMaxItems,
            filters: { limit: safeLimit, offset: safeOffset, sessionId: sessionId || null, resolution: resolution || null, q: keyword || null },
            pagination: { limit: safeLimit, offset: safeOffset, hasMore: safeOffset + history.length < total },
        });
        return;
    }
    if (req.method === 'GET' && pathname === '/api/auth-check') {
        if (!rejectUnauthorized(req, res, eventLogger, 'api', pathname, 'viewer', false)) {
            return;
        }
        sendJson(res, 200, { role: resolveRequestRole(req) });
        return;
    }
    if (req.method === 'GET' && pathname === '/api/history/timeline') {
        if (!rejectUnauthorized(req, res, eventLogger, 'api', pathname, 'viewer', false)) {
            return;
        }
        const requestUrl = new URL(req.url || '/api/history/timeline', `http://${req.headers.host || 'localhost'}`);
        const sessionId = (requestUrl.searchParams.get('sessionId') || '').trim();
        if (!sessionId) {
            sendJson(res, 400, { error: 'Missing required query param: sessionId' });
            return;
        }
        const timeline = waitStore.listSessionTimeline(sessionId);
        sendJson(res, 200, { sessionId, count: timeline.length, timeline });
        return;
    }
    if (req.method === 'GET' && pathname === '/api/stream') {
        if (!rejectUnauthorized(req, res, eventLogger, 'api', pathname, 'viewer', false)) {
            return;
        }
        res.writeHead(200, {
            'content-type': 'text/event-stream',
            'cache-control': 'no-cache',
            'connection': 'keep-alive',
            'x-content-type-options': 'nosniff',
        });
        res.write(':connected\n\n');
        sseManager.addClient(res);
        return;
    }
    if (req.method === 'GET' && pathname === '/api/events') {
        if (!rejectUnauthorized(req, res, eventLogger, 'api', pathname, 'operator', false)) {
            return;
        }
        const requestUrl = new URL(req.url || '/api/events', `http://${req.headers.host || 'localhost'}`);
        const limit = Number(requestUrl.searchParams.get('limit') || 200);
        const offset = Number(requestUrl.searchParams.get('offset') || 0);
        const type = (requestUrl.searchParams.get('type') || '').trim() || undefined;
        const eventQuery = eventLogger.query(limit, offset, type);
        sendJson(res, 200, {
            enabled: eventLogger.isFileEnabled(),
            count: eventQuery.events.length,
            total: eventQuery.total,
            events: eventQuery.events,
            availableTypes: eventQuery.availableTypes,
            typeCounts: eventQuery.typeCounts,
            filters: { type: eventQuery.filterType },
            pagination: { limit: eventQuery.limit, offset: eventQuery.offset, hasMore: eventQuery.hasMore },
        });
        return;
    }
    if (req.method === 'GET' && pathname === '/api/sessions') {
        if (!rejectUnauthorized(req, res, eventLogger, 'api', pathname, 'viewer', false)) {
            return;
        }
        const role = resolveRequestRole(req);
        const summaries = waitStore.listSessionSummaries();
        const payload: Record<string, unknown> = { sessions: summaries, count: summaries.length };
        if (role === 'operator') {
            payload.webhookUrl = runtimeConfig.webhookUrl;
            payload.webhookEvents = runtimeConfig.webhookEvents;
        }
        sendJson(res, 200, payload);
        return;
    }
    if (!rejectUnauthorized(req, res, eventLogger, 'api', pathname, 'viewer', false)) {
        return;
    }
    if (req.method === 'GET' && pathname === '/api/waits') {
        const now = Date.now();
        const waits = waitStore.listPendingWaits().map((wait) => ({
            ...wait,
            remainingSeconds: wait.expiresAt <= 0 ? -1 : Math.max(0, Math.floor((wait.expiresAt - now) / 1000)),
        }));
        sendJson(res, 200, { waits, count: waits.length });
        return;
    }
    if (req.method === 'GET' && pathname === '/api/auto-configure-status') {
        if (!rejectUnauthorized(req, res, eventLogger, 'api', pathname, 'operator', false)) {
            return;
        }
        const serverUrl = deps.mcpServerUrl();
        const targets = [...TARGETED_CLIENTS, 'system-mcp'];
        const status: Record<string, string> = {};
        for (const target of targets) {
            status[target] = checkClientStatus(target, serverUrl);
        }
        sendJson(res, 200, { ok: true, serverUrl, status });
        return;
    }
    if (req.method === 'POST' && pathname === '/api/auto-configure') {
        if (!rejectUnauthorized(req, res, eventLogger, 'api', pathname, 'operator', false)) {
            return;
        }
        const body = await readJsonBody(req) as Record<string, unknown> | undefined;
        const rawTargets = body?.targets;
        if (!Array.isArray(rawTargets) || rawTargets.length === 0) {
            sendJson(res, 400, { error: '"targets" must be a non-empty array of client IDs.' });
            return;
        }
        const targets = rawTargets.filter((target): target is string => typeof target === 'string');
        const overrideUrl = typeof body?.serverUrl === 'string' ? body.serverUrl.trim() : '';
        const serverUrl = overrideUrl || deps.mcpServerUrl();
        const results = configureBatch(targets, serverUrl);
        eventLogger.log('auto_configure', { targets, serverUrl, results: results.map((item) => ({ target: item.target, action: item.action })) });
        sendJson(res, 200, { ok: true, serverUrl, results });
        return;
    }
    if (req.method === 'POST' && pathname === '/api/auto-unconfigure') {
        if (!rejectUnauthorized(req, res, eventLogger, 'api', pathname, 'operator', false)) {
            return;
        }
        const body = await readJsonBody(req) as Record<string, unknown> | undefined;
        const rawTargets = body?.targets;
        if (!Array.isArray(rawTargets) || rawTargets.length === 0) {
            sendJson(res, 400, { error: '"targets" must be a non-empty array.' });
            return;
        }
        const targets = rawTargets.filter((target): target is string => typeof target === 'string');
        const results = unconfigureBatch(targets);
        eventLogger.log('auto_unconfigure', { targets, results: results.map((item) => ({ target: item.target, action: item.action })) });
        sendJson(res, 200, { ok: true, results });
        return;
    }
    if (req.method === 'POST' && pathname === '/api/waits/create-and-wait') {
        if (!rejectUnauthorized(req, res, eventLogger, 'api', pathname, 'operator', false)) {
            return;
        }
        const body = await readJsonBody(req) as Record<string, unknown> | undefined;
        const parsed = parseTurnArgs(body);
        if (!parsed.ok) {
            sendJson(res, 400, { error: parsed.error });
            return;
        }
        if (parsed.args.context.length > APP_CONFIG.maxContextChars) {
            sendJson(res, 400, { error: `Invalid args: "context" exceeds ${APP_CONFIG.maxContextChars} characters.` });
            return;
        }
        const sidError = sessionIdError(body?.sessionId);
        if (sidError) {
            sendJson(res, 400, { error: sidError });
            return;
        }
        const sessionId = typeof body?.sessionId === 'string' && body.sessionId.trim()
            ? body.sessionId.trim()
            : `rest-${randomUUID().slice(0, 12)}`;
        const effectiveTimeout = runtimeConfig.timeoutEnabled
            ? (parsed.args.timeoutSeconds || runtimeConfig.defaultTimeoutSeconds)
            : 0;
        req.socket.setTimeout(0);
        const resolution = await waitStore.waitForResponse({
            sessionId,
            context: parsed.args.context,
            question: parsed.args.question,
            options: parsed.args.options,
            agentName: parsed.args.agentName,
            timeoutMs: effectiveTimeout * 1000,
        });
        if (resolution.kind === 'busy') {
            sendJson(res, 409, { error: 'busy', scope: resolution.scope, activeWaitIds: resolution.activeWaitIds });
            return;
        }
        if (resolution.kind === 'timeout' || resolution.kind === 'canceled' || resolution.kind === 'interrupted') {
            sendJson(res, 200, {
                ok: true,
                resolution: resolution.kind,
                reason: resolution.kind === 'interrupted' ? resolution.reason : undefined,
                message: null,
                sessionId,
            });
            return;
        }
        sendJson(res, 200, { ok: true, resolution: 'message', message: resolution.text, sessionId });
        return;
    }
    if (req.method === 'POST' && pathname === '/api/waits/cancel-all') {
        if (!rejectUnauthorized(req, res, eventLogger, 'api', pathname, 'operator', false)) {
            return;
        }
        const count = waitStore.cancelAll();
        eventLogger.log('waits_cancel_all', { count });
        sendJson(res, 200, { ok: true, canceled: count });
        return;
    }
    if (req.method === 'GET' && /^\/api\/waits\/[^/]+$/.test(pathname)) {
        const waitId = pathname.slice('/api/waits/'.length);
        const wait = waitStore.getPendingWait(waitId);
        if (!wait) {
            sendJson(res, 404, { error: 'wait-not-found' });
            return;
        }
        sendJson(res, 200, { wait });
        return;
    }
    const detail = parseWaitApiPath(pathname);
    if (!detail || req.method !== 'POST') {
        sendJson(res, 404, { error: 'Not found' });
        return;
    }
    if (!rejectUnauthorized(req, res, eventLogger, 'api', pathname, 'operator', false)) {
        return;
    }
    if (detail.action === 'cancel') {
        const result = waitStore.cancel(detail.id);
        if (!result.ok) {
            sendJson(res, 404, { error: result.reason });
            return;
        }
        sendJson(res, 200, { ok: true });
        return;
    }
    if (detail.action === 'extend') {
        const extBody = await readJsonBody(req);
        const seconds = (extBody as { seconds?: unknown } | undefined)?.seconds;
        if (typeof seconds !== 'number' || !Number.isInteger(seconds)) {
            sendJson(res, 400, { error: 'Invalid payload: "seconds" must be an integer.' });
            return;
        }
        const result = waitStore.extend(detail.id, seconds);
        if (!result.ok) {
            sendJson(res, result.reason === 'wait-not-found' ? 404 : 400, { error: result.reason });
            return;
        }
        sendJson(res, 200, { ok: true, newExpiresAt: result.newExpiresAt });
        return;
    }
    const body = await readJsonBody(req);
    const message = (body as { message?: unknown } | undefined)?.message;
    if (typeof message !== 'string') {
        sendJson(res, 400, { error: 'Invalid payload: "message" must be string.' });
        return;
    }
    const result = waitStore.respond(detail.id, message);
    if (!result.ok) {
        sendJson(res, result.reason === 'wait-not-found' ? 404 : 400, { error: result.reason });
        return;
    }
    sendJson(res, 200, { ok: true });
}

export function defaultMcpServerUrl(): string {
    const host = advertisedHttpHost(APP_CONFIG.httpHost);
    return `http://${host}:${APP_CONFIG.httpPort}${APP_CONFIG.mcpPath}`;
}
