import { describe, expect, it } from 'vitest';
import { chatsFromZip, chatTextFromZip, groupFromFileName, looksLikeAZip } from '../src/core/market/unzipChat.js';

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

// Two chats in one zip: one in a folder named for the group, one named for it.
const TWO_CHATS = Buffer.from('UEsDBBQAAAAIAKKMTF0621G4jwAAAMsAAAAvAAAAV2hhdHNBcHAgQ2hhdCAtIFpJUE1BUksgQWxwaGEgRGVhbGVycy9fY2hhdC50eHRdzbsOgkAUhOGep5gHUDl7AA10aGNip5V2B1hxdbm4LhY+vSRGEu0mU/yf4lBRyMTLGdKMCNJgjpOukNv+IhnypxgrhdU4dw4PGUeE9XYH0+KgSz+eqcLL9I24G9SCsXEoxVqkK1IcxQmpQP0qyUc5SvtV9vo+GDeqnBBquaK3nZ/6PPWLoaq1R4zyH+HgDVBLAwQUAAAACACijExdYpOK1lgAAABeAAAAKwAAAFdoYXRzQXBwIENoYXQgd2l0aCBaSVBNQVJLIEJldGEgRGVhbGVycy50eHQNyDsOgCAQBcDeU7wDaFgWP8HSK9jYbggaFYUglafXbjKalSbFxH0NTSMR5EKDxd+YfJER/NcmB1KIBWvMeCR4zN6V39bg3dMl+YSBy3ASAuxAmk3bkak+UEsBAhQDFAAAAAgAooxMXTrbUbiPAAAAywAAAC8AAAAAAAAAAAAAAIABAAAAAFdoYXRzQXBwIENoYXQgLSBaSVBNQVJLIEFscGhhIERlYWxlcnMvX2NoYXQudHh0UEsBAhQDFAAAAAgAooxMXWKTitZYAAAAXgAAACsAAAAAAAAAAAAAAIAB3AAAAFdoYXRzQXBwIENoYXQgd2l0aCBaSVBNQVJLIEJldGEgRGVhbGVycy50eHRQSwUGAAAAAAIAAgC2AAAAfQEAAAAA', 'base64');

describe('many chats, named from their files', () => {
  it('reads every chat in a zip, and the _chat.txt first', async () => {
    const chats = await chatsFromZip(TWO_CHATS);
    expect(chats.map((chat) => chat.path)).toEqual([
      'WhatsApp Chat - ZIPMARK Alpha Dealers/_chat.txt',
      'WhatsApp Chat with ZIPMARK Beta Dealers.txt',
    ]);
    expect(chats[0]!.text).toContain('Sector 91');
  });

  it('names the group the way WhatsApp named the file', () => {
    expect(groupFromFileName('WhatsApp Chat with FEAWA REGISTERED MEMBERS.txt')).toBe('FEAWA REGISTERED MEMBERS');
    expect(groupFromFileName('WhatsApp Chat - FEAWA Members/_chat.txt')).toBe('FEAWA Members');
    expect(groupFromFileName('_chat.txt', 'WhatsApp Chat - Greenfields Dealers.zip')).toBe('Greenfields Dealers');
    expect(groupFromFileName('WhatsApp Chat with Sector 15 Dealers (2).txt')).toBe('Sector 15 Dealers');
    expect(groupFromFileName('whatever.txt')).toBe('whatever');
    expect(groupFromFileName('.txt')).toBe('WhatsApp group');
  });
});
