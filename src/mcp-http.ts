import { randomUUID } from 'crypto';
import { IncomingMessage, ServerResponse } from 'http';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { Logger } from './config.js';
import type { EventLogger } from './event-log.js';
import { rejectUnauthorized } from './http-auth.js';
import { headerString, sendJsonRpcError } from './http-util.js';
import { readJsonBody } from './read-body.js';
import { TurnWaitMcpServer } from './turn-mcp-server.js';
import type { WaitStore } from './wait-store.js';

const SESSION_IDLE_TIMEOUT_MS = 30 * 60 * 1000;
const SESSION_CLEANUP_INTERVAL_MS = 5 * 60 * 1000;

interface SessionContext {
    transport: StreamableHTTPServerTransport;
    server: TurnWaitMcpServer;
    sessionRef: { id: string | null };
    lastActivityAt: number;
}

export class McpGateway {
    private readonly sessions = new Map<string, SessionContext>();
    private readonly logger = new Logger('McpGateway');
    private cleanupTimer: NodeJS.Timeout | null = null;
    constructor(private readonly waitStore: WaitStore, private readonly eventLogger: EventLogger) {}
    get activeSessions(): number {
        return this.sessions.size;
    }
    startReaper(): void {
        this.cleanupTimer = setInterval(() => {
            const now = Date.now();
            for (const [sid, ctx] of this.sessions) {
                if (now - ctx.lastActivityAt <= SESSION_IDLE_TIMEOUT_MS) {
                    continue;
                }
                this.logger.info(`Reaping idle MCP session: ${sid}`);
                this.eventLogger.log('mcp_session_reaped', { sessionId: sid });
                this.sessions.delete(sid);
                this.waitStore.interruptSession(sid, 'session-closed');
                ctx.transport.close().catch((error) => this.logger.error('reap transport.close', error));
                ctx.server.close().catch((error) => this.logger.error('reap server.close', error));
            }
        }, SESSION_CLEANUP_INTERVAL_MS);
        if (typeof this.cleanupTimer.unref === 'function') {
            this.cleanupTimer.unref();
        }
    }
    stopReaper(): void {
        if (this.cleanupTimer) {
            clearInterval(this.cleanupTimer);
            this.cleanupTimer = null;
        }
    }
    async closeAll(): Promise<void> {
        const closing = Array.from(this.sessions.entries()).map(async ([sid, { transport, server }]) => {
            this.waitStore.interruptSession(sid, 'session-closed');
            this.sessions.delete(sid);
            try {
                await transport.close();
            }
            catch (error) {
                this.logger.error('transport.close', error);
            }
            try {
                await server.close();
            }
            catch (error) {
                this.logger.error('server.close', error);
            }
        });
        await Promise.allSettled(closing);
        this.sessions.clear();
    }
    async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
        if (req.method === 'OPTIONS') {
            res.statusCode = 204;
            res.end();
            return;
        }
        if (!rejectUnauthorized(req, res, this.eventLogger, 'mcp', req.url || '', 'operator', true)) {
            return;
        }
        if (req.method === 'POST') {
            const contentType = req.headers['content-type'];
            if (typeof contentType === 'string' && !contentType.includes('application/json')) {
                throw new Error(`Unsupported content-type: ${contentType}`);
            }
            const body = await readJsonBody(req);
            const context = await this.getOrCreateSession(req, body);
            context.lastActivityAt = Date.now();
            await context.transport.handleRequest(req, res, body);
            return;
        }
        if (req.method === 'GET' || req.method === 'DELETE') {
            const sessionId = headerString(req, 'mcp-session-id');
            if (!sessionId) {
                throw new Error('Missing session ID.');
            }
            const context = this.sessions.get(sessionId);
            if (!context) {
                throw new Error(`Invalid session: ${sessionId}`);
            }
            context.lastActivityAt = Date.now();
            await context.transport.handleRequest(req, res);
            return;
        }
        sendJsonRpcError(res, 405, `Method not allowed: ${req.method}`);
    }
    private async getOrCreateSession(req: IncomingMessage, body: unknown): Promise<SessionContext> {
        const sessionId = headerString(req, 'mcp-session-id');
        if (sessionId) {
            const existing = this.sessions.get(sessionId);
            if (!existing) {
                throw new Error(`Invalid session: ${sessionId}`);
            }
            return existing;
        }
        if (!isInitializeRequest(body)) {
            throw new Error('No valid session ID provided.');
        }
        const sessionRef: { id: string | null } = { id: null };
        const mcpServer = new TurnWaitMcpServer(this.waitStore, () => sessionRef.id || 'pending-session');
        const transport = new StreamableHTTPServerTransport({
            sessionIdGenerator: () => randomUUID(),
            onsessioninitialized: (newSessionId) => {
                sessionRef.id = newSessionId;
                this.sessions.set(newSessionId, {
                    transport,
                    server: mcpServer,
                    sessionRef,
                    lastActivityAt: Date.now(),
                });
                this.logger.info(`MCP session initialized: ${newSessionId}`);
                this.eventLogger.log('mcp_session_initialized', { sessionId: newSessionId });
            },
        });
        transport.onclose = () => {
            const sid = sessionRef.id || transport.sessionId || undefined;
            if (sid && this.sessions.delete(sid)) {
                this.waitStore.interruptSession(sid, 'session-closed');
                this.logger.info(`MCP session closed: ${sid}`);
                this.eventLogger.log('mcp_session_closed', { sessionId: sid });
            }
            mcpServer.close().catch((error) => this.logger.error('close mcp server', error));
        };
        await mcpServer.connect(transport);
        return {
            transport,
            server: mcpServer,
            sessionRef,
            lastActivityAt: Date.now(),
        };
    }
}
