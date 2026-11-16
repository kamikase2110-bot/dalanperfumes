import { readFile, writeFile } from 'node:fs/promises';
import vm from 'node:vm';

const source = await readFile(process.argv[2] || 'index.html', 'utf8');
const script = [...source.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)]
    .map(match => match[1]).find(text => text.includes('const perfumesDB = ['));
if (!script) throw new Error('El archivo no contiene el catalogo anterior. No se modifico ningun dato.');
const boundary = script.indexOf('// === APLICAR LA F');
if (boundary < 0) throw new Error('No se encontro el limite del catalogo.');
const context = {};
vm.runInNewContext(`${script.slice(0, boundary)};this.products = perfumesDB;`, context, { timeout: 5000 });
const products = context.products.map(({ estadoTexto, ...product }) => {
    const name = product.nombre.trim().toLocaleLowerCase('es');
    return {
        ...product,
        referencia: product.referencia || null,
        categoria: name.startsWith('desodorante ') ? 'desodorante' : name.startsWith('mini ') ? 'mini' : 'perfume'
    };
});
const data = JSON.stringify(products);
if (data.includes('$dalan_seed$')) throw new Error('Delimitador SQL presente en el catalogo.');
const sql = `-- Catalogo inicial. Contiene costos privados: no publicar como archivo estatico.
begin;
insert into public.products (id, referencia, nombre, marca, "tipoStock", inspiracion, notas, imagen, "precioUSD", categoria)
select id, referencia, nombre, marca, "tipoStock", inspiracion, notas, imagen, "precioUSD", categoria
from jsonb_to_recordset($dalan_seed$${data}$dalan_seed$::jsonb)
as p(id bigint, referencia text, nombre text, marca text, "tipoStock" smallint, inspiracion text, notas text, imagen text, "precioUSD" numeric, categoria text)
on conflict (id) do nothing;
select setval(pg_get_serial_sequence('public.products', 'id'), (select max(id) from public.products));
commit;
`;
await writeFile('supabase/seed.sql', sql, { flag: 'wx' });
console.log(`Migrados ${products.length} productos; ${products.filter(p => p.categoria !== 'perfume').length} minis/desodorantes. Los IDs y costos se conservan.`);
