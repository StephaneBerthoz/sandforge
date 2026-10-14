import { expect, test } from '@playwright/test';

import { encodeGif, type GifFrame } from './gifEncoder';
import { readPng } from './readPng';

/**
 * The GIF encoder behind the Marketplace animation, read back by a decoder
 * written here from the format alone: a picture that looks right in one
 * browser proves little about the codes underneath, and the first viewer to
 * read them strictly would show garbage.
 */

/** What a decoder reads back: the screen after each frame is drawn. */
interface DecodedGif {
  width: number;
  height: number;
  /** The NETSCAPE2.0 loop count, or null without one: the animation plays once. */
  loops: number | null;
  frames: Array<{ delayCs: number; disposal: number; colours: number; rgba: Uint8Array }>;
}

/** Read a GIF the way a viewer does, compositing each frame onto the screen. */
function decodeGif(gif: Uint8Array): DecodedGif {
  let pos = 0;
  const byte = (): number => {
    if (pos >= gif.length) throw new Error('the GIF ends before its trailer');
    return gif[pos++];
  };
  const u16 = (): number => byte() | (byte() << 8);
  const ascii = (length: number): string =>
    String.fromCharCode(...Array.from({ length }, () => byte()));
  const table = (packed: number): Uint8Array => {
    const size = 3 * (1 << ((packed & 7) + 1));
    const read = gif.slice(pos, pos + size);
    pos += size;
    return read;
  };
  const subBlocks = (): Uint8Array => {
    const chunks: number[] = [];
    for (let length = byte(); length > 0; length = byte()) {
      for (let i = 0; i < length; i++) chunks.push(byte());
    }
    return Uint8Array.from(chunks);
  };

  expect(ascii(6)).toBe('GIF89a');
  const width = u16();
  const height = u16();
  const screen = byte();
  byte(); // background colour index
  byte(); // pixel aspect ratio
  const globalTable = screen & 0x80 ? table(screen) : null;

  const canvas = new Uint8Array(width * height * 4);
  const frames: DecodedGif['frames'] = [];
  let loops: number | null = null;
  let delayCs = 0;
  let disposal = 0;
  for (;;) {
    const introducer = byte();
    if (introducer === 0x3b) break;
    if (introducer === 0x21) {
      const label = byte();
      const body = subBlocks();
      if (label === 0xf9) {
        disposal = (body[0] >> 2) & 7;
        delayCs = body[1] | (body[2] << 8);
      } else if (label === 0xff && String.fromCharCode(...body.subarray(0, 11)) === 'NETSCAPE2.0') {
        // Identifier, then the loop sub-block: its id (1) and the count.
        expect(body[11]).toBe(1);
        loops = body[12] | (body[13] << 8);
      }
      continue;
    }
    if (introducer !== 0x2c) {
      throw new Error(`no GIF block starts with 0x${introducer.toString(16)} (byte ${pos - 1})`);
    }
    const left = u16();
    const top = u16();
    const w = u16();
    const h = u16();
    const packed = byte();
    expect(packed & 0x40, 'interlaced frames are not written').toBe(0);
    const colours = packed & 0x80 ? table(packed) : globalTable;
    if (!colours) throw new Error('a frame without any colour table');
    const minCodeSize = byte();
    const indices = lzwDecode(subBlocks(), minCodeSize);
    expect(indices.length, 'pixels decoded for the frame').toBe(w * h);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const index = indices[y * w + x];
        expect(index * 3 < colours.length, `index ${index} past the colour table`).toBe(true);
        const at = ((top + y) * width + left + x) * 4;
        canvas[at] = colours[index * 3];
        canvas[at + 1] = colours[index * 3 + 1];
        canvas[at + 2] = colours[index * 3 + 2];
        canvas[at + 3] = 255;
      }
    }
    frames.push({ delayCs, disposal, colours: colours.length / 3, rgba: canvas.slice() });
  }
  expect(pos, 'bytes after the trailer').toBe(gif.length);
  return { width, height, loops, frames };
}

/**
 * GIF's LZW, decoded as the format describes it: the dictionary gains an
 * entry with each code after the first, and the code width grows when the
 * dictionary fills the current width.
 */
function lzwDecode(data: Uint8Array, minCodeSize: number): number[] {
  const clear = 1 << minCodeSize;
  const end = clear + 1;
  let entries: number[][] = [];
  let codeSize = 0;
  const reset = (): void => {
    entries = Array.from({ length: clear + 2 }, (_, i) => (i < clear ? [i] : []));
    codeSize = minCodeSize + 1;
  };
  reset();

  const out: number[] = [];
  let bit = 0;
  let previous: number[] | null = null;
  let ended = false;
  while (bit + codeSize <= data.length * 8) {
    let code = 0;
    for (let i = 0; i < codeSize; i++, bit++) {
      if ((data[bit >> 3] >> (bit & 7)) & 1) code |= 1 << i;
    }
    if (code === clear) {
      reset();
      previous = null;
      continue;
    }
    if (code === end) {
      ended = true;
      break;
    }
    let entry: number[];
    if (code < entries.length) {
      entry = entries[code];
    } else if (code === entries.length && previous) {
      entry = [...previous, previous[0]];
    } else {
      throw new Error(`code ${code} names no entry: the dictionary holds ${entries.length}`);
    }
    for (const index of entry) out.push(index);
    if (previous && entries.length < 4096) entries.push([...previous, entry[0]]);
    previous = entry;
    if (entries.length === 1 << codeSize && codeSize < 12) codeSize++;
  }
  expect(ended, 'the data ends on an end-of-information code').toBe(true);
  return out;
}

/** A repeatable stream of numbers in [0, 1), so a failing image can be rebuilt. */
function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A frame painted pixel by pixel from a function answering 0xRRGGBB. */
function paint(
  width: number,
  height: number,
  delayMs: number,
  colourAt: (x: number, y: number) => number,
): GifFrame {
  const rgba = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const colour = colourAt(x, y);
      const at = (y * width + x) * 4;
      rgba[at] = colour >> 16;
      rgba[at + 1] = (colour >> 8) & 0xff;
      rgba[at + 2] = colour & 0xff;
      rgba[at + 3] = 255;
    }
  }
  return { width, height, rgba, delayMs };
}

/** The first pixel at which two RGBA images differ, or -1. */
function firstDifference(a: Uint8Array, b: Uint8Array): number {
  expect(a.length).toBe(b.length);
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return i >> 2;
  return -1;
}

/** How many colours an RGBA image holds. */
function distinctColours(rgba: Uint8Array): number {
  const seen = new Set<number>();
  for (let i = 0; i < rgba.length; i += 4)
    seen.add((rgba[i] << 16) | (rgba[i + 1] << 8) | rgba[i + 2]);
  return seen.size;
}

/** The widest gap, over every pixel and channel, between two RGBA images. */
function largestError(a: Uint8Array, b: Uint8Array): number {
  let largest = 0;
  for (let i = 0; i < a.length; i++) {
    if ((i & 3) !== 3) largest = Math.max(largest, Math.abs(a[i] - b[i]));
  }
  return largest;
}

test('writes a GIF89a that loops forever, with each frame, its size and its delay', () => {
  const frames = [
    paint(7, 5, 2500, (x, y) => ((x + y) % 2 ? 0x1e1e1e : 0xe8a87c)),
    paint(7, 5, 2200, (x) => (x < 3 ? 0x1e1e1e : 0x3794ff)),
    paint(7, 5, 4000, (x, y) => [0x1e1e1e, 0xcccccc, 0x89d185][(x * y) % 3]),
  ];

  const gif = encodeGif(frames);
  const decoded = decodeGif(gif);

  expect(decoded.width).toBe(7);
  expect(decoded.height).toBe(5);
  expect(decoded.loops).toBe(0);
  expect(decoded.frames.map((frame) => frame.delayCs)).toEqual([250, 220, 400]);
  for (const [n, frame] of decoded.frames.entries()) {
    expect(firstDifference(frame.rgba, frames[n].rgba), `frame ${n}, first pixel off`).toBe(-1);
  }
});

test('keeps every colour of a frame that holds 256 or fewer, through dictionary resets and every code width', () => {
  // Noise over 256 colours compresses badly: nearly every pixel adds an
  // entry, so the dictionary fills and starts over several times, and the
  // codes pass through every width from 9 bits to 12.
  const next = random(1);
  const colours = Array.from({ length: 256 }, (_, i) => (i * 0x9e3779b1) & 0xffffff);
  const frame = paint(160, 120, 2000, () => colours[Math.floor(next() * 256)]);

  const decoded = decodeGif(encodeGif([frame]));

  expect(decoded.frames).toHaveLength(1);
  expect(decoded.frames[0].colours).toBe(256);
  expect(firstDifference(decoded.frames[0].rgba, frame.rgba), 'first pixel off').toBe(-1);
});

test('a frame of one colour still writes the two-bit minimum the format asks for', () => {
  const frame = paint(3, 2, 1000, () => 0x252526);

  const decoded = decodeGif(encodeGif([frame]));

  expect(decoded.frames[0].colours).toBe(2);
  expect(firstDifference(decoded.frames[0].rgba, frame.rgba), 'first pixel off').toBe(-1);
});

test('a frame of more than 256 colours keeps its flat colours exact and every other pixel near', () => {
  // A panel in miniature: a background, a card, a line of "text" with a ramp
  // of antialiasing into the card, and a gradient of 4096 colours no table can
  // hold, which forces the cut.
  const background = 0x1e1e1e;
  const card = 0x252526;
  const text = 0xcccccc;
  const frame = paint(128, 96, 2000, (x, y) => {
    if (y >= 64) return ((x * 2) << 16) | (((y - 64) * 8) << 8) | 0x40;
    if (x < 8 || y < 8) return background;
    if (y >= 20 && y < 24 && x >= 16 && x < 112) {
      const shade = (x % 8) * 20;
      return x % 8 === 0 ? text : ((0x25 + shade) << 16) | ((0x25 + shade) << 8) | (0x26 + shade);
    }
    return card;
  });

  const decoded = decodeGif(encodeGif([frame]));
  const { rgba } = decoded.frames[0];

  expect(decoded.frames[0].colours).toBe(256);
  const flat = [background, card, text];
  for (let p = 0; p < 128 * 96; p++) {
    const source = (frame.rgba[p * 4] << 16) | (frame.rgba[p * 4 + 1] << 8) | frame.rgba[p * 4 + 2];
    if (!flat.includes(source)) continue;
    const written = (rgba[p * 4] << 16) | (rgba[p * 4 + 1] << 8) | rgba[p * 4 + 2];
    expect(written.toString(16), `pixel ${p % 128},${Math.floor(p / 128)}`).toBe(
      source.toString(16),
    );
  }
  expect(largestError(rgba, frame.rgba)).toBeLessThanOrEqual(16);
});

test('refuses frames of different sizes', () => {
  expect(() => encodeGif([paint(4, 4, 1000, () => 0), paint(4, 5, 1000, () => 0)])).toThrow(
    'frame 1 is 4x5, the first 4x4',
  );
});

test('a Chromium screenshot of panel text survives the trip with its flat colours exact', async ({
  page,
}) => {
  // The path the generator takes: a PNG from the browser, read to pixels,
  // encoded. Text in three sizes over the panel's background and a card gives
  // the antialiasing a real screen has, past what a 256-entry table can hold.
  await page.setViewportSize({ width: 320, height: 160 });
  await page.setContent(`
    <body style="margin:0;background:#1e1e1e;font:13px sans-serif;color:#cccccc">
      <div style="position:absolute;left:8px;top:8px;width:304px;height:144px;background:#252526">
        <p style="margin:8px;font-size:18px;color:#e8a87c">Discover Graph</p>
        <p style="margin:8px">Account, Contact, Opportunity, Case</p>
        <p style="margin:8px;font-size:11px;color:#3794ff">Simulation, nothing was written.</p>
      </div>
    </body>`);
  const shot = readPng(await page.screenshot());

  const decoded = decodeGif(encodeGif([{ ...shot, delayMs: 1000 }]));
  const { rgba } = decoded.frames[0];

  expect(decoded.width).toBe(320);
  // The panel's background and the card, away from any glyph.
  for (const [x, y, colour] of [
    [2, 2, [0x1e, 0x1e, 0x1e]],
    [316, 156, [0x1e, 0x1e, 0x1e]],
    [300, 140, [0x25, 0x25, 0x26]],
  ] as const) {
    const at = (y * 320 + x) * 4;
    expect([...shot.rgba.subarray(at, at + 3)], `screenshot at ${x},${y}`).toEqual(colour);
    expect([...rgba.subarray(at, at + 3)], `GIF at ${x},${y}`).toEqual(colour);
  }
  expect(distinctColours(shot.rgba), 'colours in the screenshot').toBeGreaterThan(256);
  expect(largestError(rgba, shot.rgba)).toBeLessThanOrEqual(24);
});
