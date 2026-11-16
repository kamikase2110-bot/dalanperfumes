export function productType(product) {
    if (['mini', 'desodorante', 'splash', 'locion'].includes(product.categoria)) return product.categoria;
    const name = product.nombre.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
    if (/\bsplash(?:es)?\b/i.test(name)) return 'splash';
    if (/\b(?:locion(?:es)?|lotions?)\b/i.test(name)) return 'locion';
    return 'perfume';
}
