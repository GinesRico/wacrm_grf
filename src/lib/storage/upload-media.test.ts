import { describe, expect, it } from 'vitest';
import {
  buildIncomingMediaPath,
  buildMediaPath,
  MEDIA_MAX_BYTES_BY_KIND,
} from './upload-media';

const ACCOUNT = '11111111-2222-3333-4444-555555555555';

describe('buildMediaPath', () => {
  it('namespaces under account-<id> so RLS write policies match', () => {
    const path = buildMediaPath(ACCOUNT, 'photo.png', 1700000000000);
    expect(path).toBe(`account-${ACCOUNT}/1700000000000-photo.png`);
    expect(path.split('/')[0]).toBe(`account-${ACCOUNT}`);
  });

  it('lower-cases the extension and sanitizes the basename', () => {
    const path = buildMediaPath(
      ACCOUNT,
      'My Invoice (final).PDF',
      1700000000000
    );
    expect(path).toBe(`account-${ACCOUNT}/1700000000000-My_Invoice_final_.pdf`);
  });

  it('caps the basename at 40 chars', () => {
    const long = 'a'.repeat(100) + '.png';
    const path = buildMediaPath(ACCOUNT, long, 1700000000000);
    const base = path
      .split('/')[1]
      .replace('1700000000000-', '')
      .replace('.png', '');
    expect(base.length).toBe(40);
  });

  it("falls back to 'file' / 'bin' for a nameless input", () => {
    const path = buildMediaPath(ACCOUNT, '', 1700000000000);
    expect(path).toBe(`account-${ACCOUNT}/1700000000000-file.bin`);
  });

  it('defaults the extension to bin when there is none', () => {
    const path = buildMediaPath(ACCOUNT, 'README', 1700000000000);
    expect(path).toBe(`account-${ACCOUNT}/1700000000000-README.bin`);
  });
});

describe('buildIncomingMediaPath', () => {
  it('groups customer media under the account incoming folder', () => {
    const path = buildIncomingMediaPath({
      accountId: ACCOUNT,
      mediaId: 'wamedia123',
      mimeType: 'image/png',
      now: 1700000000000,
    });

    expect(path).toBe(
      `account-${ACCOUNT}/incoming/1700000000000-wamedia123.png`
    );
  });

  it('preserves document filenames when Meta provides one', () => {
    const path = buildIncomingMediaPath({
      accountId: ACCOUNT,
      mediaId: 'wamedia123',
      fileName: 'Factura Final.PDF',
      mimeType: 'application/pdf',
      now: 1700000000000,
    });

    expect(path).toBe(
      `account-${ACCOUNT}/incoming/1700000000000-Factura_Final.pdf`
    );
  });

  it('falls back to bin for unknown MIME types', () => {
    const path = buildIncomingMediaPath({
      accountId: ACCOUNT,
      mediaId: 'wamedia123',
      mimeType: 'application/x-custom',
      now: 1700000000000,
    });

    expect(path).toBe(
      `account-${ACCOUNT}/incoming/1700000000000-wamedia123.bin`
    );
  });
});

describe('MEDIA_MAX_BYTES_BY_KIND', () => {
  it("caps images at Meta's tighter 5 MB limit", () => {
    expect(MEDIA_MAX_BYTES_BY_KIND.image).toBe(5 * 1024 * 1024);
  });

  it('caps video/audio/document at the 16 MB bucket limit', () => {
    expect(MEDIA_MAX_BYTES_BY_KIND.video).toBe(16 * 1024 * 1024);
    expect(MEDIA_MAX_BYTES_BY_KIND.audio).toBe(16 * 1024 * 1024);
    expect(MEDIA_MAX_BYTES_BY_KIND.document).toBe(16 * 1024 * 1024);
  });
});
