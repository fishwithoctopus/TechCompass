// Mechanical migration: keep exact versions and integrity, only replace private registry URLs.
const fs = require('node:fs');
const file = require('node:path').join(__dirname, '..', 'package-lock.json');
const lock = JSON.parse(fs.readFileSync(file, 'utf8'));
let count = 0;
for (const [key, pkg] of Object.entries(lock.packages)) {
  if (!pkg.resolved?.includes('artifactory.devops.xiaohongshu.com') && !(pkg.name && pkg.resolved?.includes('registry.npmjs.org'))) continue;
  const name = pkg.name || key.split('node_modules/').at(-1);
  pkg.resolved = `https://registry.npmjs.org/${name}/-/${name.split('/').at(-1)}-${pkg.version}.tgz`;
  count++;
}
fs.writeFileSync(file, JSON.stringify(lock, null, 2) + '\n');
console.log(`Migrated ${count} resolved URLs; versions and integrity retained.`);
