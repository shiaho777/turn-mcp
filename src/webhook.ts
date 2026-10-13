import { createHmac } from 'crypto';
import * as http from 'http';
import * as https from 'https';
import { APP_CONFIG, Logger } from './config.js';
import { webhookUrlError } from './net-policy.js';
const logger = new Logger('Webhook');
const TIMEOUT_MS = 5000;

function escapeHtml(value: string): string {
    return value
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}
const MAX_RETRIES = 3;
const RETRY_BASE_MS = 1000;
function buildSlackPayload(event: {
    type: string;
    [key: string]: unknown;
}): string {
    const ts = new Date().toISOString();
    const fields: Array<{
        type: string;
        text: {
            type: string;
            text: string;
        };
    }> = [
        { type: 'mrkdwn', text: { type: 'mrkdwn', text: `*Event:* \`${event.type}\`` } },
        { type: 'mrkdwn', text: { type: 'mrkdwn', text: `*Time:* ${ts}` } },
    ];
    if (event.sessionId)
        fields.push({ type: 'mrkdwn', text: { type: 'mrkdwn', text: `*Session:* \`${String(event.sessionId).slice(0, 20)}\`` } });
    if (event.context)
        fields.push({ type: 'mrkdwn', text: { type: 'mrkdwn', text: `*Context:* ${String(event.context).slice(0, 200)}` } });
    if (event.question)
        fields.push({ type: 'mrkdwn', text: { type: 'mrkdwn', text: `*Question:* ${String(event.question).slice(0, 200)}` } });
    return JSON.stringify({
        text: `Turn MCP: \`${event.type}\``,
        blocks: [{ type: 'section', fields: fields.map(f => f.text) }],
    });
}
function buildDiscordPayload(event: {
    type: string;
    [key: string]: unknown;
}): string {
    const lines: string[] = [];
    if (event['sessionId'])
        lines.push(`**Session:** \`${String(event['sessionId']).slice(0, 20)}\``);
    if (event['context'])
        lines.push(`**Context:** ${String(event['context']).slice(0, 300)}`);
    if (event['question'])
        lines.push(`**Question:** ${String(event['question']).slice(0, 200)}`);
    return JSON.stringify({
        embeds: [{
                title: `Turn MCP: \`${event.type}\``,
                description: lines.join('\n') || `Event type: ${event.type}`,
                color: 5814783,
                timestamp: new Date().toISOString(),
            }],
    });
}
export class WebhookNotifier {
    private readonly url: string;
    private readonly events: Set<string>;
    private readonly secret: string;
    private readonly format: 'json' | 'slack' | 'discord';
    constructor(url: string, eventsFilter: string) {
        const urlError = webhookUrlError(url);
        if (urlError) {
            throw new Error(urlError);
        }
        this.url = url;
        const parsed = eventsFilter.split(',').map((s) => s.trim()).filter((s) => s.length > 0);
        this.events = new Set(parsed.length > 0 ? parsed : ['wait_created']);
        this.secret = APP_CONFIG.webhookSecret;
        this.format = APP_CONFIG.webhookFormat;
        logger.info(`Webhook enabled: ${url} (events: ${Array.from(this.events).join(',')}, format: ${this.format}, hmac: ${this.secret ? 'yes' : 'no'})`);
    }
    notify(event: {
        type: string;
        [key: string]: unknown;
    }): void {
        if (!this.events.has(event.type))
            return;
        const payload = this.format === 'slack' ? buildSlackPayload(event) :
            this.format === 'discord' ? buildDiscordPayload(event) :
                JSON.stringify({ type: event.type, ts: new Date().toISOString(), data: event });
        this.sendWithRetry(payload, event.type, 0);
    }
    private sendWithRetry(payload: string, eventType: string, attempt: number): void {
        const urlObj = new URL(this.url);
        const isHttps = urlObj.protocol === 'https:';
        const byteLen = Buffer.byteLength(payload);
        const headers: Record<string, string | number> = {
            'content-type': 'application/json',
            'content-length': byteLen,
            'x-turn-mcp-event': eventType,
        };
        if (this.secret) {
            const sig = createHmac('sha256', this.secret).update(payload).digest('hex');
            headers['x-turn-mcp-signature'] = `sha256=${sig}`;
        }
        const options: http.RequestOptions = {
            hostname: urlObj.hostname,
            port: urlObj.port || (isHttps ? 443 : 80),
            path: urlObj.pathname + urlObj.search,
            method: 'POST',
            headers,
            timeout: TIMEOUT_MS,
        };
        const retry = (reason: string): void => {
            if (attempt < MAX_RETRIES) {
                const delay = RETRY_BASE_MS * Math.pow(2, attempt);
                logger.warn(`Webhook ${eventType} ${reason}, retry ${attempt + 1}/${MAX_RETRIES} in ${delay}ms`);
                setTimeout(() => this.sendWithRetry(payload, eventType, attempt + 1), delay);
            }
            else {
                logger.error(`webhook ${eventType} failed after ${MAX_RETRIES + 1} attempts`, new Error(reason));
            }
        };
        const transport = isHttps ? https : http;
        const req = transport.request(options, (res) => {
            res.resume();
            logger.info(`Webhook ${eventType} -> ${res.statusCode} (attempt ${attempt + 1})`);
            if (res.statusCode && res.statusCode >= 500)
                retry(`HTTP ${res.statusCode}`);
        });
        req.on('error', (err) => retry(err.message));
        req.on('timeout', () => { req.destroy(); retry('timeout'); });
        req.write(payload);
        req.end();
    }
}
export class TelegramNotifier {
    private readonly events: Set<string>;
    constructor(private readonly botToken: string, private readonly chatId: string, eventsFilter: string) {
        const parsed = eventsFilter.split(',').map(s => s.trim()).filter(Boolean);
        this.events = new Set(parsed.length > 0 ? parsed : ['wait_created']);
        logger.info(`Telegram notifications enabled (events: ${Array.from(this.events).join(',')})`);
    }
    notify(event: {
        type: string;
        [key: string]: unknown;
    }): void {
        if (!this.events.has(event.type))
            return;
        const lines: string[] = [`<b>Turn MCP: ${escapeHtml(event.type)}</b>\n`];
        if (event['sessionId'])
            lines.push(`🔑 Session: <code>${escapeHtml(String(event['sessionId']).slice(0, 20))}</code>`);
        if (event['agentName'])
            lines.push(`🤖 Agent: <b>${escapeHtml(String(event['agentName']))}</b>`);
        if (event['context'])
            lines.push(`\n${escapeHtml(String(event['context']).slice(0, 800))}`);
        if (event['question'])
            lines.push(`\n❓ ${escapeHtml(String(event['question']).slice(0, 200))}`);
        const text = lines.join('\n');
        const payload = JSON.stringify({ chat_id: this.chatId, text, parse_mode: 'HTML' });
        const urlObj = new URL(`https://api.telegram.org/bot${this.botToken}/sendMessage`);
        const options: http.RequestOptions = {
            hostname: urlObj.hostname,
            path: urlObj.pathname,
            method: 'POST',
            headers: {
                'content-type': 'application/json',
                'content-length': Buffer.byteLength(payload),
            },
            timeout: 8000,
        };
        const req = https.request(options, (res) => {
            res.resume();
            logger.info(`Telegram ${event.type} -> ${res.statusCode}`);
        });
        req.on('error', (err) => logger.error(`telegram ${event.type}`, err));
        req.on('timeout', () => req.destroy());
        req.write(payload);
        req.end();
    }
}
