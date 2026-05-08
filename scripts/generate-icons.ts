/**
 * Generate PWA icons for the dashboard.
 *
 * "SB" centered, white, on the dashboard accent gradient (purple → blue).
 * Outputs into ./public/icons/. Run via `pnpm icons`.
 *
 * Sizes:
 * - 180x180   apple-touch-icon (iOS Home Screen)
 * - 192x192   PWA manifest (Android)
 * - 512x512   PWA manifest (Android, splash)
 * - 512x512   maskable variant (~10% safe padding so Android can crop it)
 */
import sharp from "sharp";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const OUT_DIR = resolve("./public/icons");

// Pulled directly from APP_HTML's --accent / --accent-2 CSS vars.
const ACCENT = "#a78bfa";
const ACCENT_2 = "#60a5fa";
const BG_DARK = "#0a0a0c";

type Spec = {
  file: string;
  size: number;
  /** 0 = no padding (edge-to-edge), 0.1 = 10% safe area on each side. */
  padding: number;
  /** Square gradient background, or padded with dark bg outside the safe area. */
  maskable: boolean;
};

const SPECS: Spec[] = [
  { file: "icon-180.png", size: 180, padding: 0, maskable: false },
  { file: "icon-192.png", size: 192, padding: 0, maskable: false },
  { file: "icon-512.png", size: 512, padding: 0, maskable: false },
  { file: "icon-512-maskable.png", size: 512, padding: 0.1, maskable: true },
];

function buildSvg(size: number, padding: number, maskable: boolean): string {
  const inner = Math.round(size * (1 - padding * 2));
  const offset = Math.round((size - inner) / 2);
  const radius = Math.round(inner * 0.22);
  const fontSize = Math.round(inner * 0.5);
  // Outer fill: dark for maskable safe area, transparent otherwise.
  const outerFill = maskable ? BG_DARK : "transparent";
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
  <defs>
    <linearGradient id="g" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="${ACCENT}"/>
      <stop offset="100%" stop-color="${ACCENT_2}"/>
    </linearGradient>
  </defs>
  <rect width="${size}" height="${size}" fill="${outerFill}"/>
  <rect x="${offset}" y="${offset}" width="${inner}" height="${inner}" rx="${radius}" ry="${radius}" fill="url(#g)"/>
  <text x="${size / 2}" y="${size / 2}" text-anchor="middle" dominant-baseline="central"
        font-family="-apple-system, BlinkMacSystemFont, 'Segoe UI', Inter, system-ui, sans-serif"
        font-weight="700" font-size="${fontSize}" fill="#ffffff" letter-spacing="-2">SB</text>
</svg>`;
}

async function main() {
  await mkdir(OUT_DIR, { recursive: true });
  for (const spec of SPECS) {
    const svg = buildSvg(spec.size, spec.padding, spec.maskable);
    const out = resolve(OUT_DIR, spec.file);
    await sharp(Buffer.from(svg))
      .png({ compressionLevel: 9 })
      .toFile(out);
    // Also write the SVG alongside for easy inspection / rev-control diffing.
    await writeFile(out.replace(/\.png$/, ".svg"), svg);
    console.log(`wrote ${out}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
