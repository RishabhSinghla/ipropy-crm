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
