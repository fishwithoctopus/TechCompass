import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.resolve(process.argv[2] || path.join(root, 'dist', 'submission'));
fs.mkdirSync(out, { recursive: true });
const read = p => fs.readFileSync(path.join(root, p), 'utf8');
let html = read('site/index.html');
html = html.replace('<link rel="stylesheet" href="assets/style.css">', () => '<style>'+read('site/assets/style.css')+'</style>');
html = html.replace('<script src="assets/demo.js"></script>', () => '<script>'+read('site/assets/demo.js')+'</script>');
html = html.replace(/(src|href)="(assets\/[^\"]+\.svg)"/g, (_, attr, file) => {
  const source = file.endsWith('/compass.svg') ? 'ui/brand.svg' : 'site/'+file;
  return attr+'="data:image/svg+xml;base64,'+Buffer.from(read(source)).toString('base64')+'"';
});
fs.writeFileSync(path.join(out, 'index.html'), html);
fs.writeFileSync(path.join(out, 'index-html.txt'), html);
console.log('Standalone landing page: '+out);
