import { inflateSync } from 'node:zlib';

/** An image as pixels: row-major RGBA, four bytes a pixel. */
export interface RgbaImage {
  width: number;
  height: number;
  rgba: Uint8Array;
}

/** The eight bytes every PNG opens with. */
const SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10];

/**
 * The pixels of a PNG as Chromium writes a screenshot: eight bits a channel,
 * RGB or RGBA, not interlaced.
 *
 * The animation the generator writes is built from screenshots, and Playwright
 * hands them over as PNG only. Node already carries the one hard part of
 * reading one — inflate — so what is left is the chunk layout and the five
 * row filters, and every shape outside what a screenshot uses is refused by
 * name rather than misread. Reading them here, rather than by drawing each one
 * into a canvas of the page being photographed, keeps the pixels free of
 * whatever colour handling the browser applies, and the page free of code it
 * does not run in the product.
 */
export function readPng(png: Uint8Array): RgbaImage {
  if (png.length < SIGNATURE.length || SIGNATURE.some((byte, i) => png[i] !== byte)) {
    throw new Error('not a PNG: the signature is missing');
  }
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
  let width = 0;
  let height = 0;
  let channels = 0;
  const compressed: Uint8Array[] = [];

  let offset = SIGNATURE.length;
  while (offset + 8 <= png.length) {
    const length = view.getUint32(offset);
    const type = String.fromCharCode(...png.subarray(offset + 4, offset + 8));
    const data = png.subarray(offset + 8, offset + 8 + length);
    if (type === 'IHDR') {
      width = view.getUint32(offset + 8);
      height = view.getUint32(offset + 12);
      const [depth, colourType, , , interlace] = data.subarray(8, 13);
      if (depth !== 8 || (colourType !== 2 && colourType !== 6) || interlace !== 0) {
        throw new Error(
          `PNG shape not read here: bit depth ${depth}, colour type ${colourType}, interlace ${interlace}`,
        );
      }
      channels = colourType === 6 ? 4 : 3;
    } else if (type === 'IDAT') {
      compressed.push(data);
    } else if (type === 'IEND') {
      break;
    }
    // Length, type, data, CRC.
    offset += 12 + length;
  }
  if (channels === 0) throw new Error('PNG without a header chunk');

  const filtered = inflateSync(Buffer.concat(compressed));
  const stride = width * channels;
  if (filtered.length !== height * (stride + 1)) {
    throw new Error(
      `PNG data holds ${filtered.length} bytes, its ${width}x${height} header says otherwise`,
    );
  }

  const pixels = unfilter(filtered, height, stride, channels);
  if (channels === 4) return { width, height, rgba: pixels };

  const rgba = new Uint8Array(width * height * 4);
  for (let source = 0, target = 0; source < pixels.length; source += 3, target += 4) {
    rgba[target] = pixels[source];
    rgba[target + 1] = pixels[source + 1];
    rgba[target + 2] = pixels[source + 2];
    rgba[target + 3] = 255;
  }
  return { width, height, rgba };
}

/**
 * Undo the filter each row starts with. Each byte was written as its
 * difference from a prediction made of the bytes to its left (`a`), above
 * (`b`) and above-left (`c`), one pixel back, so rows are rebuilt top down.
 */
function unfilter(
  filtered: Uint8Array,
  height: number,
  stride: number,
  bytesPerPixel: number,
): Uint8Array {
  const pixels = new Uint8Array(height * stride);
  for (let y = 0; y < height; y++) {
    const filter = filtered[y * (stride + 1)];
    const source = y * (stride + 1) + 1;
    const row = y * stride;
    for (let x = 0; x < stride; x++) {
      const a = x >= bytesPerPixel ? pixels[row + x - bytesPerPixel] : 0;
      const b = y > 0 ? pixels[row - stride + x] : 0;
      const c = x >= bytesPerPixel && y > 0 ? pixels[row - stride + x - bytesPerPixel] : 0;
      let prediction: number;
      switch (filter) {
        case 0:
          prediction = 0;
          break;
        case 1:
          prediction = a;
          break;
        case 2:
          prediction = b;
          break;
        case 3:
          prediction = (a + b) >> 1;
          break;
        case 4:
          prediction = paeth(a, b, c);
          break;
        default:
          throw new Error(`PNG row ${y} has filter ${filter}, which does not exist`);
      }
      pixels[row + x] = (filtered[source + x] + prediction) & 0xff;
    }
  }
  return pixels;
}

/** Whichever of left, above and above-left is nearest to left + above - above-left. */
function paeth(a: number, b: number, c: number): number {
  const estimate = a + b - c;
  const fromA = Math.abs(estimate - a);
  const fromB = Math.abs(estimate - b);
  const fromC = Math.abs(estimate - c);
  if (fromA <= fromB && fromA <= fromC) return a;
  return fromB <= fromC ? b : c;
}
