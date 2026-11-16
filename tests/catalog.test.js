import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { pricing, productProfit } from '../pricing.js';
import { productType } from '../product-types.js';
import { availability, productImages } from '../product-info.js';
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
        { categoria: 'otra' }, { tipoStock: 3 }, { oculto: 'false' },
        { imagen: 'javascript:alert(1)' }, { imagen: 'http://example.test/a.jpg' },
        { imagen: 'https://user:password@example.test/a.jpg' }, { referencia: null }
    ]) assert.throws(() => validateProduct({ ...product, ...patch }), { status: 400 });
    const result = validateProduct({ ...product, referencia: ' ', imagen: '', unknown: true });
    assert.equal(result.referencia, null);
    assert.equal(result.imagen, 'Imagen no disponible');
    assert.equal(Object.hasOwn(result, 'unknown'), false);
    assert.equal(Object.hasOwn(result, 'id'), false);
});

test('splash and lotions use 50 Bs profit by name without changing other perfumes', () => {
    for (const nombre of [
        'SPLASH LAYAAN EDP 250ML', 'Body Splash Pure Seduction 250ml',
        'LOTION AMBER ROMANCE 250ML', 'Body lotion 250ml',
        'Locion corporal 250ml', 'Loci\u00f3n corporal 250ml', 'Lociones corporales'
    ]) {
        const item = { ...product, nombre, categoria: 'perfume' };
        assert.equal(calculatePrice(item, 10), 140, nombre);
        assert.equal(toPublic(item, 10).precio, 140, nombre);
        assert.equal(calculatePrice({ ...item, precioUSD: 0 }, 10), null);
        assert.equal(calculatePrice(item, null), null);
    }
    for (const nombre of ['Victoria EDP 100ml', 'Harlequin Cream EDP 75ml', 'Splashing EDP 100ml']) {
        assert.equal(calculatePrice({ ...product, nombre, categoria: 'perfume', notas: 'Body Splash' }, 10), 190, nombre);
    }
});

test('admin price preview follows the name rule when switching between lotion and perfume', async () => {
    const source = await readFile(new URL('../admin.js', import.meta.url), 'utf8');
    const fields = {
        nombre: { value: 'Lotion Bare Vainilla 250ml' },
        categoria: { value: 'perfume' },
        precioUSD: { value: '4' }
    };
    const output = {};
    const nodes = { 'product-form': { elements: fields }, 'price-preview': output };
    const context = vm.createContext({
        document: { getElementById: id => nodes[id] },
        productProfit, rules: pricing
    });
    vm.runInContext(source.slice(source.indexOf('const $'), source.indexOf('function edit(')), context);
    vm.runInContext('rate = 10; pricing = rules; previewPrice();', context);
    assert.match(output.textContent, /Precio en tienda: Bs 140 .* \+ 50 Bs/);
    fields.nombre.value = 'Victoria EDP 100ml';
    vm.runInContext('previewPrice();', context);
    assert.match(output.textContent, /Precio en tienda: Bs 190 .* \+ 100 Bs/);
    fields.nombre.value = 'Body Splash Pure Seduction 250ml';
    vm.runInContext('previewPrice();', context);
    assert.match(output.textContent, /Precio en tienda: Bs 140 .* \+ 50 Bs/);
    for (const categoria of ['splash', 'locion']) {
        fields.nombre.value = 'Pure Seduction 250ml';
        fields.categoria.value = categoria;
        vm.runInContext('previewPrice();', context);
        assert.match(output.textContent, /Precio en tienda: Bs 140 .* \+ 50 Bs/);
    }
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

test('admin can save splash and lotion types with 50 Bs profit without relying on the name', async () => {
    for (const categoria of ['splash', 'locion']) {
        const item = { ...product, nombre: 'Pure Seduction 250ml', categoria };
        assert.equal(validateProduct(item).categoria, categoria);
        assert.equal(calculatePrice(item, 10), 140);
        globalThis.fetch = async (url, options) => {
            if (url.endsWith('/auth/v1/user')) return Response.json(confirmedAdmin);
            assert.equal(options.method, 'PATCH');
            const body = JSON.parse(options.body);
            assert.equal(body.categoria, categoria);
            return Response.json([{ ...body, id: item.id }]);
        };
        const response = await onRequest(context('products', 'PUT', item));
        assert.equal(response.status, 200);
        assert.equal((await response.json()).product.categoria, categoria);
    }
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

async function storefront() {
    const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');
    const scripts = [...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)].map(match => match[1]);
    scripts.forEach(script => new vm.Script(script));
    const nodes = new Map();
    const node = id => {
        if (!nodes.has(id)) nodes.set(id, {
            innerHTML: '', value: '', textContent: '', open: false,
            selectedOptions: [{ textContent: 'Splash' }],
            classList: { toggle() {}, add() {}, remove() {} }, scrollIntoView() {}, focus() {},
            setAttribute() {},
            setCustomValidity(message) { this.validationMessage = message; },
            reportValidity() { return !this.validationMessage; },
            showModal() { this.open = true; }, close() { this.open = false; },
            querySelector() { return { focus() {} }; }
        });
        return nodes.get(id);
    };
    const context = {
        productType, availability, productImages,
        document: { getElementById: node, querySelectorAll: () => [], querySelector: () => null, body: { style: {} } },
        matchMedia: () => ({ matches: true })
    };
    vm.createContext(context);
    const script = scripts.find(text => text.includes('let perfumesDB'));
    vm.runInContext(script.slice(0, script.indexOf("        document.querySelectorAll('.catalog-dialog')")), context);
    vm.runInContext('obtenerTipoProducto = productType; obtenerDisponibilidad = availability; imagenesProducto = productImages;', context);
    return { html, node, context, run: source => vm.runInContext(source, context) };
}

test('storefront escapes editable content and renders notes, products and cart safely', async () => {
    const { html, node, context, run } = await storefront();
    const injected = { ...toPublic(product, 10), nombre: '<img src=x onerror=alert(1)>', notas: '<script>bad()</script>', inspiracion: '"<b>unsafe</b>' };
    context.products = [injected];
    run('perfumesDB = products; renderProducts(perfumesDB); addToCart(507); verProducto(507);');
    assert.ok(!node('products-grid').innerHTML.includes('<script>bad()'));
    assert.match(node('products-grid').innerHTML, /&lt;img src=x onerror=alert\(1\)&gt;/);
    assert.match(node('cart-body').innerHTML, /&lt;img src=x onerror=alert\(1\)&gt;/);
    assert.match(node('productDetail').innerHTML, /&lt;script&gt;bad\(\)&lt;\/script&gt;/);
    assert.doesNotMatch(node('productDetail').innerHTML, /<b>unsafe/);
    assert.doesNotMatch(html, /precioUSD|gananciaBs|const perfumesDB = \[/);
});

test('storefront combines search, legacy and explicit types, brand, stock and price order', async () => {
    const { node, context, run } = await storefront();
    context.products = [
        { ...toPublic(product, 10), id: 1, nombre: 'Body Splash Uno', categoria: 'perfume', precio: 200, tipoStock: 1 },
        { ...toPublic(product, 10), id: 2, nombre: 'Uno', categoria: 'splash', precio: 150, tipoStock: 1 },
        { ...toPublic(product, 10), id: 3, nombre: 'Uno', categoria: 'splash', precio: null, tipoStock: 1 },
        { ...toPublic(product, 10), id: 4, nombre: 'Uno', categoria: 'splash', precio: 100, tipoStock: 0 },
        { ...toPublic(product, 10), id: 5, nombre: 'Uno', categoria: 'splash', marca: 'Otra', precio: 90, tipoStock: 1 },
        { ...toPublic(product, 10), id: 6, nombre: 'Splashing Uno', categoria: 'perfume', precio: 80, tipoStock: 1 },
        { ...toPublic(product, 10), id: 7, nombre: 'Loci\u00f3n Uno', categoria: 'perfume', precio: 70, tipoStock: 1 }
    ];
    run("perfumesDB = products; filtroMarcaActual = 'Armaf'; filtroTipoActual = 'splash'; filtroStockActual = 'stock'; ordenPrecioActual = 'price-desc';");
    node('searchInput').value = 'uno';
    run('filterProducts();');
    assert.equal(node('resultCount').textContent, '3 productos');
    assert.equal(node('filterCount').textContent, 4);
    const grid = node('products-grid').innerHTML;
    assert.ok(grid.indexOf('verProducto(1)') < grid.indexOf('verProducto(2)'));
    assert.ok(grid.indexOf('verProducto(2)') < grid.indexOf('verProducto(3)'));
    assert.doesNotMatch(grid, /verProducto\([4567]\)/);
    run("ordenPrecioActual = 'price-asc'; filterProducts();");
    assert.ok(node('products-grid').innerHTML.indexOf('verProducto(2)') < node('products-grid').innerHTML.indexOf('verProducto(1)'));
    run("seleccionarFiltroTipo('locion');");
    assert.equal(node('resultCount').textContent, '1 producto');
    assert.match(node('products-grid').innerHTML, /verProducto\(7\)/);
    run('limpiarFiltros();');
    assert.equal(node('resultCount').textContent, '7 productos');
    assert.equal(node('searchInput').value, '');
    assert.equal(node('active-filters').textContent, '');
    node('searchInput').value = 'inexistente';
    run('filterProducts();');
    assert.equal(node('resultCount').textContent, '0 productos');
    assert.equal(node('pagination').innerHTML, '');
});

test('compact pagination keeps 24 products, clamps bounds and resets on changed criteria', async () => {
    const { node, context, run } = await storefront();
    context.products = Array.from({ length: 49 }, (_, index) => ({ ...toPublic(product, 10), id: index + 1 }));
    run('perfumesDB = products; filterProducts();');
    assert.equal((node('products-grid').innerHTML.match(/class="product-card"/g) || []).length, 24);
    assert.match(node('pagination').innerHTML, /Página 1 de 3/);
    assert.equal((node('pagination').innerHTML.match(/<button/g) || []).length, 2);
    assert.match(node('pagination').innerHTML, /disabled>Anterior/);
    run('irAPagina(99);');
    assert.match(node('pagination').innerHTML, /Página 3 de 3/);
    assert.match(node('pagination').innerHTML, /disabled>Siguiente/);
    assert.match(node('products-grid').innerHTML, /verProducto\(49\)/);
    run('irAPagina(-1);');
    assert.match(node('pagination').innerHTML, /Página 1 de 3/);
    run("irAPagina(2); seleccionarFiltroMarca('Armaf');");
    assert.match(node('pagination').innerHTML, /Página 1 de 3/);
});

test('detail includes all notes, full text and consult action without adding unpriced products', async () => {
    const { node, context, run } = await storefront();
    context.products = [{ ...toPublic(product, 10), precio: null, notas: 'Rosa, Vainilla, Oud, Jazmin, Limon.', inspiracion: 'Descripcion completa', nombre: 'Nombre completo' }];
    run('perfumesDB = products; verProducto(507); addToCart(507);');
    assert.equal(node('productDialog').open, true);
    assert.match(node('productDetail').innerHTML, /Nombre completo/);
    assert.match(node('productDetail').innerHTML, /Descripcion completa/);
    assert.match(node('productDetail').innerHTML, /Limon/);
    assert.match(node('productDetail').innerHTML, /Imagen no disponible/);
    assert.match(node('productDetail').innerHTML, /consultarPrecioProducto\(507\)/);
    assert.equal(run('cart.length'), 0);
    run('cerrarDialogo("productDialog");');
    assert.equal(node('productDialog').open, false);
    context.products[0].notas = '';
    run('verProducto(507);');
    assert.match(node('productDetail').innerHTML, /Notas no disponibles/);
});

test('decant asks for ml after the name, preserves edits and includes both values in WhatsApp', async () => {
    const { node, context, run } = await storefront();
    const opened = [];
    const popup = { opener: 'original' };
    context.window = { open: (...args) => { opened.push(args); return popup; } };
    run('solicitarDecant();');
    assert.equal(node('decantMl').disabled, true);
    assert.equal(node('decantAmountStep').hidden, true);
    node('decantPerfume').value = '  Khamrah & <Oud>  ';
    run('enviarSolicitudDecant({ preventDefault() {} });');
    assert.equal(opened.length, 0);
    assert.equal(node('decantNameStep').hidden, true);
    assert.equal(node('decantMl').disabled, false);
    assert.equal(node('decantSelectedPerfume').textContent, 'Khamrah & <Oud>');
    assert.equal(node('decantSelectedPerfume').innerHTML, '');
    node('decantMl').value = '2.5';
    node('decantMl').valueAsNumber = 2.5;
    run('mostrarPasoDecant(1);');
    assert.equal(node('decantPerfume').disabled, false);
    assert.equal(node('decantMl').disabled, true);
    assert.equal(node('decantMl').value, '2.5');
    node('decantPerfume').value = '  Yara & Rose  ';
    run('enviarSolicitudDecant({ preventDefault() {} }); enviarSolicitudDecant({ preventDefault() {} });');
    assert.equal(opened.length, 1);
    const url = new URL(opened[0][0]);
    assert.equal(url.origin + url.pathname, 'https://wa.me/59176609312');
    assert.match(url.searchParams.get('text'), /2\.5 ml del perfume Yara & Rose\./);
    assert.equal(opened[0][1], '_blank');
    assert.equal(popup.opener, null);
    run('solicitarDecant();');
    assert.equal(node('decantAmountStep').hidden, true);
    assert.equal(node('decantPerfume').value, '  Yara & Rose  ');
    assert.equal(node('decantMl').value, '2.5');
});

test('decant rejects blank names and missing, nonfinite or nonpositive ml with visible validation', async () => {
    const { node, context, run } = await storefront();
    context.window = { open: () => assert.fail('Must not open WhatsApp for invalid input') };
    node('decantPerfume').value = '   ';
    run('enviarSolicitudDecant({ preventDefault() {} });');
    assert.equal(run('pasoDecant'), 1);
    assert.ok(node('decantPerfume').validationMessage);
    node('decantPerfume').value = 'Khamrah';
    run('enviarSolicitudDecant({ preventDefault() {} });');
    assert.equal(run('pasoDecant'), 2);
    for (const value of [NaN, 0, -5, Infinity]) {
        node('decantMl').valueAsNumber = value;
        run('enviarSolicitudDecant({ preventDefault() {} });');
        assert.ok(node('decantMl').validationMessage);
        assert.equal(run('pasoDecant'), 2);
    }
});

test('sold-out products stay distinct in filters and cannot be added or increased', async () => {
    const { run, node } = await storefront();
    run(`perfumesDB = ${JSON.stringify([
        { ...product, tipoStock: 0, id: 1, precio: 100 },
        { ...product, tipoStock: 1, id: 2, precio: 100 },
        { ...product, tipoStock: 2, id: 3, precio: 100 }
    ])}; filtroStockActual='order'; filterProducts();`);
    assert.match(node('products-grid').innerHTML, /verProducto\(1\)/);
    assert.doesNotMatch(node('products-grid').innerHTML, /verProducto\(3\)/);
    run("filtroStockActual='soldout'; filterProducts(); addToCart(3);");
    assert.equal(run('cart.length'), 0);
    assert.match(node('products-grid').innerHTML, /Consultar disponibilidad/);
    assert.doesNotMatch(node('products-grid').innerHTML, /addToCart\(3\)/);
    run("cart=[{...perfumesDB[2],quantity:1}]; changeQuantity(3,1);");
    assert.equal(run('cart[0].quantity'), 1);
    assert.match(node('cartError').textContent, /no esta disponible/);
});

test('product gallery and presentation render escaped complete information', async () => {
    const { run, node } = await storefront();
    run(`perfumesDB=[${JSON.stringify({
        ...product, precio: 100, presentacion: '100 ml <script>',
        imagen: 'https://example.test/cover.jpg', imagenes: ['https://example.test/other.jpg']
    })}]; verProducto(507);`);
    assert.match(node('productDetail').innerHTML, /100 ml &lt;script&gt;/);
    assert.match(node('productDetail').innerHTML, /mostrarFotoProducto\(507,1\)/);
    assert.match(node('productDetail').innerHTML, /informacionCompra/);
});

test('checkout rechecks availability, refuses sold-out items and requires acknowledgment of updated prices', async () => {
    const { run, node, context } = await storefront();
    const original = { ...product, precio: 100, tipoStock: 1 };
    let opened = 0;
    context.window = { open: () => { opened++; return { opener: null }; } };
    context.navigator = { userAgent: 'test' };
    run(`perfumesDB=[${JSON.stringify(original)}];cart=[{...perfumesDB[0],quantity:1}];`);
    context.fetch = async () => Response.json({ products: [{ ...original, tipoStock: 2 }] });
    await run('sendToWhatsApp();');
    assert.equal(opened, 0);
    assert.match(node('cartError').textContent, /Retira los productos/);
    context.fetch = async () => Response.json({ products: [{ ...original, precio: 120 }] });
    await run('sendToWhatsApp();');
    assert.equal(opened, 0);
    assert.equal(run('cart[0].precio'), 120);
    assert.match(node('cartError').textContent, /Revisa el total/);
    await run('sendToWhatsApp();');
    assert.equal(opened, 1);
});
