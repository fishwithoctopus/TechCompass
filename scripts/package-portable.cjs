// Reuse the shipped Electron runtime; rebuild ASAR from original production dependencies + current source.
const fs=require('node:fs');
const path=require('node:path');
const crypto=require('node:crypto');
const root=path.resolve(__dirname,'..');
const original=path.resolve(process.argv[2]);
const out=path.resolve(process.argv[3]);
const asarOnly=process.argv.includes('--asar-only');
if(asarOnly) {
 if(!fs.existsSync(path.join(out,'TechCompass.exe'))) throw new Error('ASAR refresh needs an existing generated TechCompass package');
} else {
 if(fs.existsSync(out)) throw new Error('Choose a new output directory; existing output is never overwritten');
 fs.cpSync(original,out,{recursive:true});
}
const buf=fs.readFileSync(path.join(original,'resources','app.asar'));
const oldHeader=JSON.parse(buf.subarray(16,16+buf.readUInt32LE(12)));
const oldStart=8+buf.readUInt32LE(4);
const entries=new Map();
function readArchive(node,rel='') {
 for(const [name,item] of Object.entries(node.files||{})) {
  const file=rel ? rel+'/'+name : name;
  if(item.files) readArchive(item,file);
  else if(file.startsWith('node_modules/')) {
   if(item.link || item.unpacked) throw new Error('Unsupported original entry '+file);
   entries.set(file,buf.subarray(oldStart+Number(item.offset),oldStart+Number(item.offset)+item.size));
  }
 }
}
readArchive(oldHeader);
function addSource(rel) {
 const file=path.join(root,rel);
 if(!fs.existsSync(file)) return;
 if(fs.statSync(file).isDirectory()) for(const name of fs.readdirSync(file)) addSource(rel+'/'+name);
 else entries.set(rel,fs.readFileSync(file));
}
for(const rel of ['card','lib','ui','mcp','bin','build','package.json']) addSource(rel);
const header={files:{}};let offset=0;const chunks=[];
for(const [name,data] of [...entries].sort((a,b)=>a[0].localeCompare(b[0]))) {
 const parts=name.split('/');let node=header;
 for(const part of parts.slice(0,-1)) {node.files[part]??={files:{}};node=node.files[part];}
 node.files[parts.at(-1)]={size:data.length,offset:String(offset)};
 chunks.push(data);offset+=data.length;
}
const json=Buffer.from(JSON.stringify(header));
const padded=Math.ceil(json.length/4)*4;
const prefix=Buffer.alloc(16+padded);
prefix.writeUInt32LE(4,0);prefix.writeUInt32LE(8+padded,4);prefix.writeUInt32LE(4+padded,8);prefix.writeUInt32LE(json.length,12);json.copy(prefix,16);
const archive=Buffer.concat([prefix,...chunks]);
const target=path.join(out,'resources','app.asar');fs.writeFileSync(target,archive);
// Byte-for-byte verification of every source/dependency entry after packing.
const verifyHeader=JSON.parse(archive.subarray(16,16+archive.readUInt32LE(12)));
for(const [name,data] of entries) {
 let e=verifyHeader;for(const part of name.split('/')) e=e.files[part];
 const start=8+archive.readUInt32LE(4)+Number(e.offset);
 if(!archive.subarray(start,start+e.size).equals(data)) throw new Error('Verification failed: '+name);
}
const stamp = require('node:child_process').spawnSync(process.execPath, [path.join(root, 'scripts', 'stamp-icon.mjs'), path.join(out, 'TechCompass.exe')], { encoding: 'utf8', windowsHide: true });
if (stamp.status !== 0) throw new Error('Icon stamping failed: '+stamp.stderr);
console.log(JSON.stringify({out,files:entries.size,sha256:crypto.createHash('sha256').update(archive).digest('hex'),iconStamped:true}));
