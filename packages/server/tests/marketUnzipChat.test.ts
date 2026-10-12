import { describe, expect, it } from 'vitest';
import { chatTextFromZip, looksLikeAZip } from '../src/core/market/unzipChat.js';

// Made with Python's zipfile: a junk __MACOSX twin plus the real _chat.txt in a folder.
const ZIP = Buffer.from('UEsDBBQAAAAIAK+ATF2DFtyMAwAAAAEAAAATAAAAX19NQUNPU1gvLl9qdW5rLnR4dKsAAFBLAwQUAAAACACvgExdumr7mj8AAAA9AAAAIQAAAFdoYXRzQXBwIENoYXQgLSBEZWFsZXJzL19jaGF0LnR4dDM00jc00DcyMDLTUTA0sDI0VUjMVdBVcMzLzLFSCEotLM0sSk1RMDI1UEhPzFIoyMkvUShOTS7JL1KwMOUCAFBLAQIUAxQAAAAIAK+ATF2DFtyMAwAAAAEAAAATAAAAAAAAAAAAAACAAQAAAABfX01BQ09TWC8uX2p1bmsudHh0UEsBAhQDFAAAAAgAr4BMXbpq+5o/AAAAPQAAACEAAAAAAAAAAAAAAIABNAAAAFdoYXRzQXBwIENoYXQgLSBEZWFsZXJzL19jaGF0LnR4dFBLBQYAAAAAAgACAJAAAACyAAAAAAA=', 'base64');

describe('reading an iPhone export', () => {
  it('recognises a zip by its first bytes, and plain text as not one', () => {
    expect(looksLikeAZip(ZIP)).toBe(true);
    expect(looksLikeAZip(Buffer.from('12/10/2026, 10:15 am - Anil: hello'))).toBe(false);
  });

  it('returns the chat, ignoring the Mac junk file beside it', async () => {
    expect(await chatTextFromZip(ZIP)).toContain('Required 250 gaj plot sector 85');
  });

  it('refuses a file that only claims to be a zip', async () => {
    await expect(chatTextFromZip(Buffer.from('PK not really'))).rejects.toThrow(/zip/i);
  });
});
