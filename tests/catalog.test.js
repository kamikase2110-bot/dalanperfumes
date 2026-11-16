import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { allProducts, calculatePrice, serviceHeaders, toPublic, validateProduct } from '../functions/_lib/catalog.js';
import { onRequestGet } from '../functions/api/catalog.js';
import { onRequest } from '../functions/api/admin/[[path]].js';

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });
const env = {
    SUPABASE_URL: 'https://example.supabase.co',
    SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_test',
    SUPABASE_SECRET_KEY: 'sb_secret_test',
    ADMIN_EMAILS: 'admin@example.test'
};
const product = {
    id: 507, referencia: 'iconic', nombre: 'Desodorante Club de Nuit Iconic 200ml',
    marca: 'Armaf', tipoStock: 0, inspiracion: '', notas: '', imagen: 'Imagen no disponible',
    precioUSD: 4, categoria: 'desodorante', oculto: false, version: 1
};
const confirmedAdmin = { email: 'admin@example.test', email_confirmed_at: '2026-01-01T00:00:00Z' };
const context = (path, method = 'GET', body, extraHeaders = {}) => ({
    env, params: { path: path.split('/') },
    request: new Request(`https://dalan.example/api/admin/${path}`, {
        method,
        headers: {
            Origin: 'https://dalan.example',
            Cookie: '__Host-dalan_access=test-token',
            'Content-Type': 'application/json',
            ...extraHeaders
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) })
    })
});

test('preserves current pricing by category without exposing cost or profit', () => {
    assert.equal(calculatePrice(product, 10), 140);
    assert.equal(calculatePrice({ ...product, nombre: 'Muestra 10ml', categoria: 'mini' }, 10), 140);
    assert.equal(calculatePrice({ ...product, nombre: 'Iconic 105ml', categoria: 'perfume', precioUSD: 29 }, 10), 440);
    assert.equal(calculatePrice(product, null), null);
    assert.equal(calculatePrice(product, 0), null);
    assert.equal(calculatePrice({ ...product, precioUSD: 0 }, 10), null);
    const publicProduct = toPublic(product, 10);
    assert.equal(publicProduct.precio, 140);
    for (const field of ['precioUSD', 'version', 'oculto', 'gananciaBs']) {
        assert.equal(Object.hasOwn(publicProduct, field), false);
    }
});

test('product validation rejects invalid costs, fields, visibility and unsafe image URLs', () => {
    for (const patch of [
        { precioUSD: -1 }, { precioUSD: '4' }, { precioUSD: Infinity },
        { precioUSD: 100001 }, { nombre: '' }, { nombre: 'x'.repeat(501) },
        { categoria: 'otra' }, { tipoStock: 2 }, { oculto: 'false' },
        { imagen: 'javascript:alert(1)' }, { imagen: 'http://example.test/a.jpg' },
        { imagen: 'https://user:password@example.test/a.jpg' }, { referencia: null }
    ]) assert.throws(() => validateProduct({ ...product, ...patch }), { status: 400 });
    const result = validateProduct({ ...product, referencia: ' ', imagen: '', unknown: true });
    assert.equal(result.referencia, null);
    assert.equal(result.imagen, 'Imagen no disponible');
    assert.equal(Object.hasOwn(result, 'unknown'), false);
    assert.equal(Object.hasOwn(result, 'id'), false);
});

test('catalog pagination reads beyond the first database page', async () => {
    let calls = 0;
    globalThis.fetch = async url => {
        assert.match(url, /oculto=eq.false/);
        calls++;
        if (calls === 1) {
            assert.match(url, /offset=0/);
            return Response.json(Array.from({ length: 500 }, (_, id) => ({ ...product, id: id + 1 })));
        }
        assert.match(url, /offset=500/);
        return Response.json([{ ...product, id: 501 }]);
    };
    const products = await allProducts(env);
    assert.equal(products.length, 501);
});

test('public endpoint only returns public fields and explicit warning if rate is unavailable', async () => {
    globalThis.fetch = async url => url.includes('/rest/')
        ? Response.json([product])
        : new Response('Unavailable', { status: 503 });
    const response = await onRequestGet({ env });
    const data = await response.json();
    assert.equal(response.status, 200);
    assert.equal(data.products[0].precio, null);
    assert.equal(data.products[0].precioUSD, undefined);
    assert.ok(data.warning);
    assert.equal(response.headers.get('Cache-Control'), 'no-store');
});

test('public endpoint reports database failure instead of returning an empty success', async () => {
    globalThis.fetch = async () => new Response('Unavailable', { status: 503 });
    const response = await onRequestGet({ env });
    assert.equal(response.status, 502);
    assert.ok((await response.json()).error);
});

test('unauthenticated or non-admin users cannot read or modify catalog', async () => {
    globalThis.fetch = async () => { throw new Error('Must not contact database'); };
    assert.equal((await onRequest(context('products', 'GET', undefined, { Cookie: '' }))).status, 401);
    for (const user of [
        { email: 'other@example.test', email_confirmed_at: '2026-01-01' },
        { email: 'admin@example.test' }
    ]) {
        globalThis.fetch = async url => {
            assert.match(url, /auth\/v1\/user$/);
            return Response.json(user);
        };
        assert.equal((await onRequest(context('products', 'POST', product))).status, 403);
    }
});

test('cross-origin mutation is denied before authentication', async () => {
    globalThis.fetch = async () => { throw new Error('Must not contact auth'); };
    const response = await onRequest(context('products', 'POST', product, { Origin: 'https://other.example' }));
    assert.equal(response.status, 403);
});

test('saving uses validated fields and optimistic concurrency; conflicting edits are rejected', async () => {
    let saved = false;
    globalThis.fetch = async (url, options) => {
        if (url.endsWith('/auth/v1/user')) return Response.json(confirmedAdmin);
        assert.match(url, /id=eq.507&version=eq.1/);
        assert.equal(options.method, 'PATCH');
        const body = JSON.parse(options.body);
        assert.equal(body.version, 2);
        assert.equal(body.precioUSD, 4);
        assert.equal(body.id, undefined);
        assert.equal(body.untrusted, undefined);
        if (saved) return Response.json([]);
        saved = true;
        return Response.json([{ ...body, id: 507 }]);
    };
    const first = await onRequest(context('products', 'PUT', { ...product, untrusted: 'ignored' }));
    assert.equal(first.status, 200);
    assert.equal((await first.json()).product.version, 2);
    const second = await onRequest(context('products', 'PUT', product));
    assert.equal(second.status, 409);
});

test('new product is persisted with database-assigned ID and can be hidden', async () => {
    globalThis.fetch = async (url, options) => {
        if (url.endsWith('/auth/v1/user')) return Response.json(confirmedAdmin);
        assert.equal(options.method, 'POST');
        const body = JSON.parse(options.body);
        assert.equal(body.oculto, true);
        assert.equal(body.id, undefined);
        return Response.json([{ ...body, id: 670, version: 1 }]);
    };
    const response = await onRequest(context('products', 'POST', { ...product, oculto: true }));
    assert.equal(response.status, 201);
    assert.equal((await response.json()).product.id, 670);
});

test('login stores tokens only in secure HttpOnly cookies and enforces admin allowlist', async () => {
    globalThis.fetch = async url => url.includes('/token?')
        ? Response.json({ access_token: 'access-token', refresh_token: 'refresh-token', expires_in: 3600 })
        : Response.json(confirmedAdmin);
    const response = await onRequest(context('session', 'POST', { email: 'admin@example.test', password: 'test-password' }));
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { email: 'admin@example.test' });
    const cookie = response.headers.get('Set-Cookie');
    assert.match(cookie, /__Host-dalan_access=access-token/);
    assert.match(cookie, /__Host-dalan_refresh=refresh-token/);
    assert.match(cookie, /HttpOnly; Secure; SameSite=Strict; Path=\//);
});

test('image upload rejects SVG, excessive size and invalid signatures before storage', async () => {
    globalThis.fetch = async url => {
        assert.match(url, /auth\/v1\/user$/);
        return Response.json(confirmedAdmin);
    };
    for (const [type, bytes, expected] of [
        ['image/svg+xml', '<svg/>', 400],
        ['image/png', 'not an image', 400],
        ['image/png', new Uint8Array(4 * 1024 * 1024 + 1), 413]
    ]) {
        const ctx = context('image', 'POST');
        ctx.request = new Request(ctx.request.url, {
            method: 'POST', headers: { Origin: 'https://dalan.example', Cookie: '__Host-dalan_access=test-token', 'Content-Type': type }, body: bytes
        });
        assert.equal((await onRequest(ctx)).status, expected);
    }
});

test('valid photo upload writes only to the configured public image bucket', async () => {
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6ZQAAAABJRU5ErkJggg==', 'base64');
    let stored = false;
    globalThis.fetch = async (url, options) => {
        if (url.endsWith('/auth/v1/user')) return Response.json(confirmedAdmin);
        assert.match(url, /^https:\/\/example\.supabase\.co\/storage\/v1\/object\/product-images\/[a-f0-9-]+\.png$/);
        assert.equal(options.method, 'POST');
        assert.equal(options.headers.apikey, 'sb_secret_test');
        assert.equal(options.headers.Authorization, undefined);
        assert.deepEqual(Buffer.from(options.body), png);
        stored = true;
        return Response.json({ Key: 'saved' });
    };
    const ctx = context('image', 'POST');
    ctx.request = new Request(ctx.request.url, {
        method: 'POST', headers: { Origin: 'https://dalan.example', Cookie: '__Host-dalan_access=test-token', 'Content-Type': 'image/png' }, body: png
    });
    const response = await onRequest(ctx);
    assert.equal(response.status, 201);
    assert.ok(stored);
    assert.match((await response.json()).url, /^https:\/\/example\.supabase\.co\/storage\/v1\/object\/public\/product-images\//);
});

test('modern secret keys use apikey, while legacy JWT credentials retain bearer authorization', () => {
    assert.deepEqual(serviceHeaders('sb_secret_test'), { apikey: 'sb_secret_test' });
    assert.deepEqual(serviceHeaders('legacy-jwt'), { apikey: 'legacy-jwt', Authorization: 'Bearer legacy-jwt' });
});

test('oversized login body is rejected before contacting authentication', async () => {
    globalThis.fetch = async () => { throw new Error('Must not contact authentication'); };
    const response = await onRequest(context('session', 'POST', { email: 'admin@example.test', password: 'a'.repeat(21000) }));
    assert.equal(response.status, 413);
});

test('initial migration preserves the full catalog, normalized categories and original IDs', async () => {
    const sql = await readFile(new URL('../supabase/seed.sql', import.meta.url), 'utf8');
    const products = JSON.parse(sql.split('$dalan_seed$')[1]);
    assert.equal(products.length, 663);
    assert.equal(new Set(products.map(product => product.id)).size, products.length);
    assert.equal(products.filter(product => product.categoria !== 'perfume').length, 58);
    const iconic = products.find(product => product.id === 507);
    assert.equal(iconic.precioUSD, 4);
    assert.equal(iconic.categoria, 'desodorante');
    for (const item of products) {
        assert.doesNotThrow(() => validateProduct({ ...item, referencia: item.referencia || '', oculto: false }));
    }
});

test('storefront escapes editable content and renders notes, products and cart safely', async () => {
    const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');
    const scripts = [...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)].map(match => match[1]);
    scripts.forEach(script => new vm.Script(script));
    const nodes = new Map();
    const node = id => {
        if (!nodes.has(id)) nodes.set(id, { innerHTML: '', classList: { toggle() {} } });
        return nodes.get(id);
    };
    const context = { document: { getElementById: node } };
    vm.createContext(context);
    const script = scripts.find(text => text.includes('let perfumesDB'));
    vm.runInContext(script.slice(0, script.indexOf("        document.addEventListener('keydown'")), context);
    const injected = { ...toPublic(product, 10), nombre: '<img src=x onerror=alert(1)>', notas: '<script>bad()</script>', inspiracion: '"<b>unsafe</b>' };
    context.products = [injected];
    vm.runInContext('perfumesDB = products; renderProducts(perfumesDB); addToCart(507);', context);
    assert.ok(!node('products-grid').innerHTML.includes('<script>bad()'));
    assert.match(node('products-grid').innerHTML, /&lt;img src=x onerror=alert\(1\)&gt;/);
    assert.match(node('cart-body').innerHTML, /&lt;img src=x onerror=alert\(1\)&gt;/);
    assert.doesNotMatch(html, /precioUSD|gananciaBs|const perfumesDB = \[/);
});
