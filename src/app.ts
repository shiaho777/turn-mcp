import { createServer, IncomingMessage, Server, ServerResponse } from 'http';
import * as path from 'path';
import { existsSync } from 'fs';
import { handleApiRequest, defaultMcpServerUrl } from './api-routes.js';
import { APP_CONFIG, loadSettings, runtimeConfig, Logger, setStdioMode } from './config.js';
import { EventLogger } from './event-log.js';
import { headerString, sendJson, sendJsonRpcError } from './http-util.js';
import { McpGateway } from './mcp-http.js';
import { bindRejection, originAllowed, requestHostAllowed } from './net-policy.js';
import { SseManager } from './sse-manager.js';
import { loadStaticFiles, serveStatic } from './static-files.js';
import { TurnWaitMcpServer } from './turn-mcp-server.js';
import { WaitStore } from './wait-store.js';
import { JsonlHistoryPersistence } from './history-persistence.js';
import { TelegramNotifier, WebhookNotifier } from './webhook.js';

class RateLimiter {
    private readonly windows = new Map<string, number[]>();
    private readonly maxRequests: number;
    private readonly windowMs: number;
    constructor(maxRequests: number, windowSeconds: number) {
        this.maxRequests = maxRequests;
        this.windowMs = windowSeconds * 1000;
    }
    check(ip: string): boolean {
        if (this.maxRequests <= 0) {
            return true;
        }
        const now = Date.now();
        const cutoff = now - this.windowMs;
        const times = (this.windows.get(ip) || []).filter((stamp) => stamp > cutoff);
        times.push(now);
        this.windows.set(ip, times);
        return times.length <= this.maxRequests;
    }
    startPrune(): void {
        const timer = setInterval(() => {
            const cutoff = Date.now() - this.windowMs;
            for (const [ip, times] of this.windows) {
                const trimmed = times.filter((stamp) => stamp > cutoff);
                if (trimmed.length === 0) {
                    this.windows.delete(ip);
                }
                else {
                    this.windows.set(ip, trimmed);
                }
            }
        }, Math.max(this.windowMs, 60000));
        if (typeof timer.unref === 'function') {
            timer.unref();
        }
    }
}

export interface RunningApp {
    httpServer: Server;
    waitStore: WaitStore;
    mcp: McpGateway;
    shutdown: () => Promise<void>;
}

function publicDir(): string {
    const nextToBundle = path.resolve(__dirname, '../public');
    if (existsSync(nextToBundle)) {
        return nextToBundle;
    }
    return path.resolve(process.cwd(), 'public');
}

function requestAllowed(req: IncomingMessage): boolean {
    const host = headerString(req, 'host');
    if (!requestHostAllowed(host, APP_CONFIG.httpHost)) {
        return false;
    }
    return originAllowed(headerString(req, 'origin'), host);
}

export function createApp(): RunningApp {
    if (process.argv.includes('--stdio')) {
        setStdioMode(true);
    }
    loadSettings();
    const logger = new Logger('MainServer');
    const eventLogger = new EventLogger();
    const sseManager = new SseManager();
    const rateLimiter = new RateLimiter(APP_CONFIG.rateLimitMax, APP_CONFIG.rateLimitWindowSeconds);
    rateLimiter.startPrune();
    let webhookNotifier: WebhookNotifier | null = null;
    const replaceWebhook = (): void => {
        const url = runtimeConfig.webhookUrl.trim();
        if (!url) {
            webhookNotifier = null;
            return;
        }
        try {
            webhookNotifier = new WebhookNotifier(url, runtimeConfig.webhookEvents);
        }
        catch (error) {
            webhookNotifier = null;
            logger.error('webhook disabled', error);
        }
    };
    replaceWebhook();
    const telegramNotifier = APP_CONFIG.telegramBotToken && APP_CONFIG.telegramChatId
        ? new TelegramNotifier(APP_CONFIG.telegramBotToken, APP_CONFIG.telegramChatId, APP_CONFIG.telegramEvents)
        : null;
    const historyPersistence = APP_CONFIG.historyFile ? new JsonlHistoryPersistence(APP_CONFIG.historyFile) : undefined;
    const waitStore = new WaitStore((event) => {
        eventLogger.log(event.type, event);
        sseManager.broadcast(event);
        webhookNotifier?.notify(event);
        telegramNotifier?.notify(event);
    }, historyPersistence);
    const mcp = new McpGateway(waitStore, eventLogger);
    loadStaticFiles(publicDir());
    let shuttingDown = false;
    const httpServer = createServer((req: IncomingMessage, res: ServerResponse) => {
        if (!requestAllowed(req)) {
            sendJson(res, 403, { error: 'This console only accepts requests from its own host.' });
            return;
        }
        const requestUrl = new URL(req.url || '/', `http://${req.headers.host || APP_CONFIG.httpHost}`);
        const pathname = requestUrl.pathname;
        if (pathname === '/healthz') {
            sendJson(res, 200, {
                ok: true,
                name: APP_CONFIG.name,
                version: APP_CONFIG.version,
                activeSessions: mcp.activeSessions,
                pendingWaits: waitStore.listPendingWaits().length,
                historyCount: waitStore.historyCount(),
                requireApiKey: APP_CONFIG.requireApiKey,
                hasOperatorApiKeyConfigured: Boolean(APP_CONFIG.operatorApiKey),
                hasViewerApiKeyConfigured: Boolean(APP_CONFIG.viewerApiKey),
                verbatimReplies: true,
            });
            return;
        }
        if (pathname === APP_CONFIG.mcpPath) {
            const ip = req.socket.remoteAddress || 'unknown';
            if (!rateLimiter.check(ip)) {
                sendJsonRpcError(res, 429, 'Too many requests. Please slow down.');
                return;
            }
            mcp.handle(req, res).catch((error) => {
                logger.error('handleMcpRequest', error);
                sendJsonRpcError(res, 400, error instanceof Error ? error.message : String(error));
            });
            return;
        }
        if (pathname.startsWith('/api/')) {
            const ip = req.socket.remoteAddress || 'unknown';
            if (!rateLimiter.check(ip)) {
                sendJson(res, 429, { error: 'Too many requests. Please slow down.' });
                return;
            }
            handleApiRequest(req, res, pathname, {
                waitStore,
                eventLogger,
                sseManager,
                mcpServerUrl: defaultMcpServerUrl,
                replaceWebhook,
            }).catch((error) => {
                logger.error('handleApiRequest', error);
                sendJson(res, 500, { error: error instanceof Error ? error.message : String(error) });
            });
            return;
        }
        serveStatic(req, res, pathname);
    });
    const shutdown = async (): Promise<void> => {
        if (shuttingDown) {
            return;
        }
        shuttingDown = true;
        logger.info('Shutting down...');
        eventLogger.log('server_stopping', {});
        waitStore.interruptAll('shutdown');
        await new Promise((resolve) => setImmediate(resolve));
        mcp.stopReaper();
        await mcp.closeAll();
        sseManager.destroy();
        await new Promise<void>((resolve) => {
            httpServer.close(() => resolve());
        });
    };
    return { httpServer, waitStore, mcp, shutdown };
}

export function listen(app: RunningApp): void {
    const logger = new Logger('MainServer');
    const rejection = bindRejection(APP_CONFIG.httpHost, APP_CONFIG.operatorApiKey, APP_CONFIG.requireApiKey);
    if (rejection) {
        logger.error('listen', new Error(rejection));
        process.exit(1);
    }
    app.mcp.startReaper();
    app.httpServer.listen(APP_CONFIG.httpPort, APP_CONFIG.httpHost, () => {
        logger.info(`Web console: http://${APP_CONFIG.httpHost}:${APP_CONFIG.httpPort}/`);
        if (!process.argv.includes('--stdio')) {
            logger.info(`MCP endpoint: http://${APP_CONFIG.httpHost}:${APP_CONFIG.httpPort}${APP_CONFIG.mcpPath}`);
        }
        logger.info('Operator replies are delivered unchanged.');
        logger.info(`API key auth: ${APP_CONFIG.requireApiKey ? 'enabled' : 'disabled'}`);
        logger.info(`Rate limiting: ${APP_CONFIG.rateLimitMax > 0 ? `${APP_CONFIG.rateLimitMax} req/${APP_CONFIG.rateLimitWindowSeconds}s` : 'disabled'}`);
        if (process.argv.includes('--stdio')) {
            const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js') as typeof import('@modelcontextprotocol/sdk/server/stdio.js');
            const stdioMcpServer = new TurnWaitMcpServer(app.waitStore, () => 'stdio-0');
            const stdioTransport = new StdioServerTransport();
            stdioTransport.onclose = () => {
                logger.info('Stdio MCP transport closed — shutting down');
                app.shutdown().finally(() => process.exit(0));
            };
            stdioMcpServer.connect(stdioTransport).then(() => {
                logger.info('Stdio MCP transport connected (stdout reserved for MCP protocol)');
            }).catch((error: unknown) => {
                logger.error('stdio transport connect', error);
            });
        }
    });
    const onSignal = (): void => {
        app.shutdown()
            .then(() => process.exit(0))
            .catch((error) => {
                logger.error('shutdown', error);
                process.exit(1);
            });
    };
    process.on('SIGINT', onSignal);
    process.on('SIGTERM', onSignal);
    process.on('SIGHUP', onSignal);
}
