export const pricing = Object.freeze({ transporteUSD: 5, gananciaBs: 100, gananciaDesodorantesMinisBs: 50 });

export function productProfit(product, rules = pricing) {
    const name = product.nombre.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
    const reduced = ['mini', 'desodorante', 'splash', 'locion'].includes(product.categoria) ||
        /\b(?:splash(?:es)?|locion(?:es)?|lotions?)\b/i.test(name);
    return reduced ? rules.gananciaDesodorantesMinisBs : rules.gananciaBs;
}
