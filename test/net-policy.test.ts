import assert from 'node:assert/strict';
import { test } from 'node:test';
import { bindRejection, mcpServerUrlError, originAllowed, requestHostAllowed, webhookUrlError } from '../src/net-policy.js';

test('loopback accepts local hosts and rejects rebinding hosts', () => {
    assert.equal(requestHostAllowed('127.0.0.1:3737', '127.0.0.1'), true);
    assert.equal(requestHostAllowed('localhost:3737', '127.0.0.1'), true);
    assert.equal(requestHostAllowed('[::1]:3737', '::1'), true);
    assert.equal(requestHostAllowed('evil.example', '127.0.0.1'), false);
    assert.equal(requestHostAllowed(undefined, '127.0.0.1'), false);
});

test('origin must match the request host', () => {
    assert.equal(originAllowed(undefined, '127.0.0.1:3737'), true);
    assert.equal(originAllowed('http://127.0.0.1:3737', '127.0.0.1:3737'), true);
    assert.equal(originAllowed('http://evil.example', '127.0.0.1:3737'), false);
});

test('non-loopback bind requires an operator key and auth', () => {
    assert.equal(bindRejection('127.0.0.1', '', false), null);
    assert.match(bindRejection('0.0.0.0', '', true) || '', /TURN_MCP_API_KEY/);
    assert.match(bindRejection('0.0.0.0', 'secret', false) || '', /REQUIRE_API_KEY/);
    assert.equal(bindRejection('0.0.0.0', 'secret', true), null);
});

test('webhook and mcp urls reject metadata hosts and shell characters', () => {
    assert.equal(webhookUrlError(''), null);
    assert.equal(webhookUrlError('https://example.com/hook'), null);
    assert.match(webhookUrlError('http://169.254.169.254/latest') || '', /metadata/);
    assert.match(webhookUrlError('file:///etc/passwd') || '', /http/);
    assert.equal(mcpServerUrlError('http://127.0.0.1:3737/mcp'), null);
    assert.match(mcpServerUrlError('http://127.0.0.1:3737/mcp";touch /tmp/x') || '', /not allowed/);
});
