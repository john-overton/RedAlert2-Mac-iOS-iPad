import { sha256Portable } from './Sha256';
/** Portable, bounded content packages. Retail archives and executable files cannot be transferred. */
export interface ContentFile { path: string; bytes: Uint8Array }
export interface ContentEntry { path: string; size: number; sha256: string }
export interface ContentManifest { version: 1; id: string; files: ContentEntry[]; totalBytes: number }
export const CONTENT_CHUNK_BYTES = 8192;
export const MAX_CONTENT_BYTES = 64 * 1024 * 1024;
export const MAX_CONTENT_FILE_BYTES = 32 * 1024 * 1024;
const digestPattern = /^[a-f0-9]{64}$/;
export function contentPath(path: string): string {
    const normalized = path.toLowerCase();
    if (!/^[a-z0-9][a-z0-9_.-]{0,119}\.(map|mpr|yrm|ini|shp|vxl|hva|pal|tmp|wav|csf)$/.test(normalized) || normalized.includes('..')) throw new Error('Unsupported content filename');
    return normalized;
}
export async function sha256(bytes: Uint8Array): Promise<string> {
    if (globalThis.crypto?.subtle) {
        try { return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes.slice().buffer)), b => b.toString(16).padStart(2, '0')).join(''); } catch { /* Unsupported custom scheme: use the portable implementation. */ }
    }
    return sha256Portable(bytes);
}
const canonical = (files: ContentEntry[]) => new TextEncoder().encode(JSON.stringify({version: 1, files}));
export async function createContentManifest(files: ContentFile[]): Promise<ContentManifest> {
    const entries = await Promise.all(files.map(async file => ({path: contentPath(file.path), size: file.bytes.length, sha256: await sha256(file.bytes)})));
    entries.sort((a,b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
    const manifest: ContentManifest = {version: 1, id: await sha256(canonical(entries)), files: entries, totalBytes: entries.reduce((sum,file) => sum + file.size,0)};
    await validateContentManifest(manifest);
    return manifest;
}
export async function validateContentManifest(value: any): Promise<ContentManifest> {
    if (!value || value.version !== 1 || !digestPattern.test(value.id) || !Array.isArray(value.files) || value.files.length > 256) throw new Error('Invalid content manifest');
    let previous = '', total = 0;
    const files: ContentEntry[] = value.files.map((file: any) => {
        if (!file || typeof file.path !== 'string' || file.path !== contentPath(file.path) || file.path <= previous || !Number.isInteger(file.size) || file.size < 1 || file.size > MAX_CONTENT_FILE_BYTES || !digestPattern.test(file.sha256)) throw new Error('Invalid content entry');
        previous = file.path; total += file.size;
        return {path:file.path,size:file.size,sha256:file.sha256};
    });
    if (total > MAX_CONTENT_BYTES || total !== value.totalBytes || await sha256(canonical(files)) !== value.id) throw new Error('Content manifest checksum or size mismatch');
    return {version:1,id:value.id,files,totalBytes:total};
}
export async function verifyContentFiles(manifest: ContentManifest, files: ContentFile[]): Promise<void> {
    await validateContentManifest(manifest);
    if (files.length !== manifest.files.length) throw new Error('Content package incomplete');
    for (const entry of manifest.files) {
        const file = files.find(file => file.path === entry.path);
        if (!file || file.bytes.length !== entry.size || await sha256(file.bytes) !== entry.sha256) throw new Error(`Content checksum mismatch: ${entry.path}`);
    }
}
export function encodeContentBytes(bytes: Uint8Array): string { let result = ''; for (const byte of bytes) result += String.fromCharCode(byte); return btoa(result); }
export function decodeContentBytes(data: string): Uint8Array {
    if (typeof data !== 'string' || data.length > Math.ceil(CONTENT_CHUNK_BYTES / 3) * 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(data)) throw new Error('Invalid content chunk');
    const bytes = Uint8Array.from(atob(data), char => char.charCodeAt(0));
    if (bytes.length < 1 || bytes.length > CONTENT_CHUNK_BYTES || encodeContentBytes(bytes) !== data) throw new Error('Invalid content chunk');
    return bytes;
}
