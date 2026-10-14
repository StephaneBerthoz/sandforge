import { expect, test } from '@playwright/test';
import { deflateSync } from 'node:zlib';

import { readPng } from './readPng';

/**
 * The PNG reader the animation's frames go through. PNGs are built here with
 * every row filter the format has, so that each is undone at least once, and
 * a real Chromium screenshot is read back against the colours it was drawn
 * with.
 */

/** The CRC32 PNG chunks carry. */
function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/** One chunk: length, type, data, CRC over type and data. */
function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  out.set(
    Array.from(type, (char) => char.charCodeAt(0)),
    4,
  );
  out.set(data, 8);
  view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

/**
 * A PNG of `pixels` (`channels` bytes a pixel, 3 or 4), with row `y` written
 * through filter `y % 5`: none, sub, up, average, Paeth in turn.
 */
function writePng(width: number, height: number, channels: 3 | 4, pixels: Uint8Array): Uint8Array {
  const stride = width * channels;
  const raw = new Uint8Array(height * (stride + 1));
  for (let y = 0; y < height; y++) {
    const filter = y % 5;
    raw[y * (stride + 1)] = filter;
    for (let x = 0; x < stride; x++) {
      const left = x >= channels ? pixels[y * stride + x - channels] : 0;
      const up = y > 0 ? pixels[(y - 1) * stride + x] : 0;
      const upLeft = x >= channels && y > 0 ? pixels[(y - 1) * stride + x - channels] : 0;
      const guess = left + up - upLeft;
      const nearest =
        Math.abs(guess - left) <= Math.abs(guess - up) &&
        Math.abs(guess - left) <= Math.abs(guess - upLeft)
          ? left
          : Math.abs(guess - up) <= Math.abs(guess - upLeft)
            ? up
            : upLeft;
      const predicted = [0, left, up, Math.floor((left + up) / 2), nearest][filter];
      raw[y * (stride + 1) + 1 + x] = (pixels[y * stride + x] - predicted + 256) % 256;
    }
  }
  const header = new Uint8Array(13);
  const view = new DataView(header.buffer);
  view.setUint32(0, width);
  view.setUint32(4, height);
  header.set([8, channels === 4 ? 6 : 2, 0, 0, 0], 8);
  const parts = [
    Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', new Uint8Array(0)),
  ];
  const png = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    png.set(part, offset);
    offset += part.length;
  }
  return png;
}

/**
 * Bytes drawn from four values, as a screen is drawn from a few colours. Left
 * 10, above 40 and above-left 20 is a tie Paeth breaks towards above, and
 * these values meet it in every few rows: a reader that broke it the other
 * way would rebuild the rows wrong from there.
 */
function pattern(length: number): Uint8Array {
  let state = 7;
  return Uint8Array.from({ length }, () => {
    state = (state * 1103515245 + 12345) >>> 0;
    return [10, 20, 40, 200][state >>> 30];
  });
}

test('reads an RGBA PNG through all five row filters', () => {
  const pixels = pattern(17 * 20 * 4);

  const image = readPng(writePng(17, 20, 4, pixels));

  expect(image.width).toBe(17);
  expect(image.height).toBe(20);
  expect([...image.rgba]).toEqual([...pixels]);
});

test('reads an RGB PNG through all five row filters, opaque', () => {
  const pixels = pattern(16 * 20 * 3);

  const image = readPng(writePng(16, 20, 3, pixels));

  const expected: number[] = [];
  for (let i = 0; i < pixels.length; i += 3)
    expected.push(pixels[i], pixels[i + 1], pixels[i + 2], 255);
  expect([...image.rgba]).toEqual(expected);
});

test('refuses what is not a PNG, and a PNG shape it does not read', () => {
  expect(() => readPng(Uint8Array.from([1, 2, 3]))).toThrow('not a PNG');
  const sixteenBit = writePng(1, 1, 3, new Uint8Array(3));
  // IHDR's data starts after the signature, the length and the type: its
  // bit depth is the ninth byte of it.
  sixteenBit[8 + 8 + 8] = 16;
  expect(() => readPng(sixteenBit)).toThrow('bit depth 16');
});

test('reads a Chromium screenshot back as the colours it was drawn with', async ({ page }) => {
  await page.setViewportSize({ width: 40, height: 20 });
  await page.setContent(`
    <body style="margin:0;display:flex">
      <div style="width:10px;height:20px;background:#1e1e1e"></div>
      <div style="width:10px;height:20px;background:#e8a87c"></div>
      <div style="width:10px;height:20px;background:#3794ff"></div>
      <div style="width:10px;height:20px;background:#89d185"></div>
    </body>`);

  const image = readPng(await page.screenshot());

  expect(image.width).toBe(40);
  expect(image.height).toBe(20);
  const at = (x: number, y: number): number[] => {
    const offset = (y * 40 + x) * 4;
    return [...image.rgba.subarray(offset, offset + 4)];
  };
  expect(at(5, 10)).toEqual([0x1e, 0x1e, 0x1e, 255]);
  expect(at(15, 3)).toEqual([0xe8, 0xa8, 0x7c, 255]);
  expect(at(25, 17)).toEqual([0x37, 0x94, 0xff, 255]);
  expect(at(35, 10)).toEqual([0x89, 0xd1, 0x85, 255]);
});
