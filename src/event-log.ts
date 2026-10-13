import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'fs';
import * as path from 'path';
import { APP_CONFIG, Logger } from './config.js';
export class EventLogger {
    private readonly logger = new Logger('EventLog');
    private readonly filePath: string | null;
    private readonly cache: Array<Record<string, unknown>> = [];
    private readonly typeCountCache = new Map<string, number>();
    constructor() {
        this.filePath = APP_CONFIG.eventLogFile || null;
        if (this.filePath) {
            try {
                mkdirSync(path.dirname(this.filePath), { recursive: true });
                this.logger.info(`Event log file enabled: ${this.filePath}`);
            }
            catch (error) {
                this.logger.error('init event log file', error);
            }
            this.loadFromFile();
        }
    }
    private loadFromFile(): void {
        if (!this.filePath || !existsSync(this.filePath)) {
            return;
        }
        try {
            const raw = readFileSync(this.filePath, 'utf-8');
            const lines = raw
                .split(/\r?\n/)
                .map((line) => line.trim())
                .filter((line) => line.length > 0);
            const parsed: Array<Record<string, unknown>> = [];
            for (const line of lines) {
                try {
                    parsed.push(JSON.parse(line) as Record<string, unknown>);
                }
                catch {
                }
            }
            const kept = parsed.slice(-APP_CONFIG.eventLogMaxItems);
            kept.reverse();
            this.cache.push(...kept);
            for (const item of kept) {
                const rawType = typeof item.type === 'string' ? item.type.trim() : '';
                if (rawType) {
                    this.typeCountCache.set(rawType, (this.typeCountCache.get(rawType) || 0) + 1);
                }
            }
            this.logger.info(`Loaded ${kept.length} events into cache`);
        }
        catch (error) {
            this.logger.error('load event log file into cache', error);
        }
    }
    private remember(record: Record<string, unknown>): void {
        this.cache.unshift(record);
        const rawType = typeof record.type === 'string' ? record.type.trim() : '';
        if (rawType) {
            this.typeCountCache.set(rawType, (this.typeCountCache.get(rawType) || 0) + 1);
        }
        while (this.cache.length > APP_CONFIG.eventLogMaxItems) {
            const dropped = this.cache.pop();
            const droppedType = dropped && typeof dropped.type === 'string' ? dropped.type.trim() : '';
            if (!droppedType) {
                continue;
            }
            const next = (this.typeCountCache.get(droppedType) || 1) - 1;
            if (next <= 0) {
                this.typeCountCache.delete(droppedType);
            }
            else {
                this.typeCountCache.set(droppedType, next);
            }
        }
    }
    log(type: string, data: Record<string, unknown> = {}): void {
        const record = {
            ts: new Date().toISOString(),
            type,
            data,
        };
        const line = JSON.stringify(record);
        this.logger.info(line);
        this.remember(record);
        if (!this.filePath) {
            return;
        }
        try {
            appendFileSync(this.filePath, `${line}\n`, 'utf-8');
        }
        catch (error) {
            this.logger.error('append event log', error);
        }
    }
    isFileEnabled(): boolean {
        return Boolean(this.filePath);
    }
    tail(limit: number): Array<Record<string, unknown>> {
        return this.query(limit, 0).events;
    }
    query(limit: number, offset: number, type?: string): {
        events: Array<Record<string, unknown>>;
        total: number;
        hasMore: boolean;
        limit: number;
        offset: number;
        filterType: string | null;
        availableTypes: string[];
        typeCounts: Record<string, number>;
    } {
        const safeLimit = Number.isInteger(limit) ? Math.max(1, Math.min(1000, limit)) : 200;
        const safeOffset = Number.isInteger(offset) ? Math.max(0, offset) : 0;
        const normalizedType = (type || '').trim();
        const safeType = normalizedType.length > 0 ? normalizedType : undefined;
        const availableTypes = Array.from(this.typeCountCache.keys()).sort((a, b) => a.localeCompare(b));
        const typeCounts: Record<string, number> = {};
        for (const eventType of availableTypes) {
            typeCounts[eventType] = this.typeCountCache.get(eventType) || 0;
        }
        const filtered = safeType
            ? this.cache.filter((item) => typeof item.type === 'string' && item.type === safeType)
            : this.cache;
        const events = filtered.slice(safeOffset, safeOffset + safeLimit);
        const total = filtered.length;
        return {
            events,
            total,
            hasMore: safeOffset + events.length < total,
            limit: safeLimit,
            offset: safeOffset,
            filterType: safeType || null,
            availableTypes,
            typeCounts,
        };
    }
}
