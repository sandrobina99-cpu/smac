import fs from 'node:fs';
import path from 'node:path';

const outDir = path.resolve(process.cwd(), 'dist-electron');
if (fs.existsSync(outDir)) {
  for (const file of fs.readdirSync(outDir)) {
    if (file.endsWith('.js')) {
      const from = path.join(outDir, file);
      const to = path.join(outDir, file.replace(/\.js$/, '.cjs'));
      fs.renameSync(from, to);
    }
  }
}
