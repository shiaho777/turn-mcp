const METADATA_HOSTS = new Set([
    '169.254.169.254',
    'metadata.google.internal',
    'metadata.internal',
]);

export function isLoopbackHost(host: string): boolean {
    const normalized = host.trim().toLowerCase().replace(/^\[|\]$/g, '');
    return normalized === '127.0.0.1' || normalized === 'localhost' || normalized === '::1';
}

export function hostnameFromHostHeader(hostHeader: string): string {
    const host = hostHeader.trim();
    if (host.startsWith('[')) {
        const end = host.indexOf(']');
        return end >= 0 ? host.slice(1, end).toLowerCase() : host.toLowerCase();
    }
    return host.replace(/:\d+$/, '').toLowerCase();
}

export function requestHostAllowed(hostHeader: string | undefined, bindHost: string): boolean {
    if (!isLoopbackHost(bindHost)) {
        return true;
    }
    if (!hostHeader || !hostHeader.trim()) {
        return false;
    }
    return isLoopbackHost(hostnameFromHostHeader(hostHeader));
}

export function originAllowed(origin: string | undefined, hostHeader: string | undefined): boolean {
    if (!origin) {
        return true;
    }
    if (!hostHeader) {
        return false;
    }
    let parsed: URL;
    try {
        parsed = new URL(origin);
    }
    catch {
        return false;
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        return false;
    }
    return parsed.host.toLowerCase() === hostHeader.trim().toLowerCase();
}

export function advertisedHttpHost(bindHost: string): string {
    const host = bindHost.trim().toLowerCase();
    if (host === '0.0.0.0' || host === '::' || host === '::0') {
        return '127.0.0.1';
    }
    return bindHost;
}

export function bindRejection(bindHost: string, operatorKey: string, requireApiKey: boolean): string | null {
    if (isLoopbackHost(bindHost)) {
        return null;
    }
    if (!operatorKey) {
        return `Refusing to listen on ${bindHost} without TURN_MCP_API_KEY. This console can approve agent actions, so a non-loopback bind requires an operator key.`;
    }
    if (!requireApiKey) {
        return `Refusing to listen on ${bindHost} while TURN_MCP_REQUIRE_API_KEY is disabled.`;
    }
    return null;
}

export function mcpServerUrlError(raw: string): string | null {
    const value = raw.trim();
    if (!value) {
        return 'Server URL is empty.';
    }
    if (/[\u0000-\u001f"'`$\\]/.test(value) || /\s/.test(value)) {
        return 'Server URL contains characters that are not allowed.';
    }
    let parsed: URL;
    try {
        parsed = new URL(value);
    }
    catch {
        return 'Server URL must be an absolute http(s) URL.';
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        return 'Server URL must use http or https.';
    }
    if (!parsed.hostname) {
        return 'Server URL is missing a host.';
    }
    return null;
}

export function webhookUrlError(raw: string): string | null {
    const value = raw.trim();
    if (!value) {
        return null;
    }
    let parsed: URL;
    try {
        parsed = new URL(value);
    }
    catch {
        return 'Webhook URL must be an absolute http(s) URL.';
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        return 'Webhook URL must use http or https.';
    }
    if (isMetadataHost(parsed.hostname)) {
        return 'Webhook URL points at a blocked metadata host.';
    }
    return null;
}

function stripHostBrackets(host: string): string {
    return host.trim().toLowerCase().replace(/^\[|\]$/g, '');
}

function ipv4MappedToDotted(host: string): string | null {
    const value = stripHostBrackets(host);
    const dotted = value.match(/^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/);
    if (dotted) {
        return dotted[1];
    }
    const hex = value.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
    if (!hex) {
        return null;
    }
    const high = Number.parseInt(hex[1], 16);
    const low = Number.parseInt(hex[2], 16);
    return `${(high >> 8) & 255}.${high & 255}.${(low >> 8) & 255}.${low & 255}`;
}

function isMetadataHost(hostname: string): boolean {
    const host = stripHostBrackets(hostname);
    if (METADATA_HOSTS.has(host)) {
        return true;
    }
    const mapped = ipv4MappedToDotted(host);
    if (mapped && METADATA_HOSTS.has(mapped)) {
        return true;
    }
    const compactV6 = host.replace(/:0+/g, ':').replace(/::+/g, '::');
    return compactV6 === 'fd00:ec2::254';
}
