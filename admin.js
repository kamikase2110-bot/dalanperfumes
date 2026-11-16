import { productProfit } from './pricing.js';

const $ = id => document.getElementById(id);
const form = $('product-form');
let products = [];
let selected = null;
let rate = null;
let pricing = null;
let dirty = false;
let busy = false;
let page = 1;
let pendingPhoto = null;
let previewUrl = null;
const pageSize = 25;

function status(message, error = false) {
    $('status').textContent = message;
    $('status').dataset.error = String(error);
}

function showLogin() {
    $('login-section').hidden = false;
    $('panel').hidden = true;
    $('logout').hidden = true;
}

async function request(path, options = {}, retry = true) {
    const response = await fetch(`/api/admin/${path}`, { ...options, credentials: 'same-origin' });
    if (response.status === 401 && retry && !['refresh', 'session'].includes(path)) {
        await request('refresh', { method: 'POST' }, false);
        return request(path, options, false);
    }
    const body = await response.json().catch(() => { throw new Error('El servidor no devolvio una respuesta valida. Revisa la configuracion de Cloudflare.'); });
    if (!response.ok) {
        if (response.status === 401) showLogin();
        throw new Error(body.error || `No se pudo completar la operacion (${response.status}).`);
    }
    return body;
}

function sendJson(method, data) {
    return { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) };
}

function confirmDiscard() {
    return !dirty || window.confirm('Tienes cambios sin guardar. Deseas descartarlos?');
}

function setBusy(value) {
    busy = value;
    document.querySelectorAll('#panel button, #product-form input, #product-form select, #product-form textarea, #logout')
        .forEach(element => { element.disabled = value; });
    if (!value) renderList();
}

function renderList() {
    const query = $('search').value.trim().toLocaleLowerCase('es');
    const visibility = $('visibility').value;
    const filtered = products.filter(product =>
        `${product.nombre} ${product.marca} ${product.referencia || ''}`.toLocaleLowerCase('es').includes(query) &&
        (visibility === 'all' || (visibility === 'hidden' ? product.oculto : !product.oculto)));
    const pages = Math.max(1, Math.ceil(filtered.length / pageSize));
    page = Math.min(page, pages);
    $('count').textContent = `(${filtered.length})`;
    $('product-list').replaceChildren();
    for (const product of filtered.slice((page - 1) * pageSize, page * pageSize)) {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'product-row';
        button.setAttribute('aria-pressed', String(selected?.id === product.id));
        button.textContent = product.nombre;
        const detail = document.createElement('small');
        detail.textContent = `${product.marca || 'Sin marca'} · USD ${product.precioUSD} · ${product.oculto ? 'Oculto' : product.tipoStock === 1 ? 'En stock' : 'Por pedido'}`;
        button.append(detail);
        button.disabled = busy;
        button.addEventListener('click', () => {
            if (!busy && confirmDiscard()) edit(product);
        });
        $('product-list').append(button);
    }
    if (!filtered.length) $('product-list').textContent = 'No hay productos que coincidan.';
    $('page').textContent = `${page} / ${pages}`;
    $('previous').disabled = busy || page <= 1;
    $('next').disabled = busy || page >= pages;
}

function clearPendingPhoto() {
    pendingPhoto = null;
    $('photo-file').value = '';
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    previewUrl = null;
}

function updatePhoto() {
    const value = previewUrl || form.elements.imagen.value.trim();
    let safe = !!previewUrl;
    if (!safe && value) {
        try { safe = new URL(value).protocol === 'https:'; } catch { safe = false; }
    }
    $('photo-preview').hidden = !safe;
    if (safe) $('photo-preview').src = value;
    else $('photo-preview').removeAttribute('src');
}

function previewPrice() {
    if (!pricing) return;
    const cost = Number(form.elements.precioUSD.value);
    const profit = productProfit({
        nombre: form.elements.nombre.value,
        categoria: form.elements.categoria.value
    }, pricing);
    if (!rate) {
        $('price-preview').textContent = 'Sin cotizacion disponible: el precio final se mostrara para consultar.';
    } else if (cost > 0) {
        const total = (cost + pricing.transporteUSD) * rate + profit;
        $('price-preview').textContent = `Precio en tienda: Bs ${Math.round(total)} · (${cost} + ${pricing.transporteUSD}) × ${rate} + ${profit} Bs. La tasa puede cambiar.`;
    } else {
        $('price-preview').textContent = 'Con costo 0 se muestra "Consultar precio". Ingresa un costo mayor que 0 para calcularlo.';
    }
}

function edit(product = null) {
    selected = product ? { ...product } : null;
    form.reset();
    clearPendingPhoto();
    for (const field of ['nombre', 'marca', 'referencia', 'inspiracion', 'notas', 'precioUSD', 'tipoStock', 'categoria']) {
        if (product) form.elements[field].value = product[field] ?? '';
    }
    form.elements.imagen.value = product?.imagen === 'Imagen no disponible' ? '' : product?.imagen || '';
    form.elements.oculto.checked = product?.oculto || false;
    $('editor-title').textContent = product ? `Editar producto #${product.id}` : 'Agregar producto';
    dirty = false;
    updatePhoto();
    previewPrice();
    renderList();
}

async function loadProducts(keepEditor = false) {
    const data = await request('products');
    products = data.products;
    rate = data.rate;
    pricing = data.pricing;
    $('pricing').textContent = `Transporte: USD ${pricing.transporteUSD} · Ganancia perfumes: ${pricing.gananciaBs} Bs · Minis/desodorantes/splash/lociones: ${pricing.gananciaDesodorantesMinisBs} Bs`;
    $('brands').replaceChildren();
    for (const brand of [...new Set(products.map(product => product.marca).filter(Boolean))].sort()) {
        const option = document.createElement('option');
        option.value = brand;
        $('brands').append(option);
    }
    if (!keepEditor) edit(selected ? products.find(product => product.id === selected.id) : null);
    else { renderList(); previewPrice(); }
    status(data.warning || `${products.length} productos cargados. Los cambios se publican al guardar.`, Boolean(data.warning));
}

async function showPanel(email) {
    $('account').textContent = email;
    $('login-section').hidden = true;
    $('panel').hidden = false;
    $('logout').hidden = false;
    setBusy(true);
    try { await loadProducts(dirty); } finally { setBusy(false); }
}

$('login-form').addEventListener('submit', async event => {
    event.preventDefault();
    const login = event.currentTarget;
    const button = login.querySelector('button');
    button.disabled = true;
    status('Ingresando...');
    try {
        const data = await request('session', sendJson('POST', {
            email: login.elements.email.value,
            password: login.elements.password.value
        }), false);
        login.elements.password.value = '';
        await showPanel(data.email);
    } catch (error) {
        status(error.message, true);
    } finally { button.disabled = false; }
});

form.addEventListener('input', () => { dirty = true; previewPrice(); });
form.elements.imagen.addEventListener('input', () => { clearPendingPhoto(); updatePhoto(); });
$('photo-file').addEventListener('change', event => {
    const file = event.target.files[0];
    if (!file) return;
    if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type) || file.size > 4 * 1024 * 1024) {
        event.target.value = '';
        status('Selecciona una foto JPG, PNG o WebP de hasta 4 MB.', true);
        return;
    }
    clearPendingPhoto();
    pendingPhoto = file;
    previewUrl = URL.createObjectURL(file);
    dirty = true;
    updatePhoto();
});
$('photo-preview').addEventListener('error', () => {
    $('photo-preview').hidden = true;
    status('No se pudo mostrar la foto. Revisa el enlace o selecciona otra imagen.', true);
});
$('clear-photo').addEventListener('click', () => {
    clearPendingPhoto();
    form.elements.imagen.value = '';
    dirty = true;
    updatePhoto();
});

form.addEventListener('submit', async event => {
    event.preventDefault();
    if (busy) return;
    const product = {
        nombre: form.elements.nombre.value,
        marca: form.elements.marca.value,
        referencia: form.elements.referencia.value,
        inspiracion: form.elements.inspiracion.value,
        notas: form.elements.notas.value,
        imagen: form.elements.imagen.value,
        precioUSD: Number(form.elements.precioUSD.value),
        tipoStock: Number(form.elements.tipoStock.value),
        categoria: form.elements.categoria.value,
        oculto: form.elements.oculto.checked,
        ...(selected ? { id: selected.id, version: selected.version } : {})
    };
    setBusy(true);
    status('Guardando...');
    try {
        if (pendingPhoto) {
            const photo = await request('image', { method: 'POST', headers: { 'Content-Type': pendingPhoto.type }, body: pendingPhoto });
            product.imagen = photo.url;
            form.elements.imagen.value = photo.url;
            clearPendingPhoto();
            updatePhoto();
        }
        const data = await request('products', sendJson(selected ? 'PUT' : 'POST', product));
        const index = products.findIndex(item => item.id === data.product.id);
        if (index >= 0) products[index] = data.product;
        else products.push(data.product);
        edit(data.product);
        status(data.product.oculto ? 'Producto guardado y oculto de la tienda.' : 'Producto guardado y publicado. Recarga la tienda para verlo.');
    } catch (error) {
        status(`${error.message} Tus cambios siguen en el formulario.`, true);
    } finally { setBusy(false); }
});

$('new').addEventListener('click', () => {
    if (!busy && confirmDiscard()) { edit(); form.elements.nombre.focus(); }
});
$('discard').addEventListener('click', () => { if (!busy && confirmDiscard()) edit(selected); });
$('reload').addEventListener('click', async () => {
    if (busy || !confirmDiscard()) return;
    setBusy(true);
    try { await loadProducts(); } catch (error) { status(error.message, true); } finally { setBusy(false); }
});
for (const id of ['search', 'visibility']) $(id).addEventListener('input', () => { page = 1; renderList(); });
$('previous').addEventListener('click', () => { page--; renderList(); });
$('next').addEventListener('click', () => { page++; renderList(); });
$('logout').addEventListener('click', async () => {
    if (busy || !confirmDiscard()) return;
    setBusy(true);
    try {
        await request('session', { method: 'DELETE' }, false);
        dirty = false;
        products = [];
        edit();
        showLogin();
        status('Sesion cerrada.');
    } catch (error) { status(error.message, true); } finally { setBusy(false); }
});
window.addEventListener('beforeunload', event => {
    if (dirty || busy) { event.preventDefault(); event.returnValue = ''; }
});

async function initialize() {
    try {
        let response = await fetch('/api/admin/session', { credentials: 'same-origin' });
        if (response.status === 401) {
            response = await fetch('/api/admin/refresh', { method: 'POST', credentials: 'same-origin' });
        }
        const data = await response.json();
        if (!response.ok) {
            showLogin();
            if (response.status === 401) status('Ingresa para administrar el catalogo.');
            else status(data.error || 'No se pudo comprobar el acceso.', true);
            return;
        }
        await showPanel(data.email);
    } catch (error) {
        showLogin();
        status(`No se pudo abrir el panel: ${error.message}`, true);
    }
}
initialize();
