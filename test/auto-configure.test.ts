import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { test } from 'node:test';
import { configureBatch, configureClient, unconfigureClient } from '../src/auto-configure.js';

const serverUrl = 'http://127.0.0.1:3737/mcp';

test('configure merges into valid JSON and refuses to clobber invalid JSON', () => {
    const home = mkdtempSync(path.join(tmpdir(), 'turn-mcp-cfg-'));
    const filePath = path.join(home, '.cursor', 'mcp.json');
    mkdirSync(path.dirname(filePath), { recursive: true });
    writeFileSync(filePath, '{not json');
    const refused = configureClient('cursor', serverUrl, { homeDir: home });
    assert.equal(refused.action, 'error');
    assert.equal(readFileSync(filePath, 'utf8'), '{not json');

    writeFileSync(filePath, JSON.stringify({ otherClient: { command: 'keep-me' } }));
    const written = configureClient('cursor', serverUrl, { homeDir: home });
    assert.equal(written.action, 'updated');
    const parsed = JSON.parse(readFileSync(filePath, 'utf8')) as {
        otherClient: { command: string };
        mcpServers: { 'turn-mcp-web': { url: string } };
    };
    assert.equal(parsed.otherClient.command, 'keep-me');
    assert.equal(parsed.mcpServers['turn-mcp-web'].url, serverUrl);

    const removed = unconfigureClient('cursor', { homeDir: home });
    assert.equal(removed.action, 'updated');
    const after = JSON.parse(readFileSync(filePath, 'utf8')) as { otherClient: { command: string }; mcpServers: Record<string, unknown> };
    assert.equal(after.otherClient.command, 'keep-me');
    assert.equal(after.mcpServers['turn-mcp-web'], undefined);
});

test('shell profile writes and hostile urls are rejected', () => {
    const home = mkdtempSync(path.join(tmpdir(), 'turn-mcp-cfg-'));
    const shell = configureBatch(['system-shell'], serverUrl, { homeDir: home });
    assert.equal(shell[0].action, 'error');
    const hostile = configureClient('cursor', 'http://127.0.0.1:3737/mcp";touch /tmp/pwned', { homeDir: home });
    assert.equal(hostile.action, 'error');
    assert.equal(existsSync(path.join(home, '.cursor', 'mcp.json')), false);
});
