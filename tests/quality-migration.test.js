import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';

test('quality migration preserves legacy data, enforces permissions and runs review summary and persistent limiter in PostgreSQL', async () => {
    const db = new PGlite();
    try {
        await db.exec(`
            create role anon;
            create role authenticated;
            create role service_role;
            create table products (
                id bigint primary key, nombre text not null, "precioUSD" numeric,
                imagen text, "tipoStock" smallint check ("tipoStock" in (0,1))
            );
            insert into products values (1,'Original',20,'https://example.test/cover.jpg',0),
                (2,'Disponible',10,'Imagen no disponible',1);
        `);
        const before = (await db.query('select * from products order by id')).rows;
        const sql = await readFile(new URL('../supabase/quality-upgrade.sql', import.meta.url), 'utf8');
        await db.exec(sql);
        await db.exec(sql);
        const after = (await db.query('select id,nombre,"precioUSD",imagen,"tipoStock" from products order by id')).rows;
        assert.deepEqual(after, before);
        await db.exec('update products set "tipoStock"=2 where id=2;');
        await assert.rejects(db.exec('update products set "tipoStock"=3 where id=2;'));
        await assert.rejects(db.query('update products set imagenes=$1 where id=1', [JSON.stringify([1, 2, 3, 4, 5])]));
        await db.query(`insert into product_reviews (product_id,autor,puntuacion,comentario,consentimiento)
            values (1,'Cliente',5,'Opinion',true)`);
        assert.deepEqual((await db.query('select total::int, promedio::float from product_review_summary(1)')).rows, [{ total: 0, promedio: null }]);
        await db.exec("update product_reviews set estado='aprobada';");
        assert.deepEqual((await db.query('select total::int, promedio::float from product_review_summary(1)')).rows, [{ total: 1, promedio: 5 }]);
        await db.exec("update product_reviews set estado='oculta';");
        assert.equal((await db.query('select total::int from product_review_summary(1)')).rows[0].total, 0);
        const accepted = [];
        for (let i = 0; i < 4; i++) accepted.push((await db.query("select consume_review_limit('hashed-test-key') as accepted")).rows[0].accepted);
        assert.deepEqual(accepted, [true, true, true, false]);
        await db.exec("update review_limits set expires_at=now()-interval '1 second';");
        assert.equal((await db.query("select consume_review_limit('hashed-test-key') as accepted")).rows[0].accepted, true);
        assert.equal((await db.query('select count(*)::int as total from product_reviews')).rows[0].total, 1);
        for (const role of ['anon', 'authenticated']) {
            for (const table of ['store_info', 'product_reviews', 'review_limits']) {
                assert.equal((await db.query('select has_table_privilege($1,$2,\'SELECT\') as allowed', [role, table])).rows[0].allowed, false);
            }
            assert.equal((await db.query('select has_function_privilege($1,\'consume_review_limit(text)\',\'EXECUTE\') as allowed', [role])).rows[0].allowed, false);
        }
        assert.ok((await db.query("select relrowsecurity from pg_class where relname in ('store_info','product_reviews','review_limits')")).rows.every(row => row.relrowsecurity));
    } finally { await db.close(); }
});
