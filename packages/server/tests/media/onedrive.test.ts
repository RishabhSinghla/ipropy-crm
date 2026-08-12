import { describe, expect, it } from 'vitest';
import {
  encodeGraphPath, normalisePath, ONEDRIVE_CHUNK_SIZE, uploadRanges,
} from '../../src/core/storage/onedrive.js';

describe('OneDrive path handling', () => {
  it('encodes each human-readable segment without losing its hierarchy', () => {
    expect(encodeGraphPath('iPropy Properties/B-110/01 Originals/IMG #1.jpg'))
      .toBe('iPropy%20Properties/B-110/01%20Originals/IMG%20%231.jpg');
  });

  it('normalises separators and rejects traversal', () => {
    expect(normalisePath('/properties\\B-110//01 Originals/')).toBe('properties/B-110/01 Originals');
    expect(() => normalisePath('properties/../secrets')).toThrow('Invalid OneDrive storage path');
    expect(() => normalisePath('properties/illegal:name')).toThrow('Microsoft does not allow');
  });
});

describe('OneDrive resumable chunks', () => {
  it('covers every byte in ordered 10 MiB fragments', () => {
    const size = ONEDRIVE_CHUNK_SIZE * 2 + 17;
    expect(uploadRanges(size)).toEqual([
      { start: 0, end: ONEDRIVE_CHUNK_SIZE - 1 },
      { start: ONEDRIVE_CHUNK_SIZE, end: ONEDRIVE_CHUNK_SIZE * 2 - 1 },
      { start: ONEDRIVE_CHUNK_SIZE * 2, end: size - 1 },
    ]);
  });

  it('refuses fragment sizes Microsoft Graph cannot commit', () => {
    expect(() => uploadRanges(1000, 1024 * 1024)).toThrow('multiple of 320 KiB');
  });
});
