import { productType } from './product-types.js';

export const pricing = Object.freeze({ transporteUSD: 5, gananciaBs: 100, gananciaDesodorantesMinisBs: 50 });

export function productProfit(product, rules = pricing) {
    const reduced = productType(product) !== 'perfume';
    return reduced ? rules.gananciaDesodorantesMinisBs : rules.gananciaBs;
}
