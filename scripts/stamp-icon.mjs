// Stamp only a newly packaged executable, never a running user installation.
import fs from 'node:fs';
import path from 'node:path';
import * as PE from 'pe-library';
import * as ResEdit from 'resedit';
const file = path.resolve(process.argv[2]);
const icon = ResEdit.Data.IconFile.from(fs.readFileSync(new URL('../build/icon.ico', import.meta.url)));
const exe = PE.NtExecutable.from(fs.readFileSync(file), { ignoreCert: true });
const resources = PE.NtExecutableResource.from(exe);
const groups = resources.entries.filter(e => e.type === 14).map(e => ({ id: e.id, lang: e.lang }));
for (const group of groups.length ? groups : [{ id: 101, lang: 1033 }]) {
  ResEdit.Resource.IconGroupEntry.replaceIconsForResource(resources.entries, group.id, group.lang, icon.icons.map(i => i.data));
}
resources.outputResource(exe);
fs.writeFileSync(file, Buffer.from(exe.generate()));
const verified = PE.NtExecutableResource.from(PE.NtExecutable.from(fs.readFileSync(file)));
if (!verified.entries.some(e => e.type === 14)) throw new Error('Missing icon group');
console.log('Application icon resources updated (unsigned build).');
