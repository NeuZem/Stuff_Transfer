/**
 * The app's logo as a Windows .ico file, drawn in code: a blue rounded
 * square with a white down arrow, matching the PC page.
 *
 * Generated rather than shipped as a binary so the package stays text-only
 * and the icon can never drift from the page's design.
 */

const SIZES = [16, 24, 32, 48, 64, 128];
const BLUE = { r: 0x3b, g: 0x6c, b: 0xf0 };
const SAMPLES = 4; // 4x4 supersampling per pixel, for smooth edges

/** Build a multi-size .ico. Windows picks the right size for each view. */
export function makeIco(): Buffer {
  const images = SIZES.map(renderBmpEntry);

  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type: icon
  header.writeUInt16LE(images.length, 4);

  const dir = Buffer.alloc(16 * images.length);
  let offset = header.length + dir.length;
  images.forEach((img, i) => {
    const size = SIZES[i]!;
    const at = i * 16;
    dir.writeUInt8(size >= 256 ? 0 : size, at); // width
    dir.writeUInt8(size >= 256 ? 0 : size, at + 1); // height
    dir.writeUInt8(0, at + 2); // palette colours: none
    dir.writeUInt8(0, at + 3); // reserved
    dir.writeUInt16LE(1, at + 4); // colour planes
    dir.writeUInt16LE(32, at + 6); // bits per pixel
    dir.writeUInt32LE(img.length, at + 8);
    dir.writeUInt32LE(offset, at + 12);
    offset += img.length;
  });

  return Buffer.concat([header, dir, ...images]);
}

/** One icon image: a 32-bit BMP (header, BGRA pixels bottom-up, AND mask). */
function renderBmpEntry(size: number): Buffer {
  const header = Buffer.alloc(40);
  const maskRow = Math.ceil(size / 32) * 4;
  const pixelBytes = size * size * 4;
  header.writeUInt32LE(40, 0); // header size
  header.writeInt32LE(size, 4); // width
  header.writeInt32LE(size * 2, 8); // height: doubled, the ICO convention (image + mask)
  header.writeUInt16LE(1, 12); // planes
  header.writeUInt16LE(32, 14); // bits per pixel
  header.writeUInt32LE(0, 16); // no compression
  header.writeUInt32LE(pixelBytes + maskRow * size, 20);

  const pixels = Buffer.alloc(pixelBytes);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const { r, g, b, a } = shade(x, y, size);
      // BMP rows run bottom to top.
      const at = ((size - 1 - y) * size + x) * 4;
      pixels[at] = b;
      pixels[at + 1] = g;
      pixels[at + 2] = r;
      pixels[at + 3] = a;
    }
  }

  // All zeros: transparency comes from the alpha channel instead.
  const mask = Buffer.alloc(maskRow * size);
  return Buffer.concat([header, pixels, mask]);
}

/** Colour of one pixel, averaged over a grid of sub-samples. */
function shade(px: number, py: number, size: number) {
  let square = 0;
  let arrow = 0;
  for (let sy = 0; sy < SAMPLES; sy++) {
    for (let sx = 0; sx < SAMPLES; sx++) {
      // Sample point in 0..1 space.
      const x = (px + (sx + 0.5) / SAMPLES) / size;
      const y = (py + (sy + 0.5) / SAMPLES) / size;
      if (inRoundedSquare(x, y)) {
        square++;
        if (inArrow(x, y, size)) arrow++;
      }
    }
  }
  const n = SAMPLES * SAMPLES;
  const cover = square / n;
  const white = square ? arrow / square : 0;
  return {
    r: Math.round(BLUE.r + (255 - BLUE.r) * white),
    g: Math.round(BLUE.g + (255 - BLUE.g) * white),
    b: Math.round(BLUE.b + (255 - BLUE.b) * white),
    a: Math.round(255 * cover),
  };
}

function inRoundedSquare(x: number, y: number): boolean {
  const inset = 0.04;
  const radius = 0.22;
  const lo = inset + radius;
  const hi = 1 - inset - radius;
  const cx = Math.min(Math.max(x, lo), hi);
  const cy = Math.min(Math.max(y, lo), hi);
  return (x - cx) ** 2 + (y - cy) ** 2 <= radius ** 2;
}

/** A down arrow: a stem and a chevron, drawn as thick rounded strokes. */
function inArrow(x: number, y: number, size: number): boolean {
  // Tiny icons need proportionally bolder strokes to stay readable.
  const stroke = size <= 24 ? 0.075 : 0.058;
  return (
    nearSegment(x, y, 0.5, 0.24, 0.5, 0.7, stroke) || // stem
    nearSegment(x, y, 0.3, 0.52, 0.5, 0.72, stroke) || // left of chevron
    nearSegment(x, y, 0.7, 0.52, 0.5, 0.72, stroke) // right of chevron
  );
}

function nearSegment(x: number, y: number, x1: number, y1: number, x2: number, y2: number, r: number): boolean {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const t = Math.max(0, Math.min(1, ((x - x1) * dx + (y - y1) * dy) / (dx * dx + dy * dy)));
  const ex = x - (x1 + t * dx);
  const ey = y - (y1 + t * dy);
  return ex * ex + ey * ey <= r * r;
}
