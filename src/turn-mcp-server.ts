import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { APP_CONFIG, runtimeConfig, Logger } from './config.js';
import { parseTurnArgs } from './turn-args.js';
import { WaitStore } from './wait-store.js';

const logger = new Logger('TurnMcpServer');
const TOOL_DESCRIPTION = [
    'Pause this run until the operator replies in the Turn MCP browser console.',
    'The tool result is the operator\'s reply, unchanged.',
    'After you act on it, call this tool again at the next checkpoint unless they told you to stop.',
    'Other results are [timeout], [canceled], [interrupted], or [busy].',
    '暂停当前运行，直到操作者在浏览器控制台回复。返回文本就是对方的原话。',
    '处理完后，除非对方要求停止，否则在下一个卡点再次调用。',
].join('\n');
const TURN_INPUT_SCHEMA = {
    type: 'object',
    properties: {
        context: {
            type: 'string',
            description: 'What you finished, what you found, and what happens next. Required. Write it for someone who has not seen the logs.',
        },
        question: {
            type: 'string',
            description: 'The one decision or fact you need. Optional.',
        },
        timeoutSeconds: {
            type: 'integer',
            minimum: 10,
            maximum: 3600,
            description: 'How long to wait for this reply, in seconds. Optional.',
        },
        options: {
            type: 'array',
            items: { type: 'string', maxLength: 200 },
            maxItems: 10,
            description: 'Reply buttons, when the choices are already known. Optional.',
        },
        agentName: {
            type: 'string',
            maxLength: 100,
            description: 'Stable name for the calling agent. Optional.',
        },
    },
    required: ['context'],
    additionalProperties: false,
} as const;

export class TurnWaitMcpServer {
    private readonly server: Server;
    constructor(private readonly waitStore: WaitStore, private readonly getSessionId: () => string) {
        this.server = new Server({ name: APP_CONFIG.name, version: APP_CONFIG.version }, { capabilities: { tools: {} } });
        this.setupHandlers();
    }
    async connect(transport: Transport): Promise<void> {
        await this.server.connect(transport);
    }
    async close(): Promise<void> {
        await this.server.close();
    }
    private setupHandlers(): void {
        this.server.setRequestHandler(ListToolsRequestSchema, async () => {
            return {
                tools: APP_CONFIG.toolNames.map((name) => ({
                    name,
                    description: TOOL_DESCRIPTION,
                    inputSchema: TURN_INPUT_SCHEMA,
                })),
            };
        });
        this.server.setRequestHandler(CallToolRequestSchema, async (request: {
            params: {
                name: string;
                arguments?: Record<string, unknown>;
            };
        }) => {
            if (!APP_CONFIG.toolNames.includes(request.params.name as (typeof APP_CONFIG.toolNames)[number])) {
                return {
                    content: [{ type: 'text' as const, text: `Unknown tool: ${request.params.name}` }],
                    isError: true,
                };
            }
            const parsed = parseTurnArgs(request.params.arguments);
            if (!parsed.ok) {
                return {
                    content: [{ type: 'text' as const, text: parsed.error }],
                    isError: true,
                };
            }
            if (parsed.args.context.length > APP_CONFIG.maxContextChars) {
                return {
                    content: [{ type: 'text' as const, text: `Invalid args: "context" exceeds ${APP_CONFIG.maxContextChars} characters.` }],
                    isError: true,
                };
            }
            const effectiveTimeout = runtimeConfig.timeoutEnabled
                ? (parsed.args.timeoutSeconds || runtimeConfig.defaultTimeoutSeconds)
                : 0;
            const sessionId = this.getSessionId();
            const resolution = await this.waitStore.waitForResponse({
                sessionId,
                context: parsed.args.context,
                question: parsed.args.question,
                options: parsed.args.options,
                agentName: parsed.args.agentName,
                timeoutMs: effectiveTimeout * 1000,
            });
            if (resolution.kind === 'timeout') {
                return { content: [{ type: 'text' as const, text: '[timeout] The operator did not reply before the deadline. Call turn.wait again when you are ready.' }] };
            }
            if (resolution.kind === 'canceled') {
                return { content: [{ type: 'text' as const, text: '[canceled] The operator canceled this wait in the console.' }] };
            }
            if (resolution.kind === 'interrupted') {
                const text = resolution.reason === 'shutdown'
                    ? '[interrupted] The server shut down while this wait was pending. Call turn.wait again after it is back.'
                    : '[interrupted] This session ended while waiting. Call turn.wait again to continue.';
                return { content: [{ type: 'text' as const, text }] };
            }
            if (resolution.kind === 'busy') {
                const limit = resolution.scope === 'global'
                    ? APP_CONFIG.maxPendingWaits
                    : APP_CONFIG.maxConcurrentWaitsPerSession;
                return {
                    content: [{
                        type: 'text' as const,
                        text: `[busy] Too many waits are already open (${resolution.scope} limit ${limit}). Active wait IDs: ${resolution.activeWaitIds.join(', ')}`,
                    }],
                };
            }
            logger.info(`Resolved wait response for session=${sessionId}, len=${resolution.text.length}`);
            return { content: [{ type: 'text' as const, text: resolution.text }] };
        });
    }
}
