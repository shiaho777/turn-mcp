import * as fs from 'node:fs';
import * as path from 'node:path';
export type ToolName = 'turn.wait' | 'turn_wait' | 'turn';
function parseIntEnv(name: string, fallback: number, min: number, max: number): number {
    const raw = process.env[name];
    if (!raw) {
        return fallback;
    }
    const parsed = Number(raw);
    if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
        return fallback;
    }
    return parsed;
}
function parseBooleanEnv(name: string, fallback: boolean): boolean {
    const raw = process.env[name];
    if (!raw) {
        return fallback;
    }
    const normalized = raw.trim().toLowerCase();
    if (['1', 'true', 'yes', 'y', 'on'].includes(normalized)) {
        return true;
    }
    if (['0', 'false', 'no', 'n', 'off'].includes(normalized)) {
        return false;
    }
    return fallback;
}
const configuredOperatorApiKey = (process.env.TURN_MCP_API_KEY || '').trim();
const configuredViewerApiKey = (process.env.TURN_MCP_VIEWER_API_KEY || '').trim();
const hasAnyConfiguredKey = configuredOperatorApiKey.length > 0 || configuredViewerApiKey.length > 0;
function parseWebhookFormat(raw: string | undefined): 'json' | 'slack' | 'discord' {
    const v = raw?.trim().toLowerCase();
    if (v === 'slack')
        return 'slack';
    if (v === 'discord')
        return 'discord';
    return 'json';
}
export const APP_CONFIG = {
    name: 'turn-mcp-web',
    version: '0.1.0',
    toolNames: ['turn.wait', 'turn_wait', 'turn'] as const satisfies readonly ToolName[],
    httpHost: process.env.TURN_MCP_HTTP_HOST || '127.0.0.1',
    httpPort: parseIntEnv('TURN_MCP_HTTP_PORT', 3737, 1, 65535),
    mcpPath: process.env.TURN_MCP_HTTP_PATH || '/mcp',
    maxBodyBytes: parseIntEnv('TURN_MCP_HTTP_MAX_BODY_BYTES', 1024 * 1024, 1024, 50 * 1024 * 1024),
    defaultTimeoutSeconds: parseIntEnv('TURN_MCP_DEFAULT_TIMEOUT_SECONDS', 600, 0, 3600),
    maxUserMessageChars: parseIntEnv('TURN_MCP_MAX_USER_MESSAGE_CHARS', 40000, 1000, 500000),
    waitHistoryMaxItems: parseIntEnv('TURN_MCP_WAIT_HISTORY_MAX_ITEMS', 500, 10, 10000),
    operatorApiKey: configuredOperatorApiKey,
    viewerApiKey: configuredViewerApiKey,
    requireApiKey: parseBooleanEnv('TURN_MCP_REQUIRE_API_KEY', hasAnyConfiguredKey),
    eventLogFile: (process.env.TURN_MCP_EVENT_LOG_FILE || '').trim(),
    historyFile: (process.env.TURN_MCP_HISTORY_FILE || '').trim(),
    webhookUrl: (process.env.TURN_MCP_WEBHOOK_URL || '').trim(),
    webhookEvents: (process.env.TURN_MCP_WEBHOOK_EVENTS || '').trim(),
    webhookSecret: (process.env.TURN_MCP_WEBHOOK_SECRET || '').trim(),
    webhookFormat: parseWebhookFormat(process.env.TURN_MCP_WEBHOOK_FORMAT),
    telegramBotToken: (process.env.TURN_MCP_TELEGRAM_BOT_TOKEN || '').trim(),
    telegramChatId: (process.env.TURN_MCP_TELEGRAM_CHAT_ID || '').trim(),
    telegramEvents: (process.env.TURN_MCP_TELEGRAM_EVENTS || 'wait_created').trim(),
    rateLimitMax: parseIntEnv('TURN_MCP_RATE_LIMIT_MAX', 120, 0, 100000),
    rateLimitWindowSeconds: parseIntEnv('TURN_MCP_RATE_LIMIT_WINDOW_SECONDS', 60, 1, 3600),
    maxConcurrentWaitsPerSession: parseIntEnv('TURN_MCP_MAX_CONCURRENT_WAITS_PER_SESSION', 10, 1, 100),
    maxPendingWaits: parseIntEnv('TURN_MCP_MAX_PENDING_WAITS', 100, 1, 10000),
    maxContextChars: parseIntEnv('TURN_MCP_MAX_CONTEXT_CHARS', 100000, 1000, 500000),
    eventLogMaxItems: parseIntEnv('TURN_MCP_EVENT_LOG_MAX_ITEMS', 2000, 100, 100000),
};
export const runtimeConfig = {
    timeoutEnabled: APP_CONFIG.defaultTimeoutSeconds > 0,
    defaultTimeoutSeconds: APP_CONFIG.defaultTimeoutSeconds,
    webhookUrl: APP_CONFIG.webhookUrl,
    webhookEvents: APP_CONFIG.webhookEvents,
};
export function settingsFilePath(): string {
    const override = (process.env.TURN_MCP_SETTINGS_FILE || '').trim();
    return override || path.join(process.cwd(), '.turn-mcp-settings.json');
}
export function loadSettings(): void {
    try {
        const raw = fs.readFileSync(settingsFilePath(), 'utf-8');
        const data = JSON.parse(raw) as Record<string, unknown>;
        if (typeof data.timeoutEnabled === 'boolean') {
            runtimeConfig.timeoutEnabled = data.timeoutEnabled;
        }
        if (typeof data.defaultTimeoutSeconds === 'number') {
            const val = Math.floor(data.defaultTimeoutSeconds);
            if (val >= 0 && val <= 3600) {
                runtimeConfig.defaultTimeoutSeconds = val;
            }
        }
        if (typeof data.webhookUrl === 'string') {
            runtimeConfig.webhookUrl = data.webhookUrl;
        }
        if (typeof data.webhookEvents === 'string') {
            runtimeConfig.webhookEvents = data.webhookEvents;
        }
    }
    catch {
    }
}
export function saveSettings(): void {
    try {
        const data = {
            timeoutEnabled: runtimeConfig.timeoutEnabled,
            defaultTimeoutSeconds: runtimeConfig.defaultTimeoutSeconds,
            webhookUrl: runtimeConfig.webhookUrl,
            webhookEvents: runtimeConfig.webhookEvents,
        };
        fs.writeFileSync(settingsFilePath(), JSON.stringify(data, null, 2), 'utf-8');
    }
    catch {
    }
}
export let isStdioMode = false;
export function setStdioMode(val: boolean): void { isStdioMode = val; }
export class Logger {
    constructor(private readonly scope: string) { }
    info(message: string): void {
        const line = `[${this.scope}] ${message}\n`;
        if (isStdioMode) {
            process.stderr.write(line);
        }
        else {
            process.stdout.write(line);
        }
    }
    warn(message: string): void {
        const line = `[${this.scope}] [WARN] ${message}\n`;
        if (isStdioMode) {
            process.stderr.write(line);
        }
        else {
            process.stderr.write(line);
        }
    }
    error(context: string, err: unknown): void {
        const message = err instanceof Error ? err.message : String(err);
        process.stderr.write(`[${this.scope}] [ERROR] ${context}: ${message}\n`);
    }
}
