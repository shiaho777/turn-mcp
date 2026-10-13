import assert from 'node:assert/strict';
import { mkdtempSync } from 'fs';
import http from 'http';
import { tmpdir } from 'os';
import path from 'path';
import { test } from 'node:test';
import { createApp } from '../src/app.js';

const settingsDir = mkdtempSync(path.join(tmpdir(), 'turn-mcp-http-'));
process.env.TURN_MCP_SETTINGS_FILE = path.join(settingsDir, 'settings.json');

function listen(app: ReturnType<typeof createApp>): Promise<number> {
    return new Promise((resolve) => {
        app.httpServer.listen(0, '127.0.0.1', () => {
            const address = app.httpServer.address();
            resolve(typeof address === 'object' && address ? address.port : 0);
        });
    });
}

function rawRequest(port: number, method: string, reqPath: string, headers: Record<string, string>, body?: string): Promise<{ status: number; headers: http.IncomingHttpHeaders; text: string }> {
    return new Promise((resolve, reject) => {
        const req = http.request({
            hostname: '127.0.0.1',
            port,
            path: reqPath,
            method,
            headers,
        }, (res) => {
            const chunks: Buffer[] = [];
            res.on('data', (chunk) => chunks.push(chunk));
            res.on('end', () => resolve({
                status: res.statusCode || 0,
                headers: res.headers,
                text: Buffer.concat(chunks).toString('utf8'),
            }));
        });
        req.on('error', reject);
        if (body) {
            req.write(body);
        }
        req.end();
    });
}

test('console rejects foreign hosts and returns the operator reply unchanged', async () => {
    const app = createApp();
    const port = await listen(app);
    const host = `127.0.0.1:${port}`;
    try {
        const health = await rawRequest(port, 'GET', '/healthz', { host });
        assert.equal(health.status, 200);
        assert.equal(health.headers['access-control-allow-origin'], undefined);
        assert.equal(JSON.parse(health.text).verbatimReplies, true);

        const rebound = await rawRequest(port, 'GET', '/healthz', { host: 'evil.example' });
        assert.equal(rebound.status, 403);

        const crossSite = await rawRequest(port, 'GET', '/healthz', { host, origin: 'http://evil.example' });
        assert.equal(crossSite.status, 403);

        const manifest = await rawRequest(port, 'GET', '/manifest.json', { host });
        assert.equal(manifest.status, 200);
        assert.match(String(manifest.headers['content-type']), /application\/manifest\+json/);

        const waiting = rawRequest(port, 'POST', '/api/waits/create-and-wait', {
            host,
            'content-type': 'application/json',
        }, JSON.stringify({ context: 'About to publish.', question: 'Ship?', sessionId: 'http-test' }));
        let waitId = '';
        for (let attempt = 0; attempt < 20 && !waitId; attempt++) {
            const listed = await rawRequest(port, 'GET', '/api/waits', { host });
            const waits = JSON.parse(listed.text).waits as Array<{ id: string }>;
            waitId = waits[0]?.id || '';
            if (!waitId) {
                await new Promise((resolve) => setTimeout(resolve, 10));
            }
        }
        assert.ok(waitId);
        const empty = await rawRequest(port, 'POST', `/api/waits/${waitId}/respond`, {
            host,
            'content-type': 'application/json',
        }, JSON.stringify({ message: '   ' }));
        assert.equal(empty.status, 400);
        const sent = await rawRequest(port, 'POST', `/api/waits/${waitId}/respond`, {
            host,
            'content-type': 'application/json',
        }, JSON.stringify({ message: 'Ship it' }));
        assert.equal(sent.status, 200);
        const replied = JSON.parse((await waiting).text) as { resolution: string; message: string };
        assert.equal(replied.resolution, 'message');
        assert.equal(replied.message, 'Ship it');

        const badHook = await rawRequest(port, 'POST', '/api/settings', {
            host,
            'content-type': 'application/json',
        }, JSON.stringify({ webhookUrl: 'http://169.254.169.254/latest' }));
        assert.equal(badHook.status, 400);

        const interruptedWait = rawRequest(port, 'POST', '/api/waits/create-and-wait', {
            host,
            'content-type': 'application/json',
        }, JSON.stringify({ context: 'Still going.', sessionId: 'http-stop' }));
        for (let attempt = 0; attempt < 20 && app.waitStore.listPendingWaits().length === 0; attempt++) {
            await new Promise((resolve) => setTimeout(resolve, 10));
        }
        assert.equal(app.waitStore.interruptAll('shutdown'), 1);
        const interrupted = JSON.parse((await interruptedWait).text) as { resolution: string; reason: string; message: null };
        assert.equal(interrupted.resolution, 'interrupted');
        assert.equal(interrupted.reason, 'shutdown');
        assert.equal(interrupted.message, null);
    }
    finally {
        await app.shutdown();
    }
});
