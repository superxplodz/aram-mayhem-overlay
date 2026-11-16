// Usage: node tools/release.js 4.1.0   -> rewrites app/manifest.json with the version and file checksums.
const fs = require('fs'), path = require('path'), crypto = require('crypto');
const version = process.argv[2];
if (!/^\d+\.\d+\.\d+$/.test(version || '')) { console.error('give a version like 4.1.0'); process.exit(1); }
const dir = path.join(__dirname, '..', 'app');
const files = {};
for (const f of fs.readdirSync(dir).sort()) if (f !== 'manifest.json') files[f] = crypto.createHash('sha256').update(fs.readFileSync(path.join(dir, f))).digest('hex');
fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({ version, files }, null, 2) + '\n');
const pkgPath = path.join(__dirname, '..', 'package.json'); const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
pkg.version = version; fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n');
console.log('release', version, Object.keys(files).length, 'files');
