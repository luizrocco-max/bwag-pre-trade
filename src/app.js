/* ============================================================================
   app.js — BWAG Dashboard Pré-Trade (lógica de interface)
   Vanilla JS. Estado em memória + persistência local de política/checklist.
   ==========================================================================*/
(function () {
  'use strict';
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));

  // ---------------------------------------------------------- pdf.js worker
  function setupPdfWorker() {
    try {
      const src = document.getElementById('pdfWorkerSrc');
      if (src && window.pdfjsLib) {
        const blob = new Blob([src.textContent], { type: 'application/javascript' });
        pdfjsLib.GlobalWorkerOptions.workerSrc = URL.createObjectURL(blob);
      }
    } catch (e) { console.warn('pdf worker fallback', e); }
  }

  // ------------------------------------------------------------- formatação
  const nf = (n, d = 1) => (n == null || isNaN(n)) ? '—' : Number(n).toLocaleString('pt-BR', { minimumFractionDigits: d, maximumFractionDigits: d });
  const pf = (n, d = 1) => (n == null || isNaN(n)) ? '—' : nf(n, d) + '%';
  const money = (n) => (n == null || isNaN(n)) ? '—' : 'R$ ' + Number(n).toLocaleString('pt-BR', { minimumFractionDigits: 0, maximumFractionDigits: 0 });
  const moneyK = (n) => {
    if (n == null || isNaN(n)) return '—';
    const a = Math.abs(n);
    if (a >= 1e9) return 'R$ ' + nf(n / 1e9, 2) + ' bi';
    if (a >= 1e6) return 'R$ ' + nf(n / 1e6, 2) + ' mi';
    if (a >= 1e3) return 'R$ ' + nf(n / 1e3, 0) + ' mil';
    return money(n);
  };
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const SEG = ['#3D35CE', '#1C0845', '#2E8B8B', '#B45309', '#1B7340', '#7A73E8', '#C2410C', '#0E7490', '#9B9B9B', '#6D28D9'];

  function toast(msg, kind) {
    const t = document.createElement('div');
    t.className = 'toast' + (kind ? ' ' + kind : '');
    t.textContent = msg;
    $('#toasts').appendChild(t);
    setTimeout(() => { t.style.opacity = '0'; setTimeout(() => t.remove(), 300); }, 3400);
  }

  // ------------------------------------------------------------- estado
  const STATE = {
    fundos: [], fundoAtivo: null,
    quantum: null,          // { rows, index, cols, headers }
    politicas: {},          // fundoAtivo -> policy
    cenarios: {},           // fundoAtivo -> [ {id, nome, pesos, base} ]
    cenarioAtivo: {},       // fundoAtivo -> cenarioId
    checklist: {},          // fundoAtivo -> {ruleId: bool}
    view: 'input',
  };
  const LS = 'bwag_pretrade_v1';
  function persist() {
    try { localStorage.setItem(LS, JSON.stringify({ politicas: STATE.politicas, checklist: STATE.checklist })); } catch (e) {}
  }
  function restore() {
    try { const d = JSON.parse(localStorage.getItem(LS) || '{}'); if (d.politicas) STATE.politicas = d.politicas; if (d.checklist) STATE.checklist = d.checklist; } catch (e) {}
  }

  const fundo = () => STATE.fundos.find(f => f.header.fundo === STATE.fundoAtivo) || null;
  function policy() {
    const f = fundo(); if (!f) return null;
    if (!STATE.politicas[f.header.fundo]) {
      const p = Engine.presetPara(f.header.fundo);
      p.publicoAlvo = 'QUALIFICADO';
      STATE.politicas[f.header.fundo] = p;
    }
    return STATE.politicas[f.header.fundo];
  }
  function cenarios() {
    const f = fundo(); if (!f) return [];
    if (!STATE.cenarios[f.header.fundo]) STATE.cenarios[f.header.fundo] = [{ id: 'atual', nome: 'Posição atual', pesos: null, base: true }];
    return STATE.cenarios[f.header.fundo];
  }
  function cenarioAtual() {
    const f = fundo(); if (!f) return null;
    const cs = cenarios();
    const id = STATE.cenarioAtivo[f.header.fundo] || 'atual';
    return cs.find(c => c.id === id) || cs[0];
  }

  // =========================================================== STEPPER / NAV
  const STEPS = [
    { id: 'input', n: '1', t: 'Posição', s: 'Relatório BTG / Bradesco' },
    { id: 'quantum', n: '2', t: 'Métricas', s: 'Quantum Axis' },
    { id: 'politica', n: '3', t: 'Política', s: 'Mandato & perfil' },
    { id: 'cenarios', n: '4', t: 'Proxy de alocação', s: 'Cenários' },
    { id: 'pretrade', n: '5', t: 'Pré-trade', s: 'Enquadramento & parecer' },
  ];
  function renderStepper() {
    const f = fundo();
    $('#stepper').innerHTML = STEPS.map(st => {
      let chip = '';
      if (st.id === 'input' && STATE.fundos.length) chip = `<span class="chip-count">${STATE.fundos.length}</span>`;
      if (st.id === 'quantum' && STATE.quantum) chip = `<span class="chip-count">${STATE.quantum.rows.length}</span>`;
      if (st.id === 'pretrade' && f) { const r = runEngineActive(); if (r) chip = `<span class="chip-count">${r.resumo.bloqueio ? '⚠ ' + r.resumo.bloqueio : '✓'}</span>`; }
      return `<button class="step ${STATE.view === st.id ? 'active' : ''}" data-step="${st.id}">
        <span class="step-num">${st.n}</span>
        <span class="step-label"><b>${st.t}</b><span>${st.s}</span></span>${chip}</button>`;
    }).join('');
  }
  function go(view) { STATE.view = view; $$('.view').forEach(v => v.classList.toggle('active', v.id === 'view-' + view)); renderStepper(); rerenderActive(); window.scrollTo({ top: 0, behavior: 'smooth' }); }
  function rerenderActive() {
    if (STATE.view === 'input') renderInput();
    else if (STATE.view === 'quantum') renderQuantum();
    else if (STATE.view === 'politica') renderPolitica();
    else if (STATE.view === 'cenarios') renderCenarios();
    else if (STATE.view === 'pretrade') renderPretrade();
    updateMeta();
  }
  function updateMeta() {
    const f = fundo();
    $('#meta-fundo').textContent = f ? f.header.fundo : (STATE.fundos.length ? 'Selecione um fundo' : 'Nenhum fundo carregado');
    $('#meta-data').textContent = f ? `${f.formato === 'bradesco' ? 'Bradesco' : 'BTG'} · posição ${f.header.cotaData || '—'} · PL ${moneyK(f.header.patrimonio)}` : 'Importe o relatório para começar';
  }

  // ============================================================ 1. POSIÇÃO
  function dropzoneHTML(id, titulo, sub, formatos) {
    return `<div class="dropzone" id="${id}">
      <div class="dz-ico">⬆</div><h3>${titulo}</h3><p>${sub}</p>
      <div class="formats">${formatos}</div></div>`;
  }
  function renderInput() {
    const f = fundo();
    let html = `<div class="panel"><div class="panel-head">
      <div class="ph-text"><h2>Posição dos fundos</h2><p>Importe o <b>Relatório de Performance Diário (BTG)</b> ou a <b>Carteira Diária (Bradesco)</b>. O formato é detectado automaticamente.</p></div>
      <div class="ph-actions">
        <button class="btn btn-outline btn-sm" id="btn-exemplo">Carregar exemplo</button>
        <label class="btn btn-primary btn-sm">Importar PDF<input type="file" id="file-pdf" accept="application/pdf,.pdf" multiple hidden></label>
      </div></div><div class="panel-body">`;
    if (!STATE.fundos.length) {
      html += dropzoneHTML('dz-pdf', 'Solte os PDFs aqui ou clique para selecionar', 'Aceita múltiplos fundos de uma vez', 'PDF · BTG AcompFI · Bradesco Carteira Diária');
    } else {
      html += `<div class="row wrap" style="gap:8px;margin-bottom:6px">`;
      html += STATE.fundos.map(fd => {
        const on = fd.header.fundo === STATE.fundoAtivo;
        return `<button class="btn ${on ? 'btn-primary' : 'btn-outline'} btn-sm" data-fundo="${esc(fd.header.fundo)}">
          ${esc(fd.header.fundo)} <span class="badge ${fd.formato === 'bradesco' ? 'badge-info' : 'badge-muted'}" style="margin-left:6px">${fd.formato === 'bradesco' ? 'Bradesco' : 'BTG'}</span></button>`;
      }).join('');
      html += `</div>`;
    }
    html += `</div></div>`;

    if (f) html += posicaoDetalhe(f);
    $('#view-input').innerHTML = html;
    wireDropzone('dz-pdf', handlePdfFiles);
  }

  function posicaoDetalhe(f) {
    const pol = policy();
    const P = Engine.perfil(f, null, STATE.quantum ? STATE.quantum.index : null, pol);
    const H = f.header;
    // KPIs
    let html = `<div class="panel"><div class="panel-head"><div class="ph-text">
      <h2>${esc(H.fundo)}</h2><p>Classe estimada: <b>${esc(Engine.PRESETS[pol.chave].rotulo)}</b> · público-alvo <b>${(pol.publicoAlvo || '').toLowerCase()}</b> · ${f.carteira.length} ativos</p></div>
      <div class="ph-actions"><button class="btn btn-accent btn-sm" id="go-pretrade">Rodar pré-trade →</button></div></div><div class="panel-body">
      <div class="kpi-grid">
        ${kpi('Patrimônio líquido', moneyK(H.patrimonio), H.cotaData ? 'posição ' + H.cotaData : '', true)}
        ${H.cota ? kpi('Valor da cota', 'R$ ' + nf(H.cota, 6), '') : kpi('Ativos', f.carteira.length, 'linhas na carteira')}
        ${kpi('Maior emissor', pf(P.maiorEmissor[1]), esc(P.maiorEmissor[0]).slice(0, 22))}
        ${kpi('Concentração Top-5', pf(P.top5), 'HHI ' + nf(P.hhi, 3) + ' · N≈' + nf(P.nEfetivo, 1))}
        ${kpi('Exterior', pf(P.exteriorPct), 'teto ' + pf(Engine.EXTERIOR_TETO[pol.publicoAlvo] || 100, 0))}
        ${kpi('Liquidez D+' + pol.resgateDias, pf(P.liqCum(pol.resgateDias)), 'caixa D+0 ' + pf(P.caixaPct))}
      </div></div></div>`;

    // Alocação por classe
    const classes = Object.entries(P.porClasse).sort((a, b) => b[1] - a[1]);
    html += `<div class="cols-2">
      <div class="panel"><div class="panel-head"><div class="ph-text"><h2>Alocação por classe</h2><p>Distribuição do PL entre classes de ativo</p></div></div>
        <div class="panel-body">${allocBar(classes)}</div></div>
      <div class="panel"><div class="panel-head"><div class="ph-text"><h2>Concentração por emissor/gestor</h2><p>Maiores posições agregadas por emissor</p></div></div>
        <div class="panel-body tight">${concTable(f.concentracao && f.concentracao.length ? f.concentracao : Object.entries(P.porEmissor).map(([nome, pct]) => ({ nome, pct })).sort((a, b) => b.pct - a.pct).slice(0, 15), pol.limiteEmissor)}</div></div>
    </div>`;

    // Liquidez + carteira
    if (f.liquidez && f.liquidez.length) {
      html += `<div class="panel"><div class="panel-head"><div class="ph-text"><h2>Escada de liquidez</h2><p>Conversibilidade do PL por faixa de prazo (fonte: relatório BTG)</p></div></div>
        <div class="panel-body tight">${liqTable(f.liquidez)}</div></div>`;
    } else {
      html += `<div class="panel"><div class="panel-body"><div class="notice notice-info"><span class="n-ico">ℹ</span>
        <div>O relatório <b>${f.formato === 'bradesco' ? 'Bradesco' : 'deste fundo'}</b> não traz a escada de liquidez detalhada. A liquidez por ativo é estimada (ações D+2, fundos pelo prazo de resgate da política). Importe as métricas do Quantum Axis para prazos de cotização/liquidação precisos.</div></div></div></div>`;
    }
    html += carteiraTable(f);
    return html;
  }

  const kpi = (label, val, sub, accent) => `<div class="kpi ${accent ? 'accent' : ''}"><div class="k-label">${label}</div><div class="k-value">${val}</div>${sub ? `<div class="k-sub">${sub}</div>` : ''}</div>`;

  function allocBar(entries) {
    const tot = entries.reduce((s, [, v]) => s + Math.max(0, v), 0) || 100;
    let bar = `<div class="alloc-bar">`;
    entries.forEach(([, v], i) => { if (v > 0) bar += `<div class="alloc-seg" style="width:${(v / tot * 100).toFixed(2)}%;background:${SEG[i % SEG.length]}"></div>`; });
    bar += `</div><div class="alloc-legend">`;
    entries.forEach(([k, v], i) => { bar += `<div class="li"><span class="sw" style="background:${SEG[i % SEG.length]}"></span>${esc(k)} <b>${pf(v)}</b></div>`; });
    return bar + `</div>`;
  }

  function concTable(rows, limite) {
    let h = `<div class="table-wrap"><table class="data"><thead><tr><th>Emissor / gestor</th><th class="num">%PL</th><th style="width:38%">Limite ${pf(limite, 0)}</th></tr></thead><tbody>`;
    rows.forEach(r => {
      const over = r.pct > limite;
      const w = Math.min(100, r.pct / limite * 100);
      h += `<tr><td>${esc(r.nome)}</td><td class="num ${over ? 'neg' : ''}">${pf(r.pct, 2)}</td>
        <td><div class="limit-bar"><div class="fill ${over ? 'block' : ''}" style="width:${w.toFixed(0)}%"></div><div class="mark" style="left:100%"></div></div></td></tr>`;
    });
    return h + `</tbody></table></div>`;
  }

  function liqTable(liq) {
    const faixas = liq.filter(l => /^D/.test(l.faixa));
    let h = `<div class="table-wrap"><table class="data"><thead><tr><th>Faixa</th><th class="num">% do fundo</th><th class="num">Financeiro</th><th class="num">Acumulado</th></tr></thead><tbody>`;
    faixas.forEach(l => { h += `<tr><td class="mono">${esc(l.faixa)}</td><td class="num">${pf(l.pct, 2)}</td><td class="num">${money(l.financeiro)}</td><td class="num">${pf(l.acumPct, 2)}</td></tr>`; });
    return h + `</tbody></table></div>`;
  }

  function carteiraTable(f) {
    const norm = Engine.normalizarCarteira(f);
    let h = `<div class="panel"><div class="panel-head"><div class="ph-text"><h2>Carteira</h2><p>${norm.length} ativos · ordenados por peso</p></div></div><div class="panel-body tight"><div class="table-wrap"><table class="data">
      <thead><tr><th>Ativo</th><th>Classe</th><th>Estratégia</th><th class="num">%PL</th><th class="num">Financeiro</th><th class="num">Liquidez</th><th>Emissor/gestor</th></tr></thead><tbody>`;
    norm.slice().sort((a, b) => b.pesoAtual - a.pesoAtual).forEach(hd => {
      h += `<tr><td><b>${esc(hd.nome)}</b></td><td>${esc(hd.classe)}</td><td class="small muted">${esc(hd.subclasseAtivo || hd.subclasse)}</td>
        <td class="num">${pf(hd.pesoAtual, 2)}</td><td class="num">${money(hd.financeiro)}</td>
        <td class="num mono">${hd.liqDias != null ? 'D+' + hd.liqDias : '—'}</td><td class="small muted">${esc((hd.emissor || '').slice(0, 30))}</td></tr>`;
    });
    return h + `</tbody></table></div></div></div>`;
  }

  // ============================================================ 2. QUANTUM
  function renderQuantum() {
    let html = `<div class="panel"><div class="panel-head"><div class="ph-text">
      <h2>Métricas — Quantum Axis</h2><p>Importe a planilha exportada do Quantum Axis com as métricas dos fundos/ativos candidatos. As colunas são reconhecidas automaticamente.</p></div>
      <div class="ph-actions">
        <button class="btn btn-ghost btn-sm" id="q-modelo">Baixar modelo (CSV)</button>
        <button class="btn btn-outline btn-sm" id="q-exemplo">Exemplo</button>
        <label class="btn btn-primary btn-sm">Importar planilha<input type="file" id="file-xlsx" accept=".xlsx,.xls,.csv" hidden></label>
      </div></div><div class="panel-body">`;
    if (!STATE.quantum) {
      html += dropzoneHTML('dz-xlsx', 'Solte a planilha do Quantum Axis', 'Excel (.xlsx/.xls) ou CSV', 'Nome do Fundo · CNPJ · Retorno · Volatilidade · Sharpe · VaR · Liquidez · Taxas');
      html += metricGuide();
    } else {
      const q = STATE.quantum;
      html += `<div class="notice notice-ok" style="margin-bottom:16px"><span class="n-ico">✓</span>
        <div><b>${q.rows.length}</b> ativos importados · <b>${Object.values(q.cols).filter(Boolean).length}</b> métricas reconhecidas.
        ${fundo() ? 'Cobertura na carteira do fundo ativo: <b>' + coberturaQuantum() + '</b>.' : 'Selecione um fundo para casar as métricas.'}</div></div>`;
      html += mappingTable(q);
      html += quantumTable(q);
    }
    html += `</div></div>`;
    $('#view-quantum').innerHTML = html;
    wireDropzone('dz-xlsx', handleXlsx);
  }

  function metricGuide() {
    const ess = (typeof METRIC_CATALOG !== 'undefined' ? METRIC_CATALOG : []).filter(m => m.priority === 'essencial');
    let h = `<div class="section-title" style="margin-top:22px">Métricas essenciais para o pré-trade</div><div class="cols-2"><div class="stack">`;
    ess.slice(0, Math.ceil(ess.length / 2)).forEach(m => h += metricCard(m));
    h += `</div><div class="stack">`;
    ess.slice(Math.ceil(ess.length / 2)).forEach(m => h += metricCard(m));
    return h + `</div></div>`;
  }
  const metricCard = (m) => `<div class="kpi"><div class="k-label">${esc(m.metric)}</div><div class="small" style="margin-top:6px;color:var(--text)">${esc(m.definition)}</div><div class="small muted" style="margin-top:4px"><b>Pré-trade:</b> ${esc(m.pretradeUse)}</div></div>`;

  const QMAP = {
    nome: [/nome do fundo/i, /^fundo$/i, /^ativo$/i, /descri[çc][ãa]o/i, /papel/i],
    cnpj: [/cnpj/i], gestora: [/gestor/i], classe: [/classifica|classe anbima|categoria/i],
    benchmark: [/benchmark|refer[êe]ncia/i], pl: [/^pl$|patrim[ôo]nio/i],
    ret12: [/retorno.*12|12.*meses|12m/i], retAno: [/no ano|ytd/i], retMes: [/retorno.*m[êe]s|^m[êe]s$/i],
    vol: [/volatil/i], sharpe: [/sharpe/i], sortino: [/sortino/i], drawdown: [/drawdown|dd/i],
    var: [/^var|value at risk/i], beta: [/beta/i], te: [/tracking/i], correl: [/correla/i],
    taxaAdm: [/taxa.*adm/i], taxaPerf: [/taxa.*perf/i], cotResg: [/cotiza.*resg/i], liqResg: [/liquida.*resg|pagamento/i],
  };
  function detectCols(headers) {
    const cols = {};
    for (const key in QMAP) {
      let idx = -1;
      for (let i = 0; i < headers.length; i++) if (QMAP[key].some(re => re.test(headers[i]))) { idx = i; break; }
      cols[key] = idx >= 0 ? idx : null;
    }
    return cols;
  }
  function parseNumCell(v) {
    if (v == null || v === '') return null;
    if (typeof v === 'number') return v;
    let s = String(v).replace(/[R$%\s]/g, '');
    if (/,\d+$/.test(s)) s = s.replace(/\./g, '').replace(',', '.');
    const n = parseFloat(s); return isNaN(n) ? null : n;
  }
  function buildQuantumIndex(rows, cols) {
    const list = [], exact = {};
    for (const r of rows) {
      const nome = cols.nome != null ? r[cols.nome] : null;
      if (!nome) continue;
      const o = {
        nome, cnpj: cols.cnpj != null ? r[cols.cnpj] : null,
        vol: parseNumCell(cols.vol != null ? r[cols.vol] : null),
        ret12: parseNumCell(cols.ret12 != null ? r[cols.ret12] : null),
        sharpe: parseNumCell(cols.sharpe != null ? r[cols.sharpe] : null),
        var: parseNumCell(cols.var != null ? r[cols.var] : null),
        taxaAdm: parseNumCell(cols.taxaAdm != null ? r[cols.taxaAdm] : null),
        cotResg: parseNumCell(cols.cotResg != null ? r[cols.cotResg] : null),
        classe: cols.classe != null ? r[cols.classe] : null,
      };
      o.__toks = new Set(Engine.normNome(nome).split(' ').filter(t => t.length > 2));
      list.push(o); exact[Engine.normNome(nome)] = o;
    }
    return { list, exact };
  }
  function coberturaQuantum() {
    const f = fundo(); if (!f || !STATE.quantum) return '—';
    const norm = Engine.normalizarCarteira(f);
    let hit = 0;
    for (const h of norm) if (Engine.casarQuantum(h, STATE.quantum.index)) hit++;
    return pf(norm.length ? hit / norm.length * 100 : 0, 0) + ' (' + hit + '/' + norm.length + ')';
  }
  function mappingTable(q) {
    const labels = { nome: 'Nome', cnpj: 'CNPJ', vol: 'Volatilidade', ret12: 'Retorno 12m', sharpe: 'Sharpe', var: 'VaR', taxaAdm: 'Taxa adm.', cotResg: 'Cotização resg.', classe: 'Classe ANBIMA' };
    let h = `<div class="section-title">Colunas reconhecidas</div><div class="row wrap" style="gap:8px;margin-bottom:16px">`;
    for (const k in labels) {
      const ok = q.cols[k] != null;
      h += `<span class="badge ${ok ? 'badge-ok' : 'badge-muted'}"><span class="dot"></span>${labels[k]}${ok ? ': ' + esc(q.headers[q.cols[k]]) : ' — não encontrada'}</span>`;
    }
    return h + `</div>`;
  }
  function quantumTable(q) {
    const show = ['nome', 'classe', 'ret12', 'vol', 'sharpe', 'var', 'taxaAdm', 'cotResg'];
    const lab = { nome: 'Ativo', classe: 'Classe', ret12: 'Ret 12m', vol: 'Vol a.a.', sharpe: 'Sharpe', var: 'VaR', taxaAdm: 'Taxa adm', cotResg: 'Cotiz.' };
    let h = `<div class="table-wrap"><table class="data"><thead><tr>${show.map(k => `<th class="${k === 'nome' || k === 'classe' ? '' : 'num'}">${lab[k]}</th>`).join('')}</tr></thead><tbody>`;
    q.rows.slice(0, 60).forEach(r => {
      h += `<tr>` + show.map(k => {
        const idx = q.cols[k];
        const v = idx != null ? r[idx] : null;
        if (k === 'nome' || k === 'classe') return `<td>${esc(v || '—')}</td>`;
        const n = parseNumCell(v);
        return `<td class="num">${n == null ? '—' : nf(n, k === 'sharpe' ? 2 : 1)}</td>`;
      }).join('') + `</tr>`;
    });
    return h + `</tbody></table></div>` + (q.rows.length > 60 ? `<div class="small muted" style="padding:10px 14px">Mostrando 60 de ${q.rows.length} linhas.</div>` : '');
  }

  // ============================================================ 3. POLÍTICA
  function renderPolitica() {
    const f = fundo();
    if (!f) return emptyView('view-politica', 'Importe um fundo para configurar a política.');
    const pol = policy();
    const presets = Engine.PRESET_KEYS.map(k => `<option value="${k}" ${pol.chave === k ? 'selected' : ''}>${esc(Engine.PRESETS[k].rotulo)}</option>`).join('');
    const pub = ['VAREJO', 'QUALIFICADO', 'PROFISSIONAL'].map(p => `<button class="${pol.publicoAlvo === p ? 'active' : ''}" data-pub="${p}">${p[0] + p.slice(1).toLowerCase()}</button>`).join('');
    const classes = Object.keys(Object.assign({}, ...Object.entries(Engine.perfil(f, null, null, pol).porClasse).map(([k]) => ({ [k]: 1 }))));
    // garante que todas as classes presentes tenham banda
    Engine.perfil(f, null, null, pol); const P = Engine.perfil(f, null, null, pol);
    for (const c of Object.keys(P.porClasse)) if (!pol.bandas[c]) pol.bandas[c] = [0, 100];

    let html = `<div class="panel"><div class="panel-head"><div class="ph-text"><h2>Política de investimento & perfil</h2>
      <p>Parâmetros do mandato usados no enquadramento. Ajuste conforme o regulamento do fundo. Salvo automaticamente.</p></div>
      <div class="ph-actions"><button class="btn btn-ghost btn-sm" id="pol-reset">Restaurar preset</button></div></div>
      <div class="panel-body">
      <div class="form-grid">
        <div class="field"><label>Classe / preset</label><select class="select" id="pol-preset">${presets}</select><div class="hint">Define pisos de tipificação e limites-base.</div></div>
        <div class="field"><label>Público-alvo</label><div class="segmented" id="pol-pub">${pub}</div><div class="hint">Teto de exterior: varejo 20% · qualificado 40% · profissional 100%.</div></div>
      </div>
      <hr class="divider-rule">
      <div class="section-title">Bandas de alocação por classe (mín / máx do PL)</div>
      <div class="table-wrap"><table class="data"><thead><tr><th>Classe</th><th class="num">Atual</th><th class="num">Mínimo %</th><th class="num">Máximo %</th></tr></thead><tbody>`;
    for (const [c, [mn, mx]] of Object.entries(pol.bandas)) {
      const atual = P.porClasse[c] || 0;
      html += `<tr><td><b>${esc(c)}</b></td><td class="num">${pf(atual)}</td>
        <td class="num"><input class="cell-input" data-band="${esc(c)}" data-edge="0" value="${mn}"></td>
        <td class="num"><input class="cell-input" data-band="${esc(c)}" data-edge="1" value="${mx}"></td></tr>`;
    }
    html += `</tbody></table></div>
      <hr class="divider-rule">
      <div class="section-title">Limites de concentração, liquidez e risco</div>
      <div class="form-grid">
        ${numField('limiteEmissor', 'Limite por emissor (%)', pol.limiteEmissor)}
        ${numField('limiteGrupo', 'Limite por grupo econômico (%)', pol.limiteGrupo)}
        ${numField('maxAtivo', 'Máx. por ativo (%)', pol.maxAtivo)}
        ${numField('top5', 'Máx. Top-5 (%)', pol.top5)}
        ${numField('top10', 'Máx. Top-10 (%)', pol.top10)}
        ${numField('hhiMax', 'HHI máximo', pol.hhiMax, 0.01)}
        ${numField('minPosicoes', 'Mín. de posições', pol.minPosicoes, 1)}
        ${numField('resgateDias', 'Prazo de resgate (D+)', pol.resgateDias, 1)}
        ${numField('lcrD1', 'Liquidez mín. D+1 (%)', pol.lcrD1)}
        ${numField('lcrD5', 'Liquidez mín. D+5 (%)', pol.lcrD5)}
        ${numField('caixaMin', 'Caixa mínimo (%)', pol.caixaMin)}
        ${numField('creditoMax', 'Crédito privado máx. (%)', pol.creditoMax)}
        ${numField('volMax', 'Volatilidade máx. (% a.a.)', pol.volMax)}
        ${numField('varMax', 'VaR 1d 95% máx. (%)', pol.varMax, 0.1)}
      </div></div></div>`;
    $('#view-politica').innerHTML = html;
  }
  const numField = (key, label, val, step) => `<div class="field"><label>${label}</label><input class="input" type="number" step="${step || 1}" data-pol="${key}" value="${val}"></div>`;

  // ============================================================ 4. CENÁRIOS
  function renderCenarios() {
    const f = fundo();
    if (!f) return emptyView('view-cenarios', 'Importe um fundo para montar cenários de alocação.');
    const cs = cenarios(); const cur = cenarioAtual(); const pol = policy();
    let html = `<div class="panel"><div class="panel-head"><div class="ph-text"><h2>Proxy de alocação — cenários</h2>
      <p>Monte alocações alternativas a partir da posição atual e compare o enquadramento de cada uma antes de negociar.</p></div>
      <div class="ph-actions">
        <button class="btn btn-outline btn-sm" data-gen="concentracao">+ Reduzir concentração</button>
        <button class="btn btn-outline btn-sm" data-gen="liquidez">+ Aumentar liquidez</button>
        <button class="btn btn-outline btn-sm" data-gen="bandas">+ Enquadrar bandas</button>
        <button class="btn btn-accent btn-sm" data-gen="custom">+ Cenário em branco</button>
      </div></div><div class="panel-body">
      <div class="row wrap" style="gap:8px">`;
    cs.forEach(c => {
      const on = c.id === cur.id;
      html += `<button class="btn ${on ? 'btn-primary' : 'btn-outline'} btn-sm" data-cen="${c.id}">${esc(c.nome)}${c.base ? '' : ` <span onclick="event.stopPropagation()" data-del="${c.id}" style="margin-left:6px;opacity:.6">✕</span>`}</button>`;
    });
    html += `</div></div></div>`;

    // editor de pesos do cenário ativo
    const norm = Engine.normalizarCarteira(f);
    const pesos = {}; norm.forEach(h => pesos[h.key] = cur.pesos && cur.pesos[h.key] != null ? cur.pesos[h.key] : h.pesoAtual);
    const totalTarget = Object.values(pesos).reduce((s, v) => s + (+v || 0), 0);
    const P0 = Engine.perfil(f, null, STATE.quantum && STATE.quantum.index, pol);
    const P1 = Engine.perfil(f, pesos, STATE.quantum && STATE.quantum.index, pol);

    html += `<div class="cols-2">
      <div class="panel"><div class="panel-head"><div class="ph-text"><h2>${esc(cur.nome)}</h2><p>Ajuste os pesos-alvo (%). Total: <b id="cen-total" class="${Math.abs(totalTarget - 100) > 0.5 ? 'neg' : 'pos'}">${pf(totalTarget)}</b></p></div>
        <div class="ph-actions">${cur.base ? '<span class="pill">posição atual (somente leitura)</span>' : '<button class="btn btn-ghost btn-sm" id="cen-normalizar">Normalizar 100%</button>'}</div></div>
        <div class="panel-body tight"><div class="table-wrap"><table class="data"><thead><tr><th>Ativo</th><th class="num">Atual</th><th class="num">Alvo %</th><th class="num">Δ</th></tr></thead><tbody>`;
    norm.slice().sort((a, b) => (pesos[b.key]) - (pesos[a.key])).forEach(h => {
      const alvo = pesos[h.key]; const d = alvo - h.pesoAtual;
      html += `<tr><td><b>${esc(h.nome)}</b><div class="small muted">${esc(h.classe)} · D+${h.liqDias}</div></td>
        <td class="num">${pf(h.pesoAtual, 2)}</td>
        <td class="num">${cur.base ? pf(alvo, 2) : `<input class="cell-input" data-peso="${h.key}" value="${nf(alvo, 2)}">`}</td>
        <td class="num ${d > 0.01 ? 'pos' : d < -0.01 ? 'neg' : 'muted'}">${d > 0 ? '+' : ''}${nf(d, 2)}</td></tr>`;
    });
    html += `</tbody></table></div></div></div>`;

    // KPIs comparativos + trade list
    html += `<div class="stack">
      <div class="panel"><div class="panel-head"><div class="ph-text"><h2>Impacto do cenário</h2><p>Atual → proposto</p></div></div><div class="panel-body">
        ${cmpRow('Maior emissor', pf(P0.maiorEmissor[1]), pf(P1.maiorEmissor[1]), pol.limiteEmissor, true)}
        ${cmpRow('Top-5', pf(P0.top5), pf(P1.top5), pol.top5, true)}
        ${cmpRow('Máx. ativo', pf(P0.maxAtivo), pf(P1.maxAtivo), pol.maxAtivo, true)}
        ${cmpRow('HHI', nf(P0.hhi, 3), nf(P1.hhi, 3), pol.hhiMax, true)}
        ${cmpRow('Exterior', pf(P0.exteriorPct), pf(P1.exteriorPct), Engine.EXTERIOR_TETO[pol.publicoAlvo] || 100, true)}
        ${cmpRow('Liquidez D+' + pol.resgateDias, pf(P0.liqCum(pol.resgateDias)), pf(P1.liqCum(pol.resgateDias)), 90, false)}
        ${P1.volEst != null ? cmpRow('Volatilidade est.', pf(P0.volEst), pf(P1.volEst), pol.volMax, true) : ''}
      </div></div>
      ${tradeList(f, norm, pesos)}
    </div></div>`;

    $('#view-cenarios').innerHTML = html;
  }
  function cmpRow(label, a, b, lim, lower) {
    return `<div class="scn-metric"><span>${label}</span><b>${a} <span class="muted">→</span> ${b}</b></div>`;
  }
  function tradeList(f, norm, pesos) {
    const pl = f.header.patrimonio || 0;
    const trades = norm.map(h => ({ nome: h.nome, d: (pesos[h.key] - h.pesoAtual), rs: (pesos[h.key] - h.pesoAtual) / 100 * pl }))
      .filter(t => Math.abs(t.d) > 0.01).sort((a, b) => Math.abs(b.rs) - Math.abs(a.rs));
    if (!trades.length) return `<div class="panel"><div class="panel-body"><div class="empty-state"><div class="es-ico">≡</div><h3>Sem ordens</h3><div class="small">O cenário é idêntico à posição atual.</div></div></div></div>`;
    let h = `<div class="panel"><div class="panel-head"><div class="ph-text"><h2>Ordens do pré-trade</h2><p>${trades.length} movimentações para atingir o cenário</p></div></div><div class="panel-body tight"><div class="table-wrap"><table class="data"><thead><tr><th>Ativo</th><th>Operação</th><th class="num">Δ %PL</th><th class="num">Financeiro</th></tr></thead><tbody>`;
    trades.forEach(t => {
      h += `<tr><td><b>${esc(t.nome)}</b></td><td><span class="badge ${t.d > 0 ? 'badge-ok' : 'badge-block'}"><span class="dot"></span>${t.d > 0 ? 'COMPRA' : 'VENDA'}</span></td>
        <td class="num ${t.d > 0 ? 'pos' : 'neg'}">${t.d > 0 ? '+' : ''}${nf(t.d, 2)}%</td><td class="num">${money(Math.abs(t.rs))}</td></tr>`;
    });
    return h + `</tbody></table></div></div></div>`;
  }

  // ============================================================ 5. PRÉ-TRADE
  function runEngineActive(pesos) {
    const f = fundo(); if (!f) return null;
    return Engine.avaliar(f, pesos !== undefined ? pesos : cenarioPesos(cenarioAtual(), f), STATE.quantum && STATE.quantum.index, policy());
  }
  function cenarioPesos(c, f) {
    if (!c || c.base) return null;
    return c.pesos;
  }
  function renderPretrade() {
    const f = fundo();
    if (!f) return emptyView('view-pretrade', 'Importe um fundo para rodar o pré-trade.');
    const pol = policy(); const cur = cenarioAtual();
    const R = runEngineActive();
    const chk = STATE.checklist[f.header.fundo] || (STATE.checklist[f.header.fundo] = {});
    const cf = R.resumo;
    const veredito = cf.bloqueio ? 'block' : (cf.alerta ? 'warn' : 'ok');
    const vtxt = cf.bloqueio ? `${cf.bloqueio} bloqueio(s) — não liberar` : (cf.alerta ? `${cf.alerta} alerta(s) — revisar` : 'Enquadrado — sem violações');

    let html = `<div class="panel"><div class="panel-head"><div class="ph-text"><h2>Parecer de pré-trade</h2>
      <p>${esc(f.header.fundo)} · cenário <b>${esc(cur.nome)}</b> · ${esc(Engine.PRESETS[pol.chave].rotulo)} · ${(pol.publicoAlvo || '').toLowerCase()}</p></div>
      <div class="ph-actions">
        <select class="select" id="pt-cenario" style="width:auto">${cenarios().map(c => `<option value="${c.id}" ${c.id === cur.id ? 'selected' : ''}>${esc(c.nome)}</option>`).join('')}</select>
        <button class="btn btn-outline btn-sm" id="pt-print">Imprimir / PDF</button>
      </div></div><div class="panel-body">
      <div class="notice notice-${veredito}" style="margin-bottom:16px"><span class="n-ico">${veredito === 'block' ? '⛔' : veredito === 'warn' ? '⚠' : '✓'}</span>
        <div><b>${vtxt}.</b> ${cf.ok} conforme · ${cf.alerta} alerta · ${cf.bloqueio} bloqueio · ${cf.na} sem dados. O parecer considera a checagem automática e a atestação do checklist procedural.</div></div>
      <div class="kpi-grid">
        ${kpi('Conforme', cf.ok, 'regras OK')}
        ${kpi('Alertas', cf.alerta, 'revisar', cf.alerta > 0)}
        ${kpi('Bloqueios', cf.bloqueio, 'impeditivos', cf.bloqueio > 0)}
        ${kpi('Sem dados', cf.na, 'requer input')}
      </div></div></div>`;

    // resultados por categoria
    const cats = {};
    R.resultados.forEach(r => { (cats[r.categoria] = cats[r.categoria] || []).push(r); });
    for (const cat in cats) {
      html += `<div class="panel"><div class="panel-head"><div class="ph-text"><h2>${esc(cat)}</h2></div>
        <div class="ph-actions">${catBadges(cats[cat])}</div></div><div class="panel-body tight">`;
      cats[cat].forEach(r => {
        const b = statusBadge(r.status);
        html += `<div class="rule-row"><div class="r-status">${b}</div>
          <div class="r-main"><div class="r-name">${esc(r.nome)}</div><div class="r-desc">${esc(r.msg)}</div><div class="r-src">${esc(r.fonte)}</div></div>
          <div class="r-value"><div class="rv-actual">${esc(r.atual)}</div><div class="rv-limit">${esc(r.limite)}</div></div></div>`;
      });
      html += `</div></div>`;
    }

    // checklist procedural
    html += `<div class="panel"><div class="panel-head"><div class="ph-text"><h2>Checklist procedural</h2><p>Verificações que exigem atestação humana (contrato, suitability, KYC, melhor execução)</p></div></div><div class="panel-body tight">`;
    Engine.CHECKLIST.forEach(c => {
      const on = !!chk[c.id];
      html += `<div class="rule-row"><div class="r-status"><input type="checkbox" data-chk="${c.id}" ${on ? 'checked' : ''} style="width:20px;height:20px;accent-color:var(--purple)"></div>
        <div class="r-main"><div class="r-name">${esc(c.nome)}</div><div class="r-src">${esc(c.fonte)}</div></div>
        <div class="r-value">${on ? '<span class="badge badge-ok"><span class="dot"></span>Atestado</span>' : '<span class="badge badge-muted"><span class="dot"></span>Pendente</span>'}</div></div>`;
    });
    html += `</div></div>`;

    // comparação de cenários
    if (cenarios().length > 1) html += cenarioComparacao(f, pol);
    // referência completa
    html += ruleReference();
    $('#view-pretrade').innerHTML = html;
  }
  function statusBadge(s) {
    if (s === 'ok') return `<span class="badge badge-ok"><span class="dot"></span>OK</span>`;
    if (s === 'alerta') return `<span class="badge badge-warn"><span class="dot"></span>Alerta</span>`;
    if (s === 'bloqueio') return `<span class="badge badge-block"><span class="dot"></span>Bloqueio</span>`;
    return `<span class="badge badge-muted"><span class="dot"></span>Sem dados</span>`;
  }
  function catBadges(rs) {
    const c = { ok: 0, alerta: 0, bloqueio: 0, na: 0 }; rs.forEach(r => c[r.status]++);
    let h = '';
    if (c.bloqueio) h += `<span class="badge badge-block">${c.bloqueio} bloqueio</span> `;
    if (c.alerta) h += `<span class="badge badge-warn">${c.alerta} alerta</span> `;
    if (c.ok) h += `<span class="badge badge-ok">${c.ok} ok</span>`;
    return h;
  }
  function cenarioComparacao(f, pol) {
    const cs = cenarios();
    let h = `<div class="panel"><div class="panel-head"><div class="ph-text"><h2>Comparação de cenários</h2><p>Enquadramento e KPIs lado a lado</p></div></div><div class="panel-body tight"><div class="table-wrap"><table class="data"><thead><tr><th>Cenário</th><th class="num">Bloqueios</th><th class="num">Alertas</th><th class="num">Maior emissor</th><th class="num">Top-5</th><th class="num">HHI</th><th class="num">Liq. D+${pol.resgateDias}</th>${STATE.quantum ? '<th class="num">Vol est.</th>' : ''}</tr></thead><tbody>`;
    cs.forEach(c => {
      const pesos = c.base ? null : c.pesos;
      const R = Engine.avaliar(f, pesos, STATE.quantum && STATE.quantum.index, pol);
      const P = R.perfil;
      h += `<tr><td><b>${esc(c.nome)}</b></td>
        <td class="num ${R.resumo.bloqueio ? 'neg' : 'pos'}">${R.resumo.bloqueio}</td>
        <td class="num">${R.resumo.alerta}</td>
        <td class="num">${pf(P.maiorEmissor[1])}</td><td class="num">${pf(P.top5)}</td><td class="num">${nf(P.hhi, 3)}</td>
        <td class="num">${pf(P.liqCum(pol.resgateDias))}</td>${STATE.quantum ? `<td class="num">${P.volEst != null ? pf(P.volEst) : '—'}</td>` : ''}</tr>`;
    });
    return h + `</tbody></table></div></div></div>`;
  }
  function ruleReference() {
    const R = typeof RULE_REFERENCE !== 'undefined' ? RULE_REFERENCE : [];
    let h = `<div class="panel"><div class="panel-head"><div class="ph-text"><h2>Catálogo regulatório de referência</h2><p>${R.length} regras de pré-trade mapeadas (ANBIMA · CVM 175). As checagens automáticas acima cobrem os itens quantificáveis a partir dos dados importados.</p></div></div><div class="panel-body tight"><div class="table-wrap"><table class="data"><thead><tr><th>Regra</th><th>Categoria</th><th>Severidade</th><th>Limite padrão</th><th>Fonte</th></tr></thead><tbody>`;
    R.forEach(r => {
      h += `<tr><td><b>${esc(r.name)}</b></td><td class="small">${esc(r.category)}</td>
        <td>${r.severity === 'bloqueante' ? '<span class="badge badge-block">bloqueante</span>' : r.severity === 'alerta' ? '<span class="badge badge-warn">alerta</span>' : '<span class="badge badge-muted">info</span>'}</td>
        <td class="small">${esc(r.defaultThreshold || '—')}</td><td class="small muted">${esc(r.regulatorySource || '')}</td></tr>`;
    });
    return h + `</tbody></table></div></div></div>`;
  }

  function emptyView(id, msg) {
    $('#' + id).innerHTML = `<div class="panel"><div class="panel-body"><div class="empty-state"><div class="es-ico">◔</div><h3>${esc(msg)}</h3>
      <div style="margin-top:12px"><button class="btn btn-primary btn-sm" data-step="input">Ir para importação</button></div></div></div></div>`;
  }

  // ============================================================ ARQUIVOS
  async function handlePdfFiles(files) {
    for (const file of files) {
      try {
        const buf = await file.arrayBuffer();
        const fund = await AcompFI.parse(pdfjsLib, new Uint8Array(buf));
        if (!fund.header.fundo) { toast('Não reconheci o formato de ' + file.name, 'err'); continue; }
        fund.__srcName = file.name;
        const ix = STATE.fundos.findIndex(x => x.header.fundo === fund.header.fundo);
        if (ix >= 0) STATE.fundos[ix] = fund; else STATE.fundos.push(fund);
        STATE.fundoAtivo = fund.header.fundo;
        toast(`${fund.header.fundo} importado (${fund.formato === 'bradesco' ? 'Bradesco' : 'BTG'}, ${fund.carteira.length} ativos)`, 'ok');
      } catch (e) { console.error(e); toast('Erro ao ler ' + file.name + ': ' + e.message, 'err'); }
    }
    renderStepper(); rerenderActive();
  }

  async function handleXlsx(files) {
    const file = files[0]; if (!file) return;
    try {
      const buf = await file.arrayBuffer();
      const wb = XLSX.read(buf, { type: 'array' });
      const ws = wb.Sheets[wb.SheetNames[0]];
      const aoa = XLSX.utils.sheet_to_json(ws, { header: 1, defval: null, raw: true });
      // localiza a linha de cabeçalho (a que tem mais texto)
      let hi = 0, best = 0;
      for (let i = 0; i < Math.min(15, aoa.length); i++) {
        const txt = aoa[i].filter(c => typeof c === 'string' && c.trim().length > 1).length;
        if (txt > best) { best = txt; hi = i; }
      }
      const headers = (aoa[hi] || []).map(h => String(h == null ? '' : h).trim());
      const rows = aoa.slice(hi + 1).filter(r => r.some(c => c != null && c !== ''));
      const cols = detectCols(headers);
      const index = buildQuantumIndex(rows, cols);
      STATE.quantum = { rows, headers, cols, index };
      toast(`Planilha importada: ${rows.length} linhas, ${Object.values(cols).filter(v => v != null).length} colunas reconhecidas`, 'ok');
    } catch (e) { console.error(e); toast('Erro ao ler planilha: ' + e.message, 'err'); }
    renderStepper(); rerenderActive();
  }

  function baixarModeloQuantum() {
    const cols = (typeof QUANTUM_COLUMNS !== 'undefined' ? QUANTUM_COLUMNS : []).map(c => c.column);
    const header = cols.join(';');
    const exemplo = cols.map(c => /Nome|Fundo/.test(c) ? 'FUNDO EXEMPLO FIC FIM' : /CNPJ/.test(c) ? '00.000.000/0001-00' : /Volatil/.test(c) ? '12,5' : /Sharpe/.test(c) ? '0,85' : '').join(';');
    const csv = '﻿' + header + '\n' + exemplo + '\n';
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = 'modelo_quantum_axis.csv'; a.click();
  }

  // ---------------------------------------------------- geradores de cenário
  function novoId() { return 'c' + (cenarios().length) + '_' + Math.round(cenarios().reduce((s, c) => s + c.nome.length, 1) * 7 % 9973); }
  function addCenario(nome, pesos) {
    const cs = cenarios();
    const c = { id: novoId(), nome, pesos, base: false };
    cs.push(c); STATE.cenarioAtivo[fundo().header.fundo] = c.id;
    return c;
  }
  function gerarCenario(tipo) {
    const f = fundo(); const pol = policy();
    const norm = Engine.normalizarCarteira(f);
    const base = {}; norm.forEach(h => base[h.key] = h.pesoAtual);
    if (tipo === 'custom') { addCenario('Cenário ' + (cenarios().length), Object.assign({}, base)); rerenderActive(); return; }
    const pesos = Object.assign({}, base);
    if (tipo === 'concentracao') {
      // corta ativos acima do limite e redistribui para os líquidos abaixo do teto
      let excesso = 0;
      norm.forEach(h => { if (pesos[h.key] > pol.maxAtivo) { excesso += pesos[h.key] - pol.maxAtivo; pesos[h.key] = pol.maxAtivo; } });
      const alvos = norm.filter(h => pesos[h.key] < pol.maxAtivo && h.liqDias <= pol.resgateDias);
      const somaAlvo = alvos.reduce((s, h) => s + pesos[h.key], 0) || 1;
      alvos.forEach(h => pesos[h.key] += excesso * (pesos[h.key] / somaAlvo));
      addCenario('Menos concentrado', pesos);
    } else if (tipo === 'liquidez') {
      // move parte dos ilíquidos para os mais líquidos
      const iliq = norm.filter(h => h.liqDias > pol.resgateDias);
      const liq = norm.filter(h => h.liqDias <= 5);
      let movido = 0;
      iliq.forEach(h => { const corte = pesos[h.key] * 0.4; pesos[h.key] -= corte; movido += corte; });
      const somaLiq = liq.reduce((s, h) => s + pesos[h.key], 0) || 1;
      (liq.length ? liq : norm).forEach(h => pesos[h.key] += movido * (pesos[h.key] / somaLiq));
      addCenario('Mais líquido', pesos);
    } else if (tipo === 'bandas') {
      // aproxima cada classe do ponto médio da banda
      const P = Engine.perfil(f, null, null, pol);
      const fator = {};
      for (const [c, [mn, mx]] of Object.entries(pol.bandas)) {
        const atual = P.porClasse[c] || 0; const alvo = Math.min(mx, Math.max(mn, (mn + mx) / 2));
        fator[c] = atual > 0 ? alvo / atual : 1;
      }
      norm.forEach(h => { const fa = fator[h.classe]; if (fa) pesos[h.key] *= fa; });
      const tot = Object.values(pesos).reduce((s, v) => s + v, 0) || 1;
      norm.forEach(h => pesos[h.key] = pesos[h.key] / tot * 100);
      addCenario('Enquadrado nas bandas', pesos);
    }
    rerenderActive();
  }

  // ---------------------------------------------------- dados de exemplo
  function carregarExemplo() {
    // fundo sintético (fictício) — demonstra o fluxo sem dados reais
    const cart = [
      ['ALFA LONG BIASED FIC FIA', 'Renda Variável', 'FUNDOS', 'Long Biased', 14.2, 'D+32', 'ALFA GESTORA'],
      ['BETA IBOV ATIVO FIA', 'Renda Variável', 'FUNDOS', 'Long Only', 11.8, 'D+30', 'BETA ASSET'],
      ['GAMA SMALL CAPS FIC FIA', 'Renda Variável', 'FUNDOS', 'Long Only', 9.6, 'D+45', 'GAMA CAPITAL'],
      ['SMAL11', 'Renda Variável', 'AÇÕES', '', 8.9, 'D+2', 'ISHARES SMALL CAP'],
      ['BOVA11', 'Renda Variável', 'AÇÕES', '', 7.4, 'D+2', 'ISHARES IBOVESPA'],
      ['DELTA MACRO FIC FIM', 'Retorno Absoluto', 'FUNDOS', 'Macro', 9.1, 'D+31', 'DELTA INVEST'],
      ['EPSILON EQ HEDGE FIM', 'Retorno Absoluto', 'FUNDOS', 'Equity Hedge', 6.8, 'D+30', 'EPSILON GEST'],
      ['ZETA GLOBAL IE FIC FIA', 'Renda Variável', 'FUNDOS', 'Investimento no Exterior', 8.3, 'D+5', 'ZETA GLOBAL'],
      ['TESOURO SELIC LFT', 'Renda Fixa', 'COMPROMISSADA', '', 9.2, 'D+0', 'TESOURO NACIONAL'],
      ['BTG TESOURO RF FIC', 'Renda Fixa', 'FUNDOS', 'Pós-Fixado', 6.5, 'D+0', 'BTG PACTUAL AM'],
      ['Outros (a pagar/receber)', 'Outros', '—', '', -1.8, 'D+0', ''],
    ];
    const total = cart.reduce((s, r) => s + r[4], 0);
    const carteira = cart.map(r => ({ nome: r[0], classe: r[1], subclasse: r[2], subclasseAtivo: r[6] && r[1].includes('Variável') ? r[3] : r[3], pct: r[4], financeiro: r[4] / 100 * 320000000, liquidezVenc: r[5], emissorGestor: r[6] }));
    const porClasse = {}; carteira.forEach(h => porClasse[h.classe] = (porClasse[h.classe] || 0) + h.pct);
    const fund = {
      formato: 'btg', __srcName: 'exemplo',
      header: { fundo: 'EXEMPLO MULTI ESTRATÉGIA FIC FIA', geradoEm: null, cotaData: '31/07/2026', cota: 2.418734, patrimonio: 320000000 },
      alocacaoClasse: Object.entries(porClasse).map(([classe, pct]) => ({ classe, pct: Math.round(pct * 100) / 100, valor: pct / 100 * 320000000 })),
      alocacaoSubclasse: [], liquidez: [
        { faixa: 'D+0', pct: 13.9, financeiro: 44480000, acumPct: 13.9 }, { faixa: 'D+1', pct: 0, financeiro: 0, acumPct: 13.9 },
        { faixa: 'D+2 a D+15', pct: 24.6, financeiro: 78720000, acumPct: 38.5 }, { faixa: 'D+16 a D+35', pct: 35.7, financeiro: 114240000, acumPct: 74.2 },
        { faixa: 'D+36 a D+65', pct: 15.6, financeiro: 49920000, acumPct: 89.8 }, { faixa: 'D+66 a D+1450', pct: 10.2, financeiro: 32640000, acumPct: 100 }, { faixa: 'D>1450', pct: 0, financeiro: 0, acumPct: 100 },
      ],
      concentracao: Object.values(carteira.reduce((m, h) => { const k = h.emissorGestor || h.nome; if (k) m[k] = { nome: k, pct: (m[k] ? m[k].pct : 0) + h.pct }; return m; }, {})).sort((a, b) => b.pct - a.pct),
      carteira, diagnostico: { holdings: carteira.length, somaPctPL: 100, classes: Object.keys(porClasse).length, formato: 'btg' },
    };
    const ix = STATE.fundos.findIndex(x => x.header.fundo === fund.header.fundo);
    if (ix >= 0) STATE.fundos[ix] = fund; else STATE.fundos.push(fund);
    STATE.fundoAtivo = fund.header.fundo;
    toast('Exemplo carregado (fundo fictício)', 'ok');
    renderStepper(); rerenderActive();
  }

  function carregarQuantumExemplo() {
    const headers = ['Nome do Fundo', 'CNPJ', 'Classificação ANBIMA', 'Retorno 12M', 'Volatilidade', 'Índice de Sharpe', 'VaR', 'Taxa de Administração', 'Cotização de Resgate (D+)'];
    const nomes = ['ALFA LONG BIASED FIC FIA', 'BETA IBOV ATIVO FIA', 'GAMA SMALL CAPS FIC FIA', 'DELTA MACRO FIC FIM', 'EPSILON EQ HEDGE FIM', 'ZETA GLOBAL IE FIC FIA', 'BTG TESOURO RF FIC'];
    const rows = nomes.map((n, i) => [n, '', i < 5 ? 'Ações' : (i === 5 ? 'Ações Ext.' : 'RF'), (8 + i * 3.2).toFixed(1).replace('.', ','), (10 + i * 2.4).toFixed(1).replace('.', ','), (0.6 + i * 0.12).toFixed(2).replace('.', ','), (0.9 + i * 0.3).toFixed(1).replace('.', ','), (0.8 + i * 0.15).toFixed(2).replace('.', ','), i < 5 ? '30' : '1']);
    const cols = detectCols(headers);
    STATE.quantum = { rows, headers, cols, index: buildQuantumIndex(rows, cols) };
    toast('Métricas de exemplo carregadas', 'ok');
    renderStepper(); rerenderActive();
  }

  // ============================================================ DROPZONE / EVENTOS
  function wireDropzone(id, cb) {
    const dz = document.getElementById(id); if (!dz) return;
    dz.addEventListener('click', () => { const inp = id.includes('pdf') ? $('#file-pdf') : $('#file-xlsx'); if (inp) inp.click(); });
    ['dragover', 'dragenter'].forEach(ev => dz.addEventListener(ev, e => { e.preventDefault(); dz.classList.add('drag'); }));
    ['dragleave', 'drop'].forEach(ev => dz.addEventListener(ev, e => { e.preventDefault(); dz.classList.remove('drag'); }));
    dz.addEventListener('drop', e => { if (e.dataTransfer.files.length) cb(Array.from(e.dataTransfer.files)); });
  }

  document.addEventListener('click', (e) => {
    const t = e.target.closest('[data-step],[data-fundo],[data-cen],[data-del],[data-gen],[data-pub],#btn-exemplo,#q-exemplo,#q-modelo,#go-pretrade,#pol-reset,#cen-normalizar,#pt-print');
    if (!t) return;
    if (t.dataset.step) return go(t.dataset.step);
    if (t.id === 'go-pretrade') return go('pretrade');
    if (t.id === 'btn-exemplo') return carregarExemplo();
    if (t.id === 'q-exemplo') return carregarQuantumExemplo();
    if (t.id === 'q-modelo') return baixarModeloQuantum();
    if (t.id === 'pt-print') return window.print();
    if (t.dataset.fundo) { STATE.fundoAtivo = t.dataset.fundo; renderStepper(); rerenderActive(); return; }
    if (t.dataset.del) { const cs = cenarios(); const i = cs.findIndex(c => c.id === t.dataset.del); if (i >= 0) cs.splice(i, 1); STATE.cenarioAtivo[fundo().header.fundo] = 'atual'; rerenderActive(); return; }
    if (t.dataset.cen) { STATE.cenarioAtivo[fundo().header.fundo] = t.dataset.cen; rerenderActive(); return; }
    if (t.dataset.gen) return gerarCenario(t.dataset.gen);
    if (t.dataset.pub) { policy().publicoAlvo = t.dataset.pub; persist(); rerenderActive(); return; }
    if (t.id === 'pol-reset') { const f = fundo(); const p = Engine.presetPara(f.header.fundo); p.publicoAlvo = policy().publicoAlvo; STATE.politicas[f.header.fundo] = p; persist(); rerenderActive(); return; }
    if (t.id === 'cen-normalizar') return normalizarCenario();
  });

  document.addEventListener('change', (e) => {
    const t = e.target;
    if (t.id === 'file-pdf') { if (t.files.length) handlePdfFiles(Array.from(t.files)); t.value = ''; }
    else if (t.id === 'file-xlsx') { if (t.files.length) handleXlsx(Array.from(t.files)); t.value = ''; }
    else if (t.id === 'pol-preset') { const f = fundo(); const keep = policy().publicoAlvo; const p = { chave: t.value, ...JSON.parse(JSON.stringify(Engine.PRESETS[t.value])) }; p.publicoAlvo = keep; STATE.politicas[f.header.fundo] = p; persist(); rerenderActive(); }
    else if (t.id === 'pt-cenario') { STATE.cenarioAtivo[fundo().header.fundo] = t.value; rerenderActive(); }
    else if (t.dataset && t.dataset.chk) { const f = fundo(); (STATE.checklist[f.header.fundo] = STATE.checklist[f.header.fundo] || {})[t.dataset.chk] = t.checked; persist(); renderPretrade(); }
    else if (t.dataset && t.dataset.pol) { const v = parseFloat(String(t.value).replace(',', '.')); if (!isNaN(v)) policy()[t.dataset.pol] = v; persist(); }
    else if (t.dataset && t.dataset.band != null) { const v = parseFloat(String(t.value).replace(',', '.')); if (!isNaN(v)) policy().bandas[t.dataset.band][+t.dataset.edge] = v; persist(); }
  });

  // edição de pesos do cenário (input em tempo real)
  document.addEventListener('input', (e) => {
    const t = e.target;
    if (t.dataset && t.dataset.peso != null) {
      const c = cenarioAtual(); if (!c || c.base) return;
      const v = parseFloat(String(t.value).replace(',', '.'));
      if (!c.pesos) c.pesos = {};
      const f = fundo(); Engine.normalizarCarteira(f).forEach(h => { if (c.pesos[h.key] == null) c.pesos[h.key] = h.pesoAtual; });
      c.pesos[t.dataset.peso] = isNaN(v) ? 0 : v;
      const tot = Object.values(c.pesos).reduce((s, x) => s + (+x || 0), 0);
      const el = $('#cen-total'); if (el) { el.textContent = pf(tot); el.className = Math.abs(tot - 100) > 0.5 ? 'neg' : 'pos'; }
    }
  });
  function normalizarCenario() {
    const c = cenarioAtual(); if (!c || c.base) return;
    const f = fundo(); const norm = Engine.normalizarCarteira(f);
    if (!c.pesos) { c.pesos = {}; norm.forEach(h => c.pesos[h.key] = h.pesoAtual); }
    const tot = Object.values(c.pesos).reduce((s, x) => s + (+x || 0), 0) || 1;
    Object.keys(c.pesos).forEach(k => c.pesos[k] = c.pesos[k] / tot * 100);
    rerenderActive();
  }

  // ============================================================ INIT
  function init() { setupPdfWorker(); restore(); renderStepper(); go('input'); }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
})();
