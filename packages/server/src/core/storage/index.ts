/**
 * Storage abstraction. The active configuration is resolved DB-first
 * (Admin → Integrations → S3) with `.env` as fallback, matching how every
 * other integration credential is handled. The local driver is the default;
 * the S3 driver is only loaded (and the AWS SDK only imported) when the
 * resolved driver is `s3`.
 */
import { createWriteStream } from 'node:fs';
import {
  mkdir, readFile, stat, unlink, writeFile,
} from 'node:fs/promises';
import { pipeline as streamPipeline } from 'node:stream/promises';
import type { Readable } from 'node:stream';
import { randomUUID } from 'node:crypto';
import os from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { config } from '../../config.js';
import { getSettings } from '../settings/integrations.js';

export interface StorageSettings {
  driver: 'local' | 's3' | 'onedrive';
  localPath: string;
  s3: {
    bucket: string;
    region: string;
    accessKeyId: string;
    secretAccessKey: string;
    endpoint: string;
  };
  onedrive: {
    tenantId: string;
    clientId: string;
    clientSecret: string;
    driveId: string;
    driveUser: string;
    rootFolder: string;
  };
}

export function getStorageSettings(): StorageSettings {
  const s = getSettings().storage;
  return {
    driver: s.driver,
    localPath: config.storage.localPath,
    s3: {
      bucket: s.bucket,
      region: s.region,
      accessKeyId: s.accessKeyId,
      secretAccessKey: s.secretAccessKey,
      endpoint: s.endpoint,
    },
    onedrive: { ...s.onedrive },
  };
}

export interface StorageDriver {
  // Readable is accepted alongside Buffer so a large upload (an iPhone 4K
  // video can be well over a GB) never has to sit fully in process memory —
  // callers with big files stream from a multer disk-temp file straight
  // through to the destination instead of buffering it first.
  save(key: string, data: Buffer | Readable, contentType: string): Promise<void>;
  read(key: string): Promise<Buffer | null>;
  remove(key: string): Promise<void>;
  /** Create a real folder tree when the backend supports empty folders. */
  ensureFolder?(key: string): Promise<{ webUrl?: string }>;
  /** List direct file children when the backend can be changed outside CRM. */
  listFolder?(key: string): Promise<StorageObject[]>;
  /**
   * A real filesystem path to the object's bytes — ffmpeg needs actual file
   * access, not a Buffer (a video can be well over a GB; buffering that in
   * process memory just to hand it to ffmpeg would undo the point of the
   * streaming upload path). The local driver returns its existing path
   * directly, no copy. `cleanup` is a no-op there; for a driver that has to
   * download first (s3), it removes the temp copy. Always call it when done.
   */
  readToTempFile(key: string): Promise<{ path: string; cleanup: () => Promise<void> } | null>;
}

export interface StorageObject {
  key: string;
  name: string;
  size: number;
  mimeType: string;
  lastModifiedAt: string | null;
  /** Stable, backend-qualified id used to make external ingestion idempotent. */
  externalId: string;
}

const localDriver: StorageDriver = {
  async save(key, data) {
    const destination = localPath(key);
    await mkdir(dirname(destination), { recursive: true });
    if (Buffer.isBuffer(data)) {
      await writeFile(destination, data);
    } else {
      await streamPipeline(data, createWriteStream(destination));
    }
  },
  async read(key) {
    try {
      return await readFile(localPath(key));
    } catch {
      return null;
    }
  },
  async remove(key) {
    await unlink(localPath(key)).catch(() => undefined);
  },
  async ensureFolder(key) {
    await mkdir(localPath(key), { recursive: true });
    return {};
  },
  async readToTempFile(key) {
    const path = localPath(key);
    try {
      await stat(path);
    } catch {
      return null;
    }
    return { path, cleanup: async () => undefined };
  },
};

/** Resolve a storage key against the local root, with traversal protection. */
export function localPath(key: string): string {
  const root = config.storage.localPath;
  const destination = resolve(join(root, key));
  if (!destination.startsWith(resolve(root))) throw new Error('Invalid storage path');
  return destination;
}

async function s3Driver(settings: StorageSettings): Promise<StorageDriver> {
  const {
    S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand,
  } = await import('@aws-sdk/client-s3');
  const client = new S3Client({
    region: settings.s3.region || 'ap-south-1',
    ...(settings.s3.endpoint ? { endpoint: settings.s3.endpoint } : {}),
    credentials: settings.s3.accessKeyId && settings.s3.secretAccessKey
      ? { accessKeyId: settings.s3.accessKeyId, secretAccessKey: settings.s3.secretAccessKey }
      : undefined,
  });
  const Bucket = settings.s3.bucket;

  return {
    async save(key, data, contentType) {
      await client.send(new PutObjectCommand({ Bucket, Key: key, Body: data, ContentType: contentType }));
    },
    async read(key) {
      try {
        const out = await client.send(new GetObjectCommand({ Bucket, Key: key }));
        const body = out.Body;
        if (!body) return null;
        const bytes = await body.transformToByteArray();
        return Buffer.from(bytes);
      } catch {
        return null;
      }
    },
    async remove(key) {
      await client.send(new DeleteObjectCommand({ Bucket, Key: key }));
    },
    async ensureFolder() {
      // S3 prefixes are virtual and appear as soon as the first object is saved.
      return {};
    },
    async readToTempFile(key) {
      try {
        const out = await client.send(new GetObjectCommand({ Bucket, Key: key }));
        if (!out.Body) return null;
        const path = join(os.tmpdir(), `ipropy-media-${randomUUID()}`);
        await streamPipeline(out.Body as Readable, createWriteStream(path));
        return { path, cleanup: async () => unlink(path).catch(() => undefined) };
      } catch {
        return null;
      }
    },
  };
}

/**
 * The driver that owns the *folders people open*, which is not always the one
 * that serves files.
 *
 * With OneDrive switched on, property folders live there — somewhere a person
 * can open, drop originals into, and read the details file — while the website
 * carries on serving from R2. With it off, folders fall back to whatever serves
 * files, which is right for a single-server install and does nothing useful on
 * R2, where a folder is a prefix that does not exist until a file is in it.
 */
export async function getFolderDriver(): Promise<StorageDriver> {
  const settings = getStorageSettings();
  if (getSettings().storage.foldersInOneDrive) {
    const { createOneDriveDriver } = await import('./onedrive.js');
    return createOneDriveDriver(settings.onedrive);
  }
  return getDriver();
}

export async function getDriver(): Promise<StorageDriver> {
  const settings = getStorageSettings();
  if (settings.driver === 'onedrive') {
    const { createOneDriveDriver } = await import('./onedrive.js');
    return createOneDriveDriver(settings.onedrive);
  }
  if (settings.driver === 's3') {
    if (!settings.s3.bucket) {
      throw new Error('Storage driver is set to s3 but no bucket is configured (Admin → Integrations → S3)');
    }
    return s3Driver(settings);
  }
  return localDriver;
}
