const fs = require('node:fs');
const path = require('node:path');
const archive = process.argv[2];
const dest = path.resolve(process.argv[3]);
const buf = fs.readFileSync(archive);
const headerSize = buf.readUInt32LE(4);
const header = JSON.parse(buf.subarray(16, 16 + buf.readUInt32LE(12)));
let count = 0;
function walk(node, relative = '') {
  for (const [name, entry] of Object.entries(node.files || {})) {
    const rel = path.join(relative, name);
    if (entry.files) { walk(entry, rel); continue; }
    if (!rel.startsWith('node_modules' + path.sep) || entry.link) continue;
    const target = path.resolve(dest, rel);
    if (!target.startsWith(dest + path.sep)) throw new Error('Invalid archive path');
    fs.mkdirSync(path.dirname(target), {recursive:true});
    if (entry.unpacked) fs.copyFileSync(archive + '.unpacked/' + rel, target);
    else fs.writeFileSync(target, buf.subarray(8 + headerSize + Number(entry.offset), 8 + headerSize + Number(entry.offset) + entry.size));
    count++;
  }
}
walk(header);
console.log({files: count});
