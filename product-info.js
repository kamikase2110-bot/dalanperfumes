export const features = { reviews: false };

export function availability(product) {
    return [
        { label: 'Por pedido', filter: 'order', className: 'order', purchasable: true },
        { label: 'Disponible', filter: 'stock', className: 'stock', purchasable: true },
        { label: 'Agotado', filter: 'soldout', className: 'soldout', purchasable: false }
    ][Number(product.tipoStock)] ?? { label: 'Consultar disponibilidad', filter: 'unknown', className: 'soldout', purchasable: false };
}

export function productImages(product) {
    return [...new Set([product.imagen, ...(product.imagenes || [])]
        .filter(url => url && url !== 'Imagen no disponible'))];
}
