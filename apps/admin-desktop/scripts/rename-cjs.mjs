import fs from 'node:fs';
import path from 'node:path';

const outDir = path.resolve(process.cwd(), 'dist-electron');
if (fs.existsSync(outDir)) {
  const renamed = new Set();
  for (const file of fs.readdirSync(outDir)) {
    if (file.endsWith('.js')) {
      const from = path.join(outDir, file);
      const base = file.slice(0, -3);
      const to = path.join(outDir, `${base}.cjs`);
      fs.renameSync(from, to);
      renamed.add(base);
    } else if (file.endsWith('.cjs')) {
      renamed.add(file.slice(0, -4));
    }
  }

  // Rewrite relative CommonJS require("./foo") -> require("./foo.cjs")
  // because Node/Electron never auto-resolves .cjs extensionless imports.
  for (const file of fs.readdirSync(outDir)) {
    if (!file.endsWith('.cjs')) continue;
    const fullPath = path.join(outDir, file);
    const src = fs.readFileSync(fullPath, 'utf8');
    const updated = src.replace(
      /require\(\s*(['"])(\.\/[^'"\r\n]+)\1\s*\)/g,
      (match, quote, spec) => {
        if (/\.(cjs|mjs|js|json|node)$/i.test(spec)) return match;
        const base = spec.slice(2);
        if (renamed.has(base)) {
          return `require(${quote}${spec}.cjs${quote})`;
        }
        return match;
      },
    );
    if (updated !== src) {
      fs.writeFileSync(fullPath, updated, 'utf8');
    }
  }
}
