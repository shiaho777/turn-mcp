import { randomUUID } from 'crypto';
import { APP_CONFIG } from './config.js';
import type { HistoryPersistence } from './history-persistence.js';

export type InterruptReason = 'shutdown' | 'session-closed';

export interface WaitSummary {
    id: string;
    sessionId: string;
    context: string;
    question?: string;
    options?: string[];
    agentName?: string;
    createdAt: number;
    expiresAt: number;
}
export interface WaitHistoryItem extends WaitSummary {
    resolvedAt: number;
    resolution: 'message' | 'timeout' | 'canceled' | 'interrupted';
    finalMessageLength: number;
    userMessage?: string;
    interruptReason?: InterruptReason;
}
export interface WaitHistoryQuery {
    limit?: number;
    offset?: number;
    sessionId?: string;
    resolution?: WaitHistoryItem['resolution'];
    keyword?: string;
}
export interface SessionSummary {
    sessionId: string;
    interactionCount: number;
    lastActivity: number;
    status: 'pending' | 'message' | 'timeout' | 'canceled' | 'interrupted' | 'completed';
    pendingWaits?: WaitSummary[];
    pendingWait?: WaitSummary;
}
export type WaitResolution = {
    kind: 'message';
    text: string;
} | {
    kind: 'timeout';
} | {
    kind: 'canceled';
} | {
    kind: 'interrupted';
    reason: InterruptReason;
} | {
    kind: 'busy';
    scope: 'session' | 'global';
    activeWaitIds: string[];
};
export type WaitStoreEvent = {
    type: 'wait_created';
    waitId: string;
    sessionId: string;
    context: string;
    question?: string;
    options?: string[];
    agentName?: string;
    contextLength: number;
    hasQuestion: boolean;
    timeoutMs: number;
    createdAt: number;
    expiresAt: number;
} | {
    type: 'wait_busy';
    sessionId: string;
    activeWaitIds: string[];
    contextLength: number;
    scope: 'session' | 'global';
} | {
    type: 'wait_responded';
    waitId: string;
    sessionId: string;
    userMessageLength: number;
    finalMessageLength: number;
} | {
    type: 'wait_canceled';
    waitId: string;
    sessionId: string;
} | {
    type: 'wait_timeout';
    waitId: string;
    sessionId: string;
} | {
    type: 'wait_resolved';
    waitId: string;
    sessionId: string;
    resolution: 'message' | 'timeout' | 'canceled' | 'interrupted';
} | {
    type: 'wait_extended';
    waitId: string;
    sessionId: string;
    additionalSeconds: number;
    newExpiresAt: number;
} | {
    type: 'wait_interrupted';
    waitId: string;
    sessionId: string;
    reason: InterruptReason;
};
interface InternalWait {
    summary: WaitSummary;
    resolve: (resolution: WaitResolution) => void;
    timeoutTimer: NodeJS.Timeout | null;
    userMessage?: string;
}
export class WaitStore {
    private readonly waits = new Map<string, InternalWait>();
    private readonly sessionActiveWaits = new Map<string, Set<string>>();
    private readonly history: WaitHistoryItem[] = [];
    private readonly persistence?: HistoryPersistence;
    constructor(onEvent?: (event: WaitStoreEvent) => void, persistence?: HistoryPersistence);
    constructor(private readonly onEvent?: (event: WaitStoreEvent) => void, persistenceArg?: HistoryPersistence) {
        this.persistence = persistenceArg;
        if (this.persistence) {
            const loaded = this.persistence.load();
            loaded.sort((a, b) => b.resolvedAt - a.resolvedAt);
            const maxItems = APP_CONFIG.waitHistoryMaxItems;
            const trimmed = loaded.length > maxItems ? loaded.slice(0, maxItems) : loaded;
            this.history.push(...trimmed);
            if (loaded.length > maxItems) {
                this.persistence.rewrite(trimmed);
            }
        }
    }
    waitForResponse(input: {
        sessionId: string;
        context: string;
        question?: string;
        options?: string[];
        agentName?: string;
        timeoutMs: number;
    }): Promise<WaitResolution> {
        if (this.waits.size >= APP_CONFIG.maxPendingWaits) {
            const activeWaitIds = Array.from(this.waits.keys()).slice(0, 20);
            this.emit({
                type: 'wait_busy',
                sessionId: input.sessionId,
                activeWaitIds,
                contextLength: input.context.length,
                scope: 'global',
            });
            return Promise.resolve({ kind: 'busy', scope: 'global', activeWaitIds });
        }
        const activeSet = this.sessionActiveWaits.get(input.sessionId);
        if (activeSet && activeSet.size >= APP_CONFIG.maxConcurrentWaitsPerSession) {
            const activeWaitIds = Array.from(activeSet);
            this.emit({
                type: 'wait_busy',
                sessionId: input.sessionId,
                activeWaitIds,
                contextLength: input.context.length,
                scope: 'session',
            });
            return Promise.resolve({ kind: 'busy', scope: 'session', activeWaitIds });
        }
        const noTimeout = input.timeoutMs <= 0;
        const waitId = `wait_${randomUUID()}`;
        const now = Date.now();
        const summary: WaitSummary = {
            id: waitId,
            sessionId: input.sessionId,
            context: input.context,
            question: input.question,
            options: input.options,
            agentName: input.agentName,
            createdAt: now,
            expiresAt: noTimeout ? 0 : now + input.timeoutMs,
        };
        this.emit({
            type: 'wait_created',
            waitId,
            sessionId: input.sessionId,
            context: input.context.slice(0, 5000),
            question: input.question || undefined,
            options: input.options,
            agentName: input.agentName,
            contextLength: input.context.length,
            hasQuestion: Boolean(input.question && input.question.trim().length > 0),
            timeoutMs: input.timeoutMs,
            createdAt: summary.createdAt,
            expiresAt: summary.expiresAt,
        });
        return new Promise<WaitResolution>((outerResolve) => {
            let finished = false;
            const finish = (resolution: WaitResolution): void => {
                if (finished) {
                    return;
                }
                finished = true;
                const state = this.waits.get(waitId);
                if (state?.timeoutTimer) {
                    clearTimeout(state.timeoutTimer);
                }
                this.waits.delete(waitId);
                const sessionWaits = this.sessionActiveWaits.get(input.sessionId);
                if (sessionWaits) {
                    sessionWaits.delete(waitId);
                    if (sessionWaits.size === 0) {
                        this.sessionActiveWaits.delete(input.sessionId);
                    }
                }
                if (resolution.kind === 'message' || resolution.kind === 'timeout' || resolution.kind === 'canceled' || resolution.kind === 'interrupted') {
                    const userMsg = state?.userMessage;
                    this.pushHistory({
                        ...summary,
                        resolvedAt: Date.now(),
                        resolution: resolution.kind,
                        finalMessageLength: resolution.kind === 'message' ? resolution.text.length : 0,
                        userMessage: resolution.kind === 'message' ? (userMsg || '') : undefined,
                        interruptReason: resolution.kind === 'interrupted' ? resolution.reason : undefined,
                    });
                    this.emit({
                        type: 'wait_resolved',
                        waitId,
                        sessionId: input.sessionId,
                        resolution: resolution.kind,
                    });
                }
                outerResolve(resolution);
            };
            let timeoutTimer: NodeJS.Timeout | null = null;
            if (!noTimeout) {
                timeoutTimer = setTimeout(() => {
                    this.emit({
                        type: 'wait_timeout',
                        waitId,
                        sessionId: input.sessionId,
                    });
                    finish({ kind: 'timeout' });
                }, input.timeoutMs);
                if (typeof timeoutTimer.unref === 'function') {
                    timeoutTimer.unref();
                }
            }
            this.waits.set(waitId, {
                summary,
                resolve: finish,
                timeoutTimer,
            });
            const existing = this.sessionActiveWaits.get(input.sessionId) ?? new Set<string>();
            existing.add(waitId);
            this.sessionActiveWaits.set(input.sessionId, existing);
        });
    }
    listPendingWaits(): WaitSummary[] {
        return Array.from(this.waits.values())
            .map((item) => item.summary)
            .sort((a, b) => a.createdAt - b.createdAt);
    }
    listHistory(query: WaitHistoryQuery = {}): WaitHistoryItem[] {
        const { items } = this.queryHistory(query);
        return items;
    }
    countHistory(query: WaitHistoryQuery = {}): number {
        return this.filterHistory(query).length;
    }
    queryHistory(query: WaitHistoryQuery = {}): { items: WaitHistoryItem[]; total: number } {
        const rawLimit = query.limit;
        const safeLimit = Number.isInteger(rawLimit) ? Math.max(1, Math.min(1000, rawLimit as number)) : 100;
        const rawOffset = query.offset;
        const safeOffset = Number.isInteger(rawOffset) ? Math.max(0, rawOffset as number) : 0;
        const filtered = this.filterHistory(query);
        return {
            items: filtered.slice(safeOffset, safeOffset + safeLimit),
            total: filtered.length,
        };
    }
    private filterHistory(query: WaitHistoryQuery): WaitHistoryItem[] {
        const sessionFilter = (query.sessionId || '').trim();
        const resolutionFilter = query.resolution;
        const keywordFilter = (query.keyword || '').trim().toLowerCase();
        return this.history.filter((item) => {
            if (sessionFilter && !item.sessionId.includes(sessionFilter)) {
                return false;
            }
            if (resolutionFilter && item.resolution !== resolutionFilter) {
                return false;
            }
            if (keywordFilter) {
                const haystack = `${item.context}\n${item.question || ''}\n${item.userMessage || ''}`.toLowerCase();
                if (!haystack.includes(keywordFilter)) {
                    return false;
                }
            }
            return true;
        });
    }
    historyCount(): number {
        return this.history.length;
    }
    listSessionTimeline(sessionId: string): WaitHistoryItem[] {
        return this.history
            .filter((item) => item.sessionId === sessionId)
            .sort((a, b) => a.createdAt - b.createdAt);
    }
    listSessionSummaries(): SessionSummary[] {
        const map = new Map<string, SessionSummary>();
        const pendingBySession = new Map<string, WaitSummary[]>();
        for (const wait of this.waits.values()) {
            const list = pendingBySession.get(wait.summary.sessionId) ?? [];
            list.push(wait.summary);
            pendingBySession.set(wait.summary.sessionId, list);
        }
        for (const [sessionId, pending] of pendingBySession) {
            pending.sort((a, b) => a.createdAt - b.createdAt);
            map.set(sessionId, {
                sessionId,
                interactionCount: 0,
                lastActivity: pending[pending.length - 1].createdAt,
                status: 'pending',
                pendingWaits: pending,
                pendingWait: pending[0],
            });
        }
        for (const item of this.history) {
            const activityAt = item.resolvedAt || item.createdAt;
            const existing = map.get(item.sessionId);
            if (existing) {
                existing.interactionCount++;
                if (activityAt > existing.lastActivity) {
                    existing.lastActivity = activityAt;
                }
            }
            else {
                map.set(item.sessionId, {
                    sessionId: item.sessionId,
                    interactionCount: 1,
                    lastActivity: activityAt,
                    status: item.resolution,
                });
            }
        }
        return Array.from(map.values());
    }
    respond(waitId: string, userMessage: string): { ok: true } | { ok: false; reason: string } {
        const state = this.waits.get(waitId);
        if (!state) {
            return { ok: false, reason: 'wait-not-found' };
        }
        const trimmed = userMessage.trim();
        if (!trimmed) {
            return { ok: false, reason: 'empty-message' };
        }
        if (trimmed.length > APP_CONFIG.maxUserMessageChars) {
            return { ok: false, reason: `message-too-long(max=${APP_CONFIG.maxUserMessageChars})` };
        }
        state.userMessage = trimmed;
        this.emit({
            type: 'wait_responded',
            waitId,
            sessionId: state.summary.sessionId,
            userMessageLength: trimmed.length,
            finalMessageLength: trimmed.length,
        });
        state.resolve({ kind: 'message', text: trimmed });
        return { ok: true };
    }
    extend(waitId: string, additionalSeconds: number): { ok: true; newExpiresAt: number } | { ok: false; reason: string } {
        if (!Number.isInteger(additionalSeconds) || additionalSeconds < 30 || additionalSeconds > 3600) {
            return { ok: false, reason: 'invalid-seconds(range=30-3600)' };
        }
        const state = this.waits.get(waitId);
        if (!state) {
            return { ok: false, reason: 'wait-not-found' };
        }
        if (state.timeoutTimer) {
            clearTimeout(state.timeoutTimer);
        }
        const additionalMs = additionalSeconds * 1000;
        state.summary.expiresAt = Math.max(state.summary.expiresAt, Date.now()) + additionalMs;
        const newTimer = setTimeout(() => {
            this.emit({ type: 'wait_timeout', waitId, sessionId: state.summary.sessionId });
            state.resolve({ kind: 'timeout' });
        }, state.summary.expiresAt - Date.now());
        if (typeof newTimer.unref === 'function') {
            newTimer.unref();
        }
        state.timeoutTimer = newTimer;
        this.emit({
            type: 'wait_extended',
            waitId,
            sessionId: state.summary.sessionId,
            additionalSeconds,
            newExpiresAt: state.summary.expiresAt,
        });
        return { ok: true, newExpiresAt: state.summary.expiresAt };
    }
    cancelAll(): number {
        let count = 0;
        for (const [waitId] of Array.from(this.waits)) {
            if (this.cancel(waitId).ok) {
                count++;
            }
        }
        return count;
    }
    getPendingWait(waitId: string): WaitSummary | undefined {
        return this.waits.get(waitId)?.summary;
    }
    cancel(waitId: string): { ok: true } | { ok: false; reason: string } {
        const state = this.waits.get(waitId);
        if (!state) {
            return { ok: false, reason: 'wait-not-found' };
        }
        this.emit({
            type: 'wait_canceled',
            waitId,
            sessionId: state.summary.sessionId,
        });
        state.resolve({ kind: 'canceled' });
        return { ok: true };
    }
    interrupt(waitId: string, reason: InterruptReason): { ok: true } | { ok: false; reason: string } {
        const state = this.waits.get(waitId);
        if (!state) {
            return { ok: false, reason: 'wait-not-found' };
        }
        this.emit({
            type: 'wait_interrupted',
            waitId,
            sessionId: state.summary.sessionId,
            reason,
        });
        state.resolve({ kind: 'interrupted', reason });
        return { ok: true };
    }
    interruptSession(sessionId: string, reason: InterruptReason): number {
        let count = 0;
        for (const [waitId, state] of Array.from(this.waits)) {
            if (state.summary.sessionId !== sessionId) {
                continue;
            }
            if (this.interrupt(waitId, reason).ok) {
                count++;
            }
        }
        return count;
    }
    interruptAll(reason: InterruptReason): number {
        let count = 0;
        for (const [waitId] of Array.from(this.waits)) {
            if (this.interrupt(waitId, reason).ok) {
                count++;
            }
        }
        return count;
    }
    shutdownPersist(): void {
        this.interruptAll('shutdown');
    }
    private pushHistory(item: WaitHistoryItem): void {
        this.history.unshift(item);
        this.persistence?.append(item);
        if (this.history.length > APP_CONFIG.waitHistoryMaxItems) {
            this.history.length = APP_CONFIG.waitHistoryMaxItems;
            this.persistence?.rewrite(this.history);
        }
    }
    private emit(event: WaitStoreEvent): void {
        try {
            this.onEvent?.(event);
        }
        catch {
        }
    }
}
