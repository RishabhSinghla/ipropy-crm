/**
 * Microsoft Graph / OneDrive for Business storage driver.
 *
 * The CRM authenticates as its own Entra application, which is the reliable
 * shape for a background worker: no employee has to remain signed in and a
 * refresh token cannot silently expire. Small objects use Graph's direct
 * upload; anything above 10 MiB uses a resumable upload session in ordered
 * 10 MiB fragments (10 MiB is exactly 32 x Graph's required 320 KiB unit).
 */
import { createWriteStream } from 'node:fs';
import {
  open, stat, unlink,
} from 'node:fs/promises';
import { Readable } from 'node:stream';
import { pipeline as streamPipeline } from 'node:stream/promises';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import os from 'node:os';
import type { StorageDriver, StorageObject } from './index.js';

const GRAPH = 'https://graph.microsoft.com/v1.0';
const DIRECT_UPLOAD_MAX = 10 * 1024 * 1024;
export const ONEDRIVE_CHUNK_SIZE = 10 * 1024 * 1024;
const RETRYABLE = new Set([429, 500, 502, 503, 504]);

export interface OneDriveSettings {
  tenantId: string;
  clientId: string;
  clientSecret: string;
  driveId: string;
  driveUser: string;
  rootFolder: string;
}

interface DriveInfo { id: string; name?: string; webUrl?: string }
interface DriveItem { id: string; name?: string; webUrl?: string; folder?: unknown }
interface ChildDriveItem extends DriveItem {
  size?: number;
  lastModifiedDateTime?: string;
  file?: { mimeType?: string };
}
interface UploadSession { uploadUrl?: string }

/** Encode each segment, while retaining the slash separators Graph expects. */
export function encodeGraphPath(path: string): string {
  return normalisePath(path).split('/').map(encodeURIComponent).join('/');
}

/** Reject traversal and normalise user-entered leading/trailing separators. */
export function normalisePath(path: string): string {
  const segments = path.replace(/\\/g, '/').split('/').filter(Boolean);
  if (segments.some((part) => part === '.' || part === '..')) throw new Error('Invalid OneDrive storage path');
  if (segments.some((part) => /[<>:"|?*\x00-\x1f]/.test(part) || /[. ]$/.test(part))) {
    throw new Error('OneDrive path contains a character Microsoft does not allow');
  }
  return segments.join('/');
}

/** Pure range helper, exported so the large-video contract is testable. */
export function uploadRanges(size: number, chunkSize = ONEDRIVE_CHUNK_SIZE): { start: number; end: number }[] {
  if (size <= 0) return [];
  if (chunkSize <= 0 || chunkSize % (320 * 1024) !== 0) {
    throw new Error('OneDrive chunk size must be a positive multiple of 320 KiB');
  }
  const ranges: { start: number; end: number }[] = [];
  for (let start = 0; start < size; start += chunkSize) {
    ranges.push({ start, end: Math.min(size - 1, start + chunkSize - 1) });
  }
  return ranges;
}

function validate(settings: OneDriveSettings): void {
  if (!settings.tenantId || !settings.clientId || !settings.clientSecret) {
    throw new Error('OneDrive needs a tenant ID, client ID and client secret (Admin → Integrations → OneDrive)');
  }
  if (!settings.driveId && !settings.driveUser) {
    throw new Error('OneDrive needs either a drive ID or the Microsoft 365 account email that owns the drive');
  }
  normalisePath(settings.rootFolder);
}

function errorMessage(status: number, statusText: string, body: string): string {
  try {
    const parsed = JSON.parse(body) as { error?: { message?: string; code?: string } };
    const detail = parsed.error?.message ?? parsed.error?.code;
    return `Microsoft Graph returned ${status}${detail ? `: ${detail}` : ''}`;
  } catch {
    return `Microsoft Graph returned ${status} ${statusText}${body ? `: ${body.slice(0, 240)}` : ''}`;
  }
}

async function wait(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

class OneDriveClient {
  private token: { value: string; expiresAt: number } | null = null;
  private drive: DriveInfo | null = null;
  private readonly folderIds = new Map<string, string>();

  constructor(private readonly settings: OneDriveSettings) {
    validate(settings);
  }

  private async accessToken(): Promise<string> {
    if (this.token && this.token.expiresAt > Date.now() + 60_000) return this.token.value;

    const response = await fetch(
      `https://login.microsoftonline.com/${encodeURIComponent(this.settings.tenantId)}/oauth2/v2.0/token`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          client_id: this.settings.clientId,
          client_secret: this.settings.clientSecret,
          scope: 'https://graph.microsoft.com/.default',
          grant_type: 'client_credentials',
        }),
        signal: AbortSignal.timeout(20_000),
      },
    );
    const body = await response.text();
    if (!response.ok) throw new Error(errorMessage(response.status, response.statusText, body));
    const parsed = JSON.parse(body) as { access_token?: string; expires_in?: number };
    if (!parsed.access_token) throw new Error('Microsoft identity returned no access token');
    this.token = {
      value: parsed.access_token,
      expiresAt: Date.now() + Math.max(300, parsed.expires_in ?? 3600) * 1000,
    };
    return this.token.value;
  }

  private async graph(path: string, init: RequestInit = {}, allow404 = false): Promise<Response | null> {
    let last: Response | null = null;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const token = await this.accessToken();
      const response = await fetch(`${GRAPH}${path}`, {
        ...init,
        headers: { Authorization: `Bearer ${token}`, ...(init.headers ?? {}) },
        signal: init.signal ?? AbortSignal.timeout(120_000),
      });
      if (allow404 && response.status === 404) return null;
      if (response.ok || !RETRYABLE.has(response.status) || attempt === 2) return response;
      last = response;
      const retryAfter = Number(response.headers.get('retry-after'));
      await wait(Number.isFinite(retryAfter) && retryAfter > 0
        ? Math.min(retryAfter * 1000, 10_000)
        : 500 * 2 ** attempt);
    }
    return last;
  }

  private async json<T>(path: string, init: RequestInit = {}, allow404 = false): Promise<T | null> {
    const response = await this.graph(path, init, allow404);
    if (!response) return null;
    const body = await response.text();
    if (!response.ok) throw new Error(errorMessage(response.status, response.statusText, body));
    return body ? JSON.parse(body) as T : null;
  }

  async driveInfo(): Promise<DriveInfo> {
    if (this.drive) return this.drive;
    const path = this.settings.driveId
      ? `/drives/${encodeURIComponent(this.settings.driveId)}`
      : `/users/${encodeURIComponent(this.settings.driveUser)}/drive`;
    const drive = await this.json<DriveInfo>(path);
    if (!drive?.id) throw new Error('Microsoft Graph could not resolve that OneDrive');
    this.drive = drive;
    return drive;
  }

  private fullPath(key: string): string {
    return normalisePath([this.settings.rootFolder, key].filter(Boolean).join('/'));
  }

  private async itemByPath(path: string): Promise<DriveItem | null> {
    const drive = await this.driveInfo();
    if (!path) return this.json<DriveItem>(`/drives/${encodeURIComponent(drive.id)}/root`);
    return this.json<DriveItem>(
      `/drives/${encodeURIComponent(drive.id)}/root:/${encodeGraphPath(path)}`,
      {},
      true,
    );
  }

  /** Create every missing segment and return the final folder. */
  async ensureFolder(key: string): Promise<DriveItem> {
    const drive = await this.driveInfo();
    const path = this.fullPath(key);
    const root = await this.itemByPath('');
    if (!root?.id) throw new Error('Microsoft Graph returned no OneDrive root folder');
    if (!path) return root;

    let parentId = root.id;
    const built: string[] = [];
    for (const segment of path.split('/')) {
      built.push(segment);
      const currentPath = built.join('/');
      const cached = this.folderIds.get(currentPath);
      if (cached) { parentId = cached; continue; }

      let item = await this.itemByPath(currentPath);
      if (!item) {
        try {
          item = await this.json<DriveItem>(
            `/drives/${encodeURIComponent(drive.id)}/items/${encodeURIComponent(parentId)}/children`,
            {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({
                name: segment,
                folder: {},
                '@microsoft.graph.conflictBehavior': 'fail',
              }),
            },
          );
        } catch (err) {
          // Two workers can create the same segment at once. Resolve the winner
          // rather than turning a harmless 409 into a failed property folder.
          item = await this.itemByPath(currentPath);
          if (!item) throw err;
        }
      }
      if (!item?.id || !item.folder) throw new Error(`OneDrive path is not a folder: ${currentPath}`);
      parentId = item.id;
      this.folderIds.set(currentPath, item.id);
    }
    return (await this.itemByPath(path)) ?? { id: parentId };
  }

  private async directUpload(path: string, data: Buffer, contentType: string): Promise<void> {
    const drive = await this.driveInfo();
    const response = await this.graph(
      `/drives/${encodeURIComponent(drive.id)}/root:/${encodeGraphPath(path)}:/content`,
      {
        method: 'PUT',
        headers: { 'content-type': contentType },
        body: data as unknown as NonNullable<RequestInit['body']>,
      },
    );
    if (!response) throw new Error('Microsoft Graph upload returned no response');
    if (!response.ok) {
      const body = await response.text();
      throw new Error(errorMessage(response.status, response.statusText, body));
    }
  }

  private async createUploadSession(path: string): Promise<string> {
    const drive = await this.driveInfo();
    const session = await this.json<UploadSession>(
      `/drives/${encodeURIComponent(drive.id)}/root:/${encodeGraphPath(path)}:/createUploadSession`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ item: { '@microsoft.graph.conflictBehavior': 'replace' } }),
      },
    );
    if (!session?.uploadUrl) throw new Error('Microsoft Graph returned no upload session URL');
    return session.uploadUrl;
  }

  private async putFragment(uploadUrl: string, data: Buffer, start: number, end: number, total: number): Promise<void> {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      // The pre-authenticated uploadUrl must not receive the Graph bearer token.
      const response = await fetch(uploadUrl, {
        method: 'PUT',
        headers: {
          'content-length': String(data.length),
          'content-range': `bytes ${start}-${end}/${total}`,
        },
        body: data as unknown as NonNullable<RequestInit['body']>,
        signal: AbortSignal.timeout(180_000),
      });
      if (response.ok) return;
      const body = await response.text();
      if (!RETRYABLE.has(response.status) || attempt === 2) {
        throw new Error(errorMessage(response.status, response.statusText, body));
      }
      const retryAfter = Number(response.headers.get('retry-after'));
      await wait(Number.isFinite(retryAfter) && retryAfter > 0
        ? Math.min(retryAfter * 1000, 10_000)
        : 500 * 2 ** attempt);
    }
  }

  private async uploadBuffer(path: string, data: Buffer, contentType: string): Promise<void> {
    if (data.length <= DIRECT_UPLOAD_MAX) {
      await this.directUpload(path, data, contentType);
      return;
    }
    const uploadUrl = await this.createUploadSession(path);
    for (const { start, end } of uploadRanges(data.length)) {
      await this.putFragment(uploadUrl, data.subarray(start, end + 1), start, end, data.length);
    }
  }

  private async uploadFile(path: string, filePath: string, contentType: string): Promise<void> {
    const size = (await stat(filePath)).size;
    if (size <= DIRECT_UPLOAD_MAX) {
      const handle = await open(filePath, 'r');
      try {
        const data = Buffer.alloc(size);
        if (size) await handle.read(data, 0, size, 0);
        await this.directUpload(path, data, contentType);
      } finally {
        await handle.close();
      }
      return;
    }

    const uploadUrl = await this.createUploadSession(path);
    const handle = await open(filePath, 'r');
    try {
      for (const { start, end } of uploadRanges(size)) {
        const wanted = end - start + 1;
        const chunk = Buffer.allocUnsafe(wanted);
        const { bytesRead } = await handle.read(chunk, 0, wanted, start);
        if (bytesRead !== wanted) throw new Error('Could not read the complete upload fragment');
        await this.putFragment(uploadUrl, chunk, start, end, size);
      }
    } finally {
      await handle.close();
    }
  }

  async save(key: string, data: Buffer | Readable, contentType: string): Promise<void> {
    const relativePath = normalisePath(key);
    const fullPath = this.fullPath(relativePath);
    const parent = dirname(relativePath);
    await this.ensureFolder(parent === '.' ? '' : parent);
    if (Buffer.isBuffer(data)) {
      await this.uploadBuffer(fullPath, data, contentType);
      return;
    }

    const tempPath = join(os.tmpdir(), `ipropy-onedrive-${randomUUID()}`);
    try {
      await streamPipeline(data, createWriteStream(tempPath));
      await this.uploadFile(fullPath, tempPath, contentType);
    } finally {
      await unlink(tempPath).catch(() => undefined);
    }
  }

  private async content(key: string): Promise<Response | null> {
    const drive = await this.driveInfo();
    return this.graph(
      `/drives/${encodeURIComponent(drive.id)}/root:/${encodeGraphPath(this.fullPath(key))}:/content`,
      { redirect: 'follow', signal: AbortSignal.timeout(180_000) },
      true,
    );
  }

  async read(key: string): Promise<Buffer | null> {
    const response = await this.content(key);
    if (!response) return null;
    if (!response.ok) {
      const body = await response.text();
      throw new Error(errorMessage(response.status, response.statusText, body));
    }
    return Buffer.from(await response.arrayBuffer());
  }

  async readToTempFile(key: string): Promise<{ path: string; cleanup: () => Promise<void> } | null> {
    const response = await this.content(key);
    if (!response) return null;
    if (!response.ok || !response.body) {
      if (response.ok) return null;
      const body = await response.text();
      throw new Error(errorMessage(response.status, response.statusText, body));
    }
    const path = join(os.tmpdir(), `ipropy-onedrive-read-${randomUUID()}`);
    const stream = Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0]);
    await streamPipeline(stream, createWriteStream(path));
    return { path, cleanup: async () => unlink(path).catch(() => undefined) };
  }

  async remove(key: string): Promise<void> {
    const drive = await this.driveInfo();
    const response = await this.graph(
      `/drives/${encodeURIComponent(drive.id)}/root:/${encodeGraphPath(this.fullPath(key))}`,
      { method: 'DELETE' },
      true,
    );
    if (!response || response.ok) return;
    const body = await response.text();
    throw new Error(errorMessage(response.status, response.statusText, body));
  }

  async listFolder(key: string): Promise<StorageObject[]> {
    const drive = await this.driveInfo();
    const relative = normalisePath(key);
    const fullPath = this.fullPath(relative);
    const result = await this.json<{ value?: ChildDriveItem[] }>(
      `/drives/${encodeURIComponent(drive.id)}/root:/${encodeGraphPath(fullPath)}:/children?$top=999&$select=id,name,size,file,lastModifiedDateTime`,
      {},
      true,
    );
    return (result?.value ?? [])
      .filter((item): item is ChildDriveItem & { id: string; name: string; file: { mimeType?: string } } => (
        Boolean(item.id && item.name && item.file)
      ))
      .map((item) => ({
        key: `${relative}/${item.name}`,
        name: item.name,
        size: Number(item.size) || 0,
        mimeType: item.file.mimeType || 'application/octet-stream',
        lastModifiedAt: item.lastModifiedDateTime ?? null,
        externalId: `onedrive:${drive.id}:${item.id}`,
      }));
  }
}

export function createOneDriveDriver(settings: OneDriveSettings): StorageDriver {
  const client = new OneDriveClient(settings);
  return {
    save: (key, data, contentType) => client.save(key, data, contentType),
    read: (key) => client.read(key),
    remove: (key) => client.remove(key),
    readToTempFile: (key) => client.readToTempFile(key),
    ensureFolder: async (key) => {
      const item = await client.ensureFolder(key);
      return { webUrl: item.webUrl };
    },
    listFolder: (key) => client.listFolder(key),
  };
}

/** Test credentials and create the configured root folder as a write check. */
export async function testOneDriveConnection(settings: OneDriveSettings): Promise<{ name: string; webUrl?: string }> {
  const client = new OneDriveClient(settings);
  const drive = await client.driveInfo();
  const root = await client.ensureFolder('');
  return { name: drive.name ?? settings.driveUser ?? drive.id, ...(root.webUrl ? { webUrl: root.webUrl } : {}) };
}
