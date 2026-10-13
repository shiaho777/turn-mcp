import { IncomingMessage } from 'http';
import { APP_CONFIG } from './config.js';

export function readJsonBody(req: IncomingMessage): Promise<unknown> {
    return new Promise((resolve, reject) => {
        const chunks: Buffer[] = [];
        let totalBytes = 0;
        let settled = false;
        let tooLarge = false;
        const safeReject = (error: Error): void => {
            if (settled) {
                return;
            }
            settled = true;
            reject(error);
        };
        const safeResolve = (value: unknown): void => {
            if (settled) {
                return;
            }
            settled = true;
            resolve(value);
        };
        req.on('data', (chunk: Buffer) => {
            if (tooLarge) {
                return;
            }
            totalBytes += chunk.length;
            if (totalBytes > APP_CONFIG.maxBodyBytes) {
                tooLarge = true;
                req.resume();
                safeReject(new Error(`Request body too large. Limit: ${APP_CONFIG.maxBodyBytes} bytes.`));
                return;
            }
            chunks.push(chunk);
        });
        req.on('end', () => {
            if (tooLarge) {
                return;
            }
            try {
                const raw = Buffer.concat(chunks).toString('utf-8').trim();
                if (!raw) {
                    safeResolve(undefined);
                    return;
                }
                safeResolve(JSON.parse(raw));
            }
            catch (error) {
                safeReject(error instanceof Error ? error : new Error(String(error)));
            }
        });
        req.on('aborted', () => safeReject(new Error('Request aborted.')));
        req.on('error', (error) => safeReject(error instanceof Error ? error : new Error(String(error))));
    });
}
