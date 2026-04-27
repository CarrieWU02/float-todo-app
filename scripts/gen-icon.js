/**
 * 生成 App 图标
 * 1. 写出 SVG
 * 2. 用 macOS sips 把 SVG→PNG（1024x1024）
 * 3. 用 iconutil 把 PNG 集合→ .icns
 * 4. 用 sips 生成多尺寸 PNG 再打包成 .ico（Windows）
 */
const { execSync } = require('child_process');
const fs   = require('fs');
const path = require('path');

const ROOT   = path.join(__dirname, '..');
const ASSETS = path.join(ROOT, 'src/assets');
fs.mkdirSync(ASSETS, { recursive: true });

// ── 1. 生成 SVG ───────────────────────────────────────────────────────────────
const SIZE = 1024;
const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg width="${SIZE}" height="${SIZE}" viewBox="0 0 ${SIZE} ${SIZE}" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="#3a3a42"/>
      <stop offset="100%" stop-color="#1c1c22"/>
    </linearGradient>
  </defs>
  <rect x="60" y="60" width="${SIZE-120}" height="${SIZE-120}" rx="200" ry="200" fill="url(#bg)"/>
  <circle cx="512" cy="280" r="52" fill="#f9a8c9" opacity="0.9"/>
  <polyline points="230,510 420,700 794,320"
            fill="none" stroke="white" stroke-width="88"
            stroke-linecap="round" stroke-linejoin="round"/>
</svg>`;

const svgPath = path.join(ASSETS, 'icon.svg');
fs.writeFileSync(svgPath, svg, 'utf-8');
console.log('✓ SVG written');

// ── 2. SVG → PNG 1024 via sips（macOS 自带）─────────────────────────────────
const png1024 = path.join(ASSETS, 'icon_1024.png');
execSync(`sips -s format png "${svgPath}" --out "${png1024}" --resampleHeightWidth 1024 1024`, { stdio: 'pipe' });
console.log('✓ PNG 1024x1024 generated');

// ── 3. 生成 .icns（macOS）────────────────────────────────────────────────────
const iconsetDir = path.join(ASSETS, 'icon.iconset');
fs.mkdirSync(iconsetDir, { recursive: true });

const icnsSizes = [16, 32, 64, 128, 256, 512, 1024];
for (const s of icnsSizes) {
  const out = path.join(iconsetDir, `icon_${s}x${s}.png`);
  execSync(`sips -s format png "${png1024}" --out "${out}" --resampleHeightWidth ${s} ${s}`, { stdio: 'pipe' });
  // @2x
  if (s <= 512) {
    const s2 = s * 2;
    const out2x = path.join(iconsetDir, `icon_${s}x${s}@2x.png`);
    execSync(`sips -s format png "${png1024}" --out "${out2x}" --resampleHeightWidth ${s2} ${s2}`, { stdio: 'pipe' });
  }
}
const icnsPath = path.join(ASSETS, 'icon.icns');
execSync(`iconutil -c icns "${iconsetDir}" -o "${icnsPath}"`, { stdio: 'pipe' });
console.log('✓ icon.icns generated:', icnsPath);

// ── 4. 生成 .ico（Windows）───────────────────────────────────────────────────
// ICO = 多尺寸 PNG 拼接的二进制格式，手动写
const icoSizes = [16, 32, 48, 64, 128, 256];
const pngBuffers = [];
for (const s of icoSizes) {
  const tmp = path.join(ASSETS, `_ico_${s}.png`);
  execSync(`sips -s format png "${png1024}" --out "${tmp}" --resampleHeightWidth ${s} ${s}`, { stdio: 'pipe' });
  pngBuffers.push({ size: s, buf: fs.readFileSync(tmp) });
  fs.unlinkSync(tmp);
}

// 写 ICO 文件头
const count  = pngBuffers.length;
const headerSize = 6 + count * 16;
let offset = headerSize;
const header = Buffer.alloc(headerSize);
header.writeUInt16LE(0, 0);      // reserved
header.writeUInt16LE(1, 2);      // type = ICO
header.writeUInt16LE(count, 4);  // image count
pngBuffers.forEach(({ size, buf }, i) => {
  const base = 6 + i * 16;
  header.writeUInt8(size >= 256 ? 0 : size, base);      // width
  header.writeUInt8(size >= 256 ? 0 : size, base + 1);  // height
  header.writeUInt8(0, base + 2);   // color count
  header.writeUInt8(0, base + 3);   // reserved
  header.writeUInt16LE(1, base + 4); // planes
  header.writeUInt16LE(32, base + 6); // bit count
  header.writeUInt32LE(buf.length, base + 8);  // size
  header.writeUInt32LE(offset, base + 12);     // offset
  offset += buf.length;
});
const icoPath = path.join(ASSETS, 'icon.ico');
fs.writeFileSync(icoPath, Buffer.concat([header, ...pngBuffers.map(x => x.buf)]));
console.log('✓ icon.ico generated:', icoPath);

// 也保留一份 512 PNG 用于 Linux/tray
const png512 = path.join(ASSETS, 'icon_512.png');
execSync(`sips -s format png "${png1024}" --out "${png512}" --resampleHeightWidth 512 512`, { stdio: 'pipe' });

// 生成 tray 图标（16x16 PNG）
const trayPath = path.join(ASSETS, 'tray-icon.png');
execSync(`sips -s format png "${png1024}" --out "${trayPath}" --resampleHeightWidth 32 32`, { stdio: 'pipe' });
console.log('✓ tray-icon.png generated');

// 清理 iconset 临时目录
fs.rmSync(iconsetDir, { recursive: true, force: true });
console.log('\n🎉 All icons generated in', ASSETS);
