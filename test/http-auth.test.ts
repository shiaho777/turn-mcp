import assert from 'node:assert/strict';
import { mkdtempSync } from 'fs';
import http from 'http';
import { tmpdir } from 'os';
import path from 'path';
import { test } from 'node:test';

const settingsDir = mkdtempSync(path.join(tmpdir(), 'turn-mcp-auth-'));
process.env.TURN_MCP_SETTINGS_FILE = path.join(settingsDir, 'settings.json');
process.env.TURN_MCP_API_KEY = 'operator-secret';
process.env.TURN_MCP_REQUIRE_API_KEY = 'true';

function listen(app: { httpServer: http.Server }): Promise<number> {
    return new Promise((resolve) => {
        app.httpServer.listen(0, '127.0.0.1', () => {
            const address = app.httpServer.address();
            resolve(typeof address === 'object' && address ? address.port : 0);
        });
    });
}

function rawRequest(port: number, method: string, reqPath: string, headers: Record<string, string>, body?: string): Promise<{ status: number; text: string }> {
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

test('operator key is required and query-string tokens are ignored', async () => {
    const { createApp } = await import('../src/app.js');
    const app = createApp();
    const port = await listen(app);
    const host = `127.0.0.1:${port}`;
    try {
        const missing = await rawRequest(port, 'GET', '/api/waits', { host });
        assert.equal(missing.status, 401);

        const queryToken = await rawRequest(port, 'GET', '/api/waits?token=operator-secret', { host });
        assert.equal(queryToken.status, 401);

        const streamQuery = await rawRequest(port, 'GET', '/api/stream?token=operator-secret', { host });
        assert.equal(streamQuery.status, 401);

        const header = await rawRequest(port, 'GET', '/api/waits', {
            host,
            'x-turn-mcp-api-key': 'operator-secret',
        });
        assert.equal(header.status, 200);

        const cookie = await rawRequest(port, 'GET', '/api/waits', {
            host,
            cookie: 'turn_mcp_key=operator-secret',
        });
        assert.equal(cookie.status, 200);
    }
    finally {
        await app.shutdown();
    }
});
