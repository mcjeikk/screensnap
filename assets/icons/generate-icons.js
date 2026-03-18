/**
 * Generate PNG icons from SVG using Node.js canvas.
 * Usage: node generate-icons.js
 * Requires: npm install canvas (or use sharp)
 */
const fs = require('fs');
const path = require('path');

// Read SVG
const svgPath = path.join(__dirname, 'icon.svg');
const svgContent = fs.readFileSync(svgPath, 'utf-8');

const sizes = [16, 32, 48, 128];

// Try using sharp first, fall back to canvas
async function generateWithSharp() {
  const sharp = require('sharp');
  for (const size of sizes) {
    const outPath = path.join(__dirname, `icon-${size}.png`);
    await sharp(Buffer.from(svgContent)).resize(size, size).png().toFile(outPath);
    console.log(`Generated ${outPath} (${size}x${size})`);
  }
}

async function generateWithCanvas() {
  const { createCanvas, loadImage } = require('canvas');
  const dataUrl = 'data:image/svg+xml;base64,' + Buffer.from(svgContent).toString('base64');
  const img = await loadImage(dataUrl);

  for (const size of sizes) {
    const canvas = createCanvas(size, size);
    const ctx = canvas.getContext('2d');
    ctx.drawImage(img, 0, 0, size, size);
    const buffer = canvas.toBuffer('image/png');
    const outPath = path.join(__dirname, `icon-${size}.png`);
    fs.writeFileSync(outPath, buffer);
    console.log(`Generated ${outPath} (${size}x${size})`);
  }
}

(async () => {
  try {
    await generateWithSharp();
  } catch (e) {
    try {
      await generateWithCanvas();
    } catch (e2) {
      console.error('Neither sharp nor canvas available. Trying rsvg-convert...');
      const { execSync } = require('child_process');
      for (const size of sizes) {
        const outPath = path.join(__dirname, `icon-${size}.png`);
        try {
          execSync(`rsvg-convert -w ${size} -h ${size} "${svgPath}" -o "${outPath}"`);
          console.log(`Generated ${outPath} (${size}x${size})`);
        } catch (e3) {
          console.error(`Failed for ${size}px:`, e3.message);
        }
      }
    }
  }
})();
