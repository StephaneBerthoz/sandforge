import type { RgbaImage } from './readPng';

/**
 * GIF89a encoding for the animation the Marketplace listing opens on.
 *
 * The screenshot generator writes it, so that the animation is redrawn from
 * the product each time the stills are and cannot go on showing a screen the
 * product has dropped — which is what a hand-made one did for months. The
 * generator runs where no image tool can be assumed, and an animation of a
 * handful of panel screens needs only three things: a palette per frame, LZW
 * compression, and the container around them.
 */

/** One picture of an animation, and how long it stays on screen. */
export interface GifFrame extends RgbaImage {
  /** In milliseconds; GIF counts in hundredths of a second. */
  delayMs: number;
}

/** The most colours one frame's table can hold. */
const MAX_COLOURS = 256;

/** LZW codes are at most twelve bits wide, so a dictionary holds 4096 entries. */
const MAX_CODES = 4096;

/** The most bytes one data sub-block carries: its length is one byte. */
const SUB_BLOCK = 255;

/**
 * An animation of `frames`, all of one size, that loops forever.
 *
 * Every frame carries its own colour table, picked for it alone: the screens
 * of a flow share little beyond the panel's background, and one table across
 * all of them would spend its entries on colours most frames never show.
 */
export function encodeGif(frames: readonly GifFrame[]): Uint8Array {
  const first = frames[0];
  if (!first) throw new Error('an animation needs at least one frame');
  const { width, height } = first;
  if (width < 1 || height < 1 || width > 0xffff || height > 0xffff) {
    throw new Error(`a GIF cannot be ${width}x${height}`);
  }

  const out = new ByteWriter();
  out.ascii('GIF89a');
  // Logical screen: its size, no global colour table, eight bits a channel.
  out.u16(width);
  out.u16(height);
  out.bytes(0x70, 0, 0);
  // NETSCAPE2.0 application extension: a loop count of 0 loops forever.
  out.bytes(0x21, 0xff, 11);
  out.ascii('NETSCAPE2.0');
  out.bytes(3, 1);
  out.u16(0);
  out.bytes(0);

  for (const [n, frame] of frames.entries()) {
    if (frame.width !== width || frame.height !== height) {
      throw new Error(`frame ${n} is ${frame.width}x${frame.height}, the first ${width}x${height}`);
    }
    if (frame.rgba.length !== width * height * 4) {
      throw new Error(`frame ${n} holds ${frame.rgba.length} bytes, not ${width}x${height} RGBA`);
    }
    const { palette, indices } = quantize(frame.rgba, MAX_COLOURS);
    let tableBits = 1;
    while (1 << tableBits < palette.length) tableBits++;

    // Graphic control: left in place for the next frame to draw over, no
    // transparent colour, and the delay.
    out.bytes(0x21, 0xf9, 4, 1 << 2);
    out.u16(Math.round(frame.delayMs / 10));
    out.bytes(0, 0);
    // Image descriptor: the whole screen, with a local colour table.
    out.bytes(0x2c);
    out.u16(0);
    out.u16(0);
    out.u16(width);
    out.u16(height);
    out.bytes(0x80 | (tableBits - 1));
    for (let i = 0; i < 1 << tableBits; i++) {
      const colour = palette[i] ?? 0;
      out.bytes((colour >> 16) & 0xff, (colour >> 8) & 0xff, colour & 0xff);
    }
    // The LZW code size starts from the table's width in bits, and never
    // below the two the format asks for.
    const minCodeSize = Math.max(2, tableBits);
    out.bytes(minCodeSize);
    const data = lzw(indices, minCodeSize);
    for (let start = 0; start < data.length; start += SUB_BLOCK) {
      const block = data.subarray(start, start + SUB_BLOCK);
      out.bytes(block.length);
      out.array(block);
    }
    out.bytes(0);
  }

  out.bytes(0x3b);
  return out.done();
}

/**
 * At most `maxColours` colours for an RGBA image, and each pixel's index
 * among them.
 *
 * A screen of the panel is a few flat colours and the antialiasing of its
 * text between them. An image that already holds few enough colours keeps
 * them all, exactly. Otherwise its distinct colours are cut into boxes, as
 * median cut does, each weighted by how many pixels carry it: the box cut
 * next is the one whose pixels stray furthest from its mean, so a background
 * and the text drawn on it — thousands of pixels each — get entries of their
 * own before the antialiasing ramps between them are shared out, and the
 * letters stay sharp.
 * No dithering: on text it is noise around every glyph, and it would cost
 * the compression its long runs of one index.
 */
function quantize(
  rgba: Uint8Array,
  maxColours: number,
): { palette: number[]; indices: Uint8Array } {
  const counts = new Map<number, number>();
  for (let i = 0; i < rgba.length; i += 4) {
    const key = (rgba[i] << 16) | (rgba[i + 1] << 8) | rgba[i + 2];
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }

  const colours = [...counts.keys()];
  const palette =
    colours.length <= maxColours
      ? colours
      : cutIntoBoxes(
          colours,
          colours.map((key) => counts.get(key) ?? 0),
          maxColours,
        );

  // The nearest entry for each distinct colour, then for each pixel.
  const nearest = new Map<number, number>();
  for (const key of colours) {
    const r = key >> 16;
    const g = (key >> 8) & 0xff;
    const b = key & 0xff;
    let best = 0;
    let bestDistance = Infinity;
    for (const [index, entry] of palette.entries()) {
      const dr = r - (entry >> 16);
      const dg = g - ((entry >> 8) & 0xff);
      const db = b - (entry & 0xff);
      const distance = dr * dr + dg * dg + db * db;
      if (distance < bestDistance) {
        best = index;
        bestDistance = distance;
        if (distance === 0) break;
      }
    }
    nearest.set(key, best);
  }
  const indices = new Uint8Array(rgba.length / 4);
  for (let i = 0, p = 0; i < rgba.length; i += 4, p++) {
    indices[p] = nearest.get((rgba[i] << 16) | (rgba[i + 1] << 8) | rgba[i + 2]) ?? 0;
  }
  return { palette, indices };
}

/** A run of the colours being cut, and how far its pixels stray from their mean. */
interface Box {
  start: number;
  end: number;
  error: number;
}

/** Channel `channel` (0 red, 1 green, 2 blue) of a 0xRRGGBB colour. */
const channelOf = (colour: number, channel: number): number =>
  (colour >> (16 - 8 * channel)) & 0xff;

/**
 * Cut the colours into at most `maxColours` boxes and answer each box's mean.
 *
 * A box is cut along the channel its pixels spread most on, where the cut
 * leaves the least error on either side rather than at its median: a box
 * holding a background and a few hundred pixels of text is cut between the
 * two, where a median would fall inside the background and cut nothing off.
 */
function cutIntoBoxes(colours: number[], weights: number[], maxColours: number): number[] {
  // The colours are reordered within each box as it is cut; `order` holds
  // their positions in `colours`.
  const order = colours.map((_, i) => i);

  /** Per channel, the squared distance of a box's pixels from their mean, summed. */
  const channelErrors = (start: number, end: number): number[] =>
    [0, 1, 2].map((channel) => {
      let count = 0;
      let sum = 0;
      let squares = 0;
      for (let i = start; i < end; i++) {
        const weight = weights[order[i]];
        const value = channelOf(colours[order[i]], channel);
        count += weight;
        sum += weight * value;
        squares += weight * value * value;
      }
      return squares - (sum * sum) / count;
    });
  const box = (start: number, end: number): Box => ({
    start,
    end,
    error: channelErrors(start, end).reduce((total, error) => total + error, 0),
  });

  const boxes = [box(0, order.length)];
  while (boxes.length < maxColours) {
    let worst = -1;
    for (const [i, candidate] of boxes.entries()) {
      if (
        candidate.end - candidate.start > 1 &&
        (worst < 0 || candidate.error > boxes[worst].error)
      ) {
        worst = i;
      }
    }
    if (worst < 0) break;
    const { start, end } = boxes[worst];

    // Order the box along the channel its pixels spread most on.
    const errors = channelErrors(start, end);
    const widest = errors.indexOf(Math.max(...errors));
    const sorted = order
      .slice(start, end)
      .sort(
        (a, b) =>
          channelOf(colours[a], widest) - channelOf(colours[b], widest) || colours[a] - colours[b],
      );
    for (const [i, position] of sorted.entries()) order[start + i] = position;

    // Running totals along that order give the error on either side of every
    // cut in one pass.
    const size = end - start;
    const counts = new Float64Array(size + 1);
    const sums = [0, 1, 2].map(() => new Float64Array(size + 1));
    const squares = [0, 1, 2].map(() => new Float64Array(size + 1));
    for (let i = 0; i < size; i++) {
      const weight = weights[order[start + i]];
      counts[i + 1] = counts[i] + weight;
      for (let channel = 0; channel < 3; channel++) {
        const value = channelOf(colours[order[start + i]], channel);
        sums[channel][i + 1] = sums[channel][i] + weight * value;
        squares[channel][i + 1] = squares[channel][i] + weight * value * value;
      }
    }
    let cut = 1;
    let leastError = Infinity;
    for (let k = 1; k < size; k++) {
      const left = counts[k];
      const right = counts[size] - left;
      let error = 0;
      for (let channel = 0; channel < 3; channel++) {
        const sumLeft = sums[channel][k];
        const sumRight = sums[channel][size] - sumLeft;
        error +=
          squares[channel][size] - (sumLeft * sumLeft) / left - (sumRight * sumRight) / right;
      }
      if (error < leastError) {
        leastError = error;
        cut = k;
      }
    }
    boxes.splice(worst, 1, box(start, start + cut), box(start + cut, end));
  }

  return boxes.map(({ start, end }) => {
    let count = 0;
    const sum = [0, 0, 0];
    for (let i = start; i < end; i++) {
      const weight = weights[order[i]];
      count += weight;
      for (let channel = 0; channel < 3; channel++) {
        sum[channel] += weight * channelOf(colours[order[i]], channel);
      }
    }
    const [r, g, b] = sum.map((value) => Math.round(value / count));
    return (r << 16) | (g << 8) | b;
  });
}

/**
 * GIF's variable-width LZW over a frame's colour indices, packed least
 * significant bit first.
 *
 * The decoder adds an entry to its dictionary with each code it reads after
 * the first, one entry behind the encoder, and widens its codes once the
 * dictionary fills the current width. So the encoder widens after a code once
 * the entries it holds, before adding the next, fill that width — after the
 * last code too: it adds nothing here, but the decoder still adds the entry it
 * owed, and reads the end code at the width that leaves it. When the
 * dictionary is full a clear code starts both over.
 */
function lzw(indices: Uint8Array, minCodeSize: number): Uint8Array {
  const clear = 1 << minCodeSize;
  const end = clear + 1;
  const out = new ByteWriter();
  let bits = 0;
  let bitCount = 0;
  let codeSize = minCodeSize + 1;
  let next = end + 1;
  const dictionary = new Map<number, number>();

  const emit = (code: number): void => {
    bits |= code << bitCount;
    bitCount += codeSize;
    while (bitCount >= 8) {
      out.bytes(bits & 0xff);
      bits >>>= 8;
      bitCount -= 8;
    }
  };
  const emitData = (code: number): void => {
    emit(code);
    if (next >= 1 << codeSize && codeSize < 12) codeSize++;
  };

  emit(clear);
  let prefix = indices[0];
  for (let i = 1; i < indices.length; i++) {
    const index = indices[i];
    const key = (prefix << 8) | index;
    const known = dictionary.get(key);
    if (known !== undefined) {
      prefix = known;
      continue;
    }
    emitData(prefix);
    if (next === MAX_CODES) {
      emit(clear);
      dictionary.clear();
      codeSize = minCodeSize + 1;
      next = end + 1;
    } else {
      dictionary.set(key, next++);
    }
    prefix = index;
  }
  emitData(prefix);
  emit(end);
  if (bitCount > 0) out.bytes(bits & 0xff);
  return out.done();
}

/** Bytes appended to a buffer that grows as it fills. */
class ByteWriter {
  private buffer = new Uint8Array(1 << 16);
  private length = 0;

  bytes(...values: number[]): void {
    this.reserve(values.length);
    for (const value of values) this.buffer[this.length++] = value;
  }

  array(values: Uint8Array): void {
    this.reserve(values.length);
    this.buffer.set(values, this.length);
    this.length += values.length;
  }

  /** Little-endian, as every number in a GIF is. */
  u16(value: number): void {
    this.bytes(value & 0xff, (value >> 8) & 0xff);
  }

  ascii(text: string): void {
    this.bytes(...Array.from(text, (char) => char.charCodeAt(0)));
  }

  done(): Uint8Array {
    return this.buffer.slice(0, this.length);
  }

  private reserve(extra: number): void {
    if (this.length + extra <= this.buffer.length) return;
    let size = this.buffer.length * 2;
    while (size < this.length + extra) size *= 2;
    const grown = new Uint8Array(size);
    grown.set(this.buffer.subarray(0, this.length));
    this.buffer = grown;
  }
}
