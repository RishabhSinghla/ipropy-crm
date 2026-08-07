/**
 * Storage abstraction. The active configuration is resolved DB-first
 * (Admin → Integrations → S3) with `.env` as fallback, matching how every
 * other integration credential is handled. The local driver is the default;
 * the S3 driver is only loaded (and the AWS SDK only imported) when the
 * resolved driver is `s3`.
 */
import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { config } from '../../config.js';
import { getSettings } from '../settings/integrations.js';

export interface StorageSettings {
  driver: 'local' | 's3';
  localPath: string;
  s3: {
    bucket: string;
    region: string;
    accessKeyId: string;
    secretAccessKey: string;
    endpoint: string;
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
  };
}

export interface StorageDriver {
  save(key: string, data: Buffer, contentType: string): Promise<void>;
  read(key: string): Promise<Buffer | null>;
  remove(key: string): Promise<void>;
}

const localDriver: StorageDriver = {
  async save(key, data) {
    const destination = localPath(key);
    await mkdir(dirname(destination), { recursive: true });
    await writeFile(destination, data);
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
      await client.send(new DeleteObjectCommand({ Bucket, Key: key })).catch(() => undefined);
    },
  };
}

export async function getDriver(): Promise<StorageDriver> {
  const settings = getStorageSettings();
  if (settings.driver === 's3') {
    if (!settings.s3.bucket) {
      throw new Error('Storage driver is set to s3 but no bucket is configured (Admin → Integrations → S3)');
    }
    return s3Driver(settings);
  }
  return localDriver;
}
