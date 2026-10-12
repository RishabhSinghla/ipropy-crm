/**
 * An iPhone exports a group as a .zip holding `_chat.txt`; Android gives the
 * .txt itself. Both go through the same screen, so this reads the text out of
 * the zip and the rest of the import never knows the difference.
 */
import yauzl from 'yauzl';
import { BadRequestError } from '../../utils/errors.js';

/** A year of a very busy group is a few megabytes; far beyond that is not a chat. */
const MAX_TEXT_BYTES = 60 * 1024 * 1024;

export function looksLikeAZip(buffer: Buffer): boolean {
  return buffer.length > 4 && buffer[0] === 0x50 && buffer[1] === 0x4b;
}

export function chatTextFromZip(buffer: Buffer): Promise<string> {
  return new Promise((resolve, reject) => {
    yauzl.fromBuffer(buffer, { lazyEntries: true }, (openError, zip) => {
      if (openError || !zip) {
        reject(new BadRequestError('That zip could not be opened. Export the chat again and choose the file WhatsApp made.'));
        return;
      }
      let best: yauzl.Entry | null = null;
      zip.on('entry', (entry: yauzl.Entry) => {
        const name = entry.fileName;
        // Macs add a __MACOSX folder of junk twins next to the real file.
        const real = name.endsWith('.txt') && !name.startsWith('__MACOSX/') && !name.split('/').pop()!.startsWith('._');
        if (real && (!best || name.endsWith('_chat.txt'))) best = entry;
        zip.readEntry();
      });
      zip.on('end', () => {
        if (!best) {
          reject(new BadRequestError('There is no chat text inside that zip.'));
          return;
        }
        if (best.uncompressedSize > MAX_TEXT_BYTES) {
          reject(new BadRequestError('That chat is too large to read in one go.'));
          return;
        }
        zip.openReadStream(best, (streamError, stream) => {
          if (streamError || !stream) {
            reject(new BadRequestError('The chat inside that zip could not be read.'));
            return;
          }
          const parts: Buffer[] = [];
          stream.on('data', (part: Buffer) => parts.push(part));
          stream.on('end', () => { zip.close(); resolve(Buffer.concat(parts).toString('utf8')); });
          stream.on('error', reject);
        });
      });
      zip.on('error', reject);
      zip.readEntry();
    });
  });
}

export interface ChatFile {
  /** The path inside the zip, or the file name for a plain .txt. */
  path: string;
  text: string;
}

/** Several chats in one zip is normal when somebody exports a few groups together. */
const MAX_CHATS_PER_ZIP = 100;
const MAX_TOTAL_BYTES = 200 * 1024 * 1024;

/** Every chat text inside a zip, `_chat.txt` first. Rejects what cannot be opened rather than returning nothing. */
export function chatsFromZip(buffer: Buffer): Promise<ChatFile[]> {
  return new Promise((resolve, reject) => {
    yauzl.fromBuffer(buffer, { lazyEntries: true }, (openError, zip) => {
      if (openError || !zip) {
        reject(new BadRequestError('That zip could not be opened. Export the chat again and choose the file WhatsApp made.'));
        return;
      }
      const entries: yauzl.Entry[] = [];
      zip.on('entry', (entry: yauzl.Entry) => {
        const name = entry.fileName;
        const real = name.endsWith('.txt') && !name.startsWith('__MACOSX/') && !name.split('/').pop()!.startsWith('._');
        if (real && entries.length < MAX_CHATS_PER_ZIP) entries.push(entry);
        zip.readEntry();
      });
      zip.on('error', reject);
      zip.on('end', () => {
        const total = entries.reduce((sum, entry) => sum + entry.uncompressedSize, 0);
        if (total > MAX_TOTAL_BYTES) {
          reject(new BadRequestError('Those chats are too large to read in one go.'));
          return;
        }
        const out: ChatFile[] = [];
        const next = (index: number): void => {
          const entry = entries[index];
          if (!entry) {
            zip.close();
            resolve(out.sort((a, b) => Number(b.path.endsWith('_chat.txt')) - Number(a.path.endsWith('_chat.txt'))));
            return;
          }
          zip.openReadStream(entry, (streamError, stream) => {
            if (streamError || !stream) { next(index + 1); return; }
            const parts: Buffer[] = [];
            stream.on('data', (part: Buffer) => parts.push(part));
            stream.on('error', () => next(index + 1));
            stream.on('end', () => { out.push({ path: entry.fileName, text: Buffer.concat(parts).toString('utf8') }); next(index + 1); });
          });
        };
        next(0);
      });
      zip.readEntry();
    });
  });
}

/**
 * The group a chat file is, from what WhatsApp named it:
 * "WhatsApp Chat with FEAWA Members.txt", "WhatsApp Chat - FEAWA Members/_chat.txt", or a zip
 * called "WhatsApp Chat - FEAWA Members.zip" holding a bare `_chat.txt`.
 */
export function groupFromFileName(path: string, fallbackFileName = ''): string {
  const parts = path.split(/[\\/]/).filter(Boolean);
  const file = (parts.pop() ?? '').replace(/\.(txt|zip)$/i, '');
  const generic = /^_?chat$/i.test(file);
  const raw = generic ? (parts.pop() ?? fallbackFileName.replace(/\.(txt|zip)$/i, '')) : file;
  const name = raw
    .replace(/^whatsapp chat\s*(?:with|-|–)?\s*/i, '')
    .replace(/^chat\s*(?:with|-|–)\s*/i, '')
    .replace(/\s*\(\d+\)\s*$/, '')
    .replace(/\s+/g, ' ')
    .trim();
  return name || 'WhatsApp group';
}
