#!/usr/bin/env node
/* ============================================================================
   build.mjs — Assembla o dashboard BWAG Pré-Trade em um HTML autossuficiente.

   Entradas:
     src/index.html      — template do corpo (placeholders {{...}})
     src/styles.css      — design system
     src/catalogs.js     — catálogos (regras, métricas, mapa de campos)
     src/app.js          — lógica da aplicação
     vendor/*.js         — SheetJS + pdf.js (main + worker)
     assets/*.png        — logos BWAG

   Saídas:
     dashboard.html          — documento HTML completo (abrir no navegador)
     dist/artifact.html      — corpo apenas, para publicar como Artifact
   ==========================================================================*/
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = dirname(fileURLToPath(import.meta.url));
const r = (p) => readFileSync(join(ROOT, p), 'utf8');
const b64 = (p) => readFileSync(join(ROOT, p)).toString('base64');

// Impede que um literal "</script>" dentro do JS embutido feche a tag <script>.
// Também troca U+FFFD (presente nas tabelas de codepage do SheetJS, irrelevantes
// para .xlsx/.csv) por "?", pois a publicação como Artifact rejeita U+FFFD.
const safe = (js) => js.replace(/<\/script/gi, '<\\/script').replace(/�/g, '?');

const styles      = r('src/styles.css');
const template    = r('src/index.html');
const catalogs    = safe(r('src/catalog-data.js'));
const parser      = safe(r('src/parser.js'));
const engine      = safe(r('src/engine.js'));
const app         = safe(r('src/app.js'));
const xlsx        = safe(r('vendor/xlsx.full.min.js'));
const pdfjs       = safe(r('vendor/pdf.min.js'));
const pdfWorker   = safe(r('vendor/pdf.worker.min.js'));

const logo        = 'data:image/png;base64,' + b64('assets/bwag-logo.png');
const logoWhite   = 'data:image/png;base64,' + b64('assets/bwag-logo-white.png');

// Monta o corpo a partir do template.
// IMPORTANTE: usar funções replacer — o conteúdo JS contém sequências "$" que,
// como string de substituição, seriam interpretadas como padrões ($&, $$, $1...).
const inject = (tpl, ph, content) => tpl.replace(ph, () => content);
let body = template;
body = inject(body, '{{STYLES}}', `<style>\n${styles}\n</style>`);
body = body.replace(/{{LOGO}}/g, () => logo).replace(/{{LOGO_WHITE}}/g, () => logoWhite);
// Ordem importa: libs primeiro, depois catálogos/parser/engine, depois app.
body = inject(body, '{{XLSX}}', `<script>${xlsx}</script>`);
body = inject(body, '{{PDFJS}}', `<script>${pdfjs}</script>`);
// Worker embutido como texto (não executa aqui) — o app cria um Blob a partir dele.
body = inject(body, '{{PDF_WORKER}}', `<script type="javascript/worker" id="pdfWorkerSrc">${pdfWorker}</script>`);
body = inject(body, '{{CATALOGS}}', `<script>${catalogs}</script>`);
body = inject(body, '{{PARSER}}', `<script>${parser}</script>`);
body = inject(body, '{{ENGINE}}', `<script>${engine}</script>`);
body = inject(body, '{{APP}}', `<script>${app}</script>`);

// Saída 1 — Artifact (corpo apenas; a plataforma envolve em <html>/<head>/<body>).
mkdirSync(join(ROOT, 'dist'), { recursive: true });
writeFileSync(join(ROOT, 'dist/artifact.html'), body);

// Saída 2 — Documento HTML completo, abrível por duplo-clique.
const full = `<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light">
<title>BWAG — Dashboard Pré-Trade</title>
</head>
<body>
${body}
</body>
</html>`;
writeFileSync(join(ROOT, 'dashboard.html'), full);
// Saída 3 — index.html (raiz do GitHub Pages: a URL base abre o dashboard).
writeFileSync(join(ROOT, 'index.html'), full);

const kb = (s) => Math.round(Buffer.byteLength(s) / 1024);
console.log(`✓ dashboard.html      ${kb(full)} KB`);
console.log(`✓ index.html          ${kb(full)} KB  (GitHub Pages)`);
console.log(`✓ dist/artifact.html  ${kb(body)} KB`);
