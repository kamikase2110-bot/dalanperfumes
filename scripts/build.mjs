import { mkdir, copyFile } from 'node:fs/promises';

await mkdir('dist', { recursive: true });
for (const file of ['index.html', 'admin.html', 'admin.js', 'admin.css', '_headers', '_routes.json']) {
    await copyFile(file, `dist/${file}`);
}
console.log('Sitio generado en dist; no se incluyen costos, SQL ni archivos privados.');
