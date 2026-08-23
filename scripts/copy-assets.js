import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const sourceDir = path.resolve(__dirname, '../core/src');
const destDir = path.resolve(__dirname, '../dist/core/src');

function copyPyFiles(src, dest) {
  if (!fs.existsSync(src)) return;

  if (fs.statSync(src).isDirectory()) {
    if (!fs.existsSync(dest)) {
      fs.mkdirSync(dest, { recursive: true });
    }
    const entries = fs.readdirSync(src);
    for (const entry of entries) {
      copyPyFiles(path.join(src, entry), path.join(dest, entry));
    }
  } else if (src.endsWith('.py')) {
    fs.copyFileSync(src, dest);
    console.log(`Copied asset: ${path.relative(path.resolve(__dirname, '..'), src)} -> ${path.relative(path.resolve(__dirname, '..'), dest)}`);
  }
}

console.log('Copying Python scripts to dist folder...');
copyPyFiles(sourceDir, destDir);
console.log('Asset copy complete!');
