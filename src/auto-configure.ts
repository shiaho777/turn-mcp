import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { Logger } from './config.js';
import { mcpServerUrlError } from './net-policy.js';

const logger = new Logger('AutoConfigure');
export type ConfigAction = 'created' | 'updated' | 'already-configured' | 'not-configured' | 'not-found' | 'error';
export interface ConfigResult {
    target: string;
    name: string;
    displayPath: string;
    action: ConfigAction;
    error?: string;
}
export interface ConfigureOptions {
    homeDir?: string;
}
type MergeFn = (existing: Record<string, unknown>, serverUrl: string) => Record<string, unknown>;
interface ClientDef {
    name: string;
    resolvePath: (home: string) => string;
    merge: MergeFn;
}

function homeOf(options?: ConfigureOptions): string {
    return options?.homeDir || os.homedir();
}
function tildify(filePath: string, home: string): string {
    return filePath.startsWith(home) ? '~' + filePath.slice(home.length) : filePath;
}
function claudeDesktopPath(home: string): string {
    if (process.platform === 'darwin') {
        return path.join(home, 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json');
    }
    if (process.platform === 'win32') {
        return path.join(process.env['APPDATA'] || home, 'Claude', 'claude_desktop_config.json');
    }
    return path.join(home, '.config', 'Claude', 'claude_desktop_config.json');
}
function vscodePath(home: string): string {
    if (process.platform === 'darwin') {
        return path.join(home, 'Library', 'Application Support', 'Code', 'User', 'mcp.json');
    }
    if (process.platform === 'win32') {
        return path.join(process.env['APPDATA'] || home, 'Code', 'User', 'mcp.json');
    }
    return path.join(home, '.config', 'Code', 'User', 'mcp.json');
}
function antigravityPath(home: string): string {
    if (process.platform === 'darwin') {
        return path.join(home, 'Library', 'Application Support', 'Antigravity', 'mcp.json');
    }
    if (process.platform === 'win32') {
        return path.join(process.env['APPDATA'] || home, 'Antigravity', 'mcp.json');
    }
    return path.join(home, '.config', 'Antigravity', 'mcp.json');
}
const CLIENT_DEFS: Record<string, ClientDef> = {
    windsurf: {
        name: 'Windsurf',
        resolvePath: (home) => path.join(home, '.codeium', 'windsurf', 'mcp_config.json'),
        merge: (existing, url) => ({ ...existing, mcpServers: { ...(existing['mcpServers'] as object || {}), 'turn-mcp-web': { serverUrl: url } } }),
    },
    cursor: {
        name: 'Cursor',
        resolvePath: (home) => path.join(home, '.cursor', 'mcp.json'),
        merge: (existing, url) => ({ ...existing, mcpServers: { ...(existing['mcpServers'] as object || {}), 'turn-mcp-web': { url } } }),
    },
    'claude-desktop': {
        name: 'Claude Desktop',
        resolvePath: claudeDesktopPath,
        merge: (existing, url) => ({ ...existing, mcpServers: { ...(existing['mcpServers'] as object || {}), 'turn-mcp-web': { url } } }),
    },
    vscode: {
        name: 'VS Code',
        resolvePath: vscodePath,
        merge: (existing, url) => ({ ...existing, servers: { ...(existing['servers'] as object || {}), 'turn-mcp-web': { type: 'http', url } } }),
    },
    'claude-code': {
        name: 'Claude Code',
        resolvePath: (home) => path.join(home, '.claude.json'),
        merge: (existing, url) => ({ ...existing, mcpServers: { ...(existing['mcpServers'] as object || {}), 'turn-mcp-web': { type: 'http', url } } }),
    },
    opencode: {
        name: 'OpenCode',
        resolvePath: (home) => path.join(home, '.config', 'opencode', 'opencode.json'),
        merge: (existing, url) => ({
            ...existing,
            '$schema': 'https://opencode.ai/config.json',
            mcp: { ...(existing['mcp'] as object || {}), 'turn-mcp-web': { type: 'remote', url, enabled: true } },
        }),
    },
    antigravity: {
        name: 'Antigravity',
        resolvePath: antigravityPath,
        merge: (existing, url) => ({ ...existing, mcpServers: { ...(existing['mcpServers'] as object || {}), 'turn-mcp-web': { url } } }),
    },
    openclaw: {
        name: 'OpenClaw',
        resolvePath: (home) => path.join(home, 'openclaw.json'),
        merge: (existing, url) => ({ ...existing, mcpServers: { ...(existing['mcpServers'] as object || {}), 'turn-mcp-web': { type: 'http', url } } }),
    },
};
export const TARGETED_CLIENTS = Object.keys(CLIENT_DEFS);

function readJson(filePath: string): { ok: true; data: Record<string, unknown> } | { ok: false; error: string } {
    if (!fs.existsSync(filePath)) {
        return { ok: true, data: {} };
    }
    let raw: string;
    try {
        raw = fs.readFileSync(filePath, 'utf-8').trim();
    }
    catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
    if (!raw) {
        return { ok: true, data: {} };
    }
    try {
        const parsed = JSON.parse(raw) as unknown;
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
            return { ok: false, error: 'Config file must be a JSON object. Refusing to overwrite it.' };
        }
        return { ok: true, data: parsed as Record<string, unknown> };
    }
    catch {
        return { ok: false, error: 'Config file is not valid JSON. Refusing to overwrite it.' };
    }
}
function writeJson(filePath: string, data: Record<string, unknown>): void {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const tmp = `${filePath}.turn-mcp-tmp`;
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', 'utf-8');
    fs.renameSync(tmp, filePath);
}
function hasTurnMcpWeb(config: Record<string, unknown>): boolean {
    for (const key of ['mcpServers', 'servers', 'mcp']) {
        const section = config[key] as Record<string, unknown> | undefined;
        if (section && typeof section === 'object' && 'turn-mcp-web' in section) {
            return true;
        }
    }
    return false;
}
function validatedUrl(serverUrl: string): { ok: true; url: string } | { ok: false; error: string } {
    const error = mcpServerUrlError(serverUrl);
    if (error) {
        return { ok: false, error };
    }
    return { ok: true, url: serverUrl.trim() };
}
export function checkClientStatus(target: string, _serverUrl: string, options?: ConfigureOptions): 'configured' | 'not-configured' | 'not-found' {
    const home = homeOf(options);
    if (target === 'system-shell') {
        return 'not-found';
    }
    if (target === 'system-mcp') {
        const filePath = path.join(home, '.config', 'mcp', 'servers.json');
        if (!fs.existsSync(filePath)) {
            return 'not-configured';
        }
        const parsed = readJson(filePath);
        if (!parsed.ok) {
            return 'not-configured';
        }
        return hasTurnMcpWeb(parsed.data) ? 'configured' : 'not-configured';
    }
    const def = CLIENT_DEFS[target];
    if (!def) {
        return 'not-found';
    }
    const filePath = def.resolvePath(home);
    if (!fs.existsSync(filePath)) {
        return 'not-found';
    }
    const parsed = readJson(filePath);
    if (!parsed.ok) {
        return 'not-configured';
    }
    return hasTurnMcpWeb(parsed.data) ? 'configured' : 'not-configured';
}
export function configureClient(target: string, serverUrl: string, options?: ConfigureOptions): ConfigResult {
    const home = homeOf(options);
    const def = CLIENT_DEFS[target];
    if (!def) {
        return { target, name: target, displayPath: target, action: 'error', error: `Unknown client: ${target}` };
    }
    const url = validatedUrl(serverUrl);
    const filePath = def.resolvePath(home);
    const displayPath = tildify(filePath, home);
    if (!url.ok) {
        return { target, name: def.name, displayPath, action: 'error', error: url.error };
    }
    const existing = readJson(filePath);
    if (!existing.ok) {
        return { target, name: def.name, displayPath, action: 'error', error: existing.error };
    }
    if (hasTurnMcpWeb(existing.data)) {
        return { target, name: def.name, displayPath, action: 'already-configured' };
    }
    try {
        const merged = def.merge(existing.data, url.url);
        writeJson(filePath, merged);
        const action: ConfigAction = Object.keys(existing.data).length === 0 ? 'created' : 'updated';
        logger.info(`Configured ${def.name} → ${filePath} (${action})`);
        return { target, name: def.name, displayPath, action };
    }
    catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.error(`configure ${def.name}`, error);
        return { target, name: def.name, displayPath, action: 'error', error: message };
    }
}
export function configureSystemMcp(serverUrl: string, options?: ConfigureOptions): ConfigResult {
    const home = homeOf(options);
    const filePath = path.join(home, '.config', 'mcp', 'servers.json');
    const displayPath = tildify(filePath, home);
    const url = validatedUrl(serverUrl);
    if (!url.ok) {
        return { target: 'system-mcp', name: 'System MCP Registry', displayPath, action: 'error', error: url.error };
    }
    const existing = readJson(filePath);
    if (!existing.ok) {
        return { target: 'system-mcp', name: 'System MCP Registry', displayPath, action: 'error', error: existing.error };
    }
    if (hasTurnMcpWeb(existing.data)) {
        return { target: 'system-mcp', name: 'System MCP Registry', displayPath, action: 'already-configured' };
    }
    try {
        const merged = {
            ...existing.data,
            mcpServers: { ...(existing.data['mcpServers'] as object || {}), 'turn-mcp-web': { url: url.url } },
        };
        writeJson(filePath, merged);
        logger.info(`Updated system MCP registry → ${filePath}`);
        return {
            target: 'system-mcp',
            name: 'System MCP Registry',
            displayPath,
            action: Object.keys(existing.data).length === 0 ? 'created' : 'updated',
        };
    }
    catch (error) {
        return { target: 'system-mcp', name: 'System MCP Registry', displayPath, action: 'error', error: error instanceof Error ? error.message : String(error) };
    }
}
export function configureBatch(targets: string[], serverUrl: string, options?: ConfigureOptions): ConfigResult[] {
    return targets.map((target) => {
        if (target === 'system-shell') {
            return {
                target,
                name: 'Shell Profile',
                displayPath: target,
                action: 'error',
                error: 'Shell profile writes are disabled. Add the MCP server in the client config instead.',
            };
        }
        if (target === 'system-mcp') {
            return configureSystemMcp(serverUrl, options);
        }
        return configureClient(target, serverUrl, options);
    });
}
export function unconfigureClient(target: string, options?: ConfigureOptions): ConfigResult {
    const home = homeOf(options);
    const def = CLIENT_DEFS[target];
    if (!def) {
        return { target, name: target, displayPath: target, action: 'error', error: `Unknown client: ${target}` };
    }
    const filePath = def.resolvePath(home);
    const displayPath = tildify(filePath, home);
    if (!fs.existsSync(filePath)) {
        return { target, name: def.name, displayPath, action: 'not-found' };
    }
    const parsed = readJson(filePath);
    if (!parsed.ok) {
        return { target, name: def.name, displayPath, action: 'error', error: parsed.error };
    }
    let changed = false;
    const config = parsed.data;
    for (const key of ['mcpServers', 'servers', 'mcp'] as const) {
        const section = config[key] as Record<string, unknown> | undefined;
        if (section && 'turn-mcp-web' in section) {
            const copy = { ...section };
            delete copy['turn-mcp-web'];
            config[key] = copy;
            changed = true;
        }
    }
    if (!changed) {
        return { target, name: def.name, displayPath, action: 'not-configured' };
    }
    try {
        writeJson(filePath, config);
        logger.info(`Removed turn-mcp-web from ${def.name} → ${filePath}`);
        return { target, name: def.name, displayPath, action: 'updated' };
    }
    catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.error(`unconfigure ${def.name}`, error);
        return { target, name: def.name, displayPath, action: 'error', error: message };
    }
}
export function unconfigureSystemMcp(options?: ConfigureOptions): ConfigResult {
    const home = homeOf(options);
    const filePath = path.join(home, '.config', 'mcp', 'servers.json');
    const displayPath = tildify(filePath, home);
    if (!fs.existsSync(filePath)) {
        return { target: 'system-mcp', name: 'System MCP Registry', displayPath, action: 'not-found' };
    }
    const parsed = readJson(filePath);
    if (!parsed.ok) {
        return { target: 'system-mcp', name: 'System MCP Registry', displayPath, action: 'error', error: parsed.error };
    }
    if (!hasTurnMcpWeb(parsed.data)) {
        return { target: 'system-mcp', name: 'System MCP Registry', displayPath, action: 'not-configured' };
    }
    const section = parsed.data['mcpServers'] as Record<string, unknown> | undefined;
    if (section) {
        const copy = { ...section };
        delete copy['turn-mcp-web'];
        parsed.data['mcpServers'] = copy;
    }
    try {
        writeJson(filePath, parsed.data);
        logger.info('Removed turn-mcp-web from system MCP registry');
        return { target: 'system-mcp', name: 'System MCP Registry', displayPath, action: 'updated' };
    }
    catch (error) {
        return { target: 'system-mcp', name: 'System MCP Registry', displayPath, action: 'error', error: error instanceof Error ? error.message : String(error) };
    }
}
export function unconfigureBatch(targets: string[], options?: ConfigureOptions): ConfigResult[] {
    return targets.map((target) => {
        if (target === 'system-shell') {
            return {
                target,
                name: 'Shell Profile',
                displayPath: target,
                action: 'not-configured',
                error: 'Shell profiles are no longer modified.',
            };
        }
        if (target === 'system-mcp') {
            return unconfigureSystemMcp(options);
        }
        return unconfigureClient(target, options);
    });
}
