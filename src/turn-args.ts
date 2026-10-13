export interface TurnArgs {
    context: string;
    question?: string;
    timeoutSeconds?: number;
    options?: string[];
    agentName?: string;
}

export function parseTurnArgs(raw: Record<string, unknown> | undefined): { ok: true; args: TurnArgs } | { ok: false; error: string } {
    const context = raw?.context;
    if (typeof context !== 'string' || context.trim().length === 0) {
        return { ok: false, error: 'Invalid args: "context" must be a non-empty string.' };
    }
    const question = raw?.question;
    if (question !== undefined && typeof question !== 'string') {
        return { ok: false, error: 'Invalid args: "question" must be a string when provided.' };
    }
    const timeoutSeconds = raw?.timeoutSeconds;
    if (timeoutSeconds !== undefined) {
        if (!Number.isInteger(timeoutSeconds) || Number(timeoutSeconds) < 10 || Number(timeoutSeconds) > 3600) {
            return { ok: false, error: 'Invalid args: "timeoutSeconds" must be an integer between 10 and 3600.' };
        }
    }
    const options = raw?.options;
    if (options !== undefined) {
        if (!Array.isArray(options) ||
            options.length > 10 ||
            !options.every((item) => typeof item === 'string' && item.trim().length > 0 && item.length <= 200)) {
            return { ok: false, error: 'Invalid args: "options" must be an array of up to 10 non-empty strings (max 200 chars each).' };
        }
    }
    const agentName = raw?.agentName;
    if (agentName !== undefined) {
        if (typeof agentName !== 'string' || agentName.length > 100) {
            return { ok: false, error: 'Invalid args: "agentName" must be a string of at most 100 chars when provided.' };
        }
    }
    const parsedOptions = Array.isArray(options)
        ? options.map((item) => String(item).trim()).filter(Boolean)
        : undefined;
    return {
        ok: true,
        args: {
            context: context.trim(),
            question: typeof question === 'string' && question.trim() ? question.trim() : undefined,
            timeoutSeconds: typeof timeoutSeconds === 'number' ? timeoutSeconds : undefined,
            options: parsedOptions && parsedOptions.length > 0 ? parsedOptions : undefined,
            agentName: typeof agentName === 'string' && agentName.trim() ? agentName.trim() : undefined,
        },
    };
}
