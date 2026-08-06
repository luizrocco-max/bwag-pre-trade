/* ============================================================================
   parser.js — Parser do "Relatório de Performance Diário" (AcompFI) do BTG.

   Baseado em coordenadas (itens de texto do pdf.js -> linhas -> seções).
   Validado contra os relatórios reais de MAITACA, CAVALIER e FALCÃO-PEREGRINO.

   Uso (browser):  AcompFI.parse(pdfjsLib, arrayBuffer) -> Promise<Fundo>
   Uso (Node):     require('./src/parser.js') expõe as mesmas funções.
   ==========================================================================*/
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.AcompFI = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const NUM = /^-?[\d.,]+%?$/;
  const isNum = (t) => NUM.test(t) && /\d/.test(t);
  function toNum(s) {
    if (s == null) return null;
    s = String(s).trim().replace('%', '');
    if (s === '' || s === '-' || s === '--') return null;
    s = s.replace(/,/g, '');                 // formato US do relatório: vírgula=milhar
    const v = parseFloat(s);
    return isNaN(v) ? null : v;
  }

  // agrupa itens {x,y,s} em linhas por proximidade de y
  function linesOf(items, ytol) {
    ytol = ytol || 3;
    const arr = items.slice().sort((a, b) => a.y - b.y || a.x - b.x);
    const lines = [];
    for (const w of arr) {
      let ln = null;
      for (const l of lines) if (Math.abs(l.y - w.y) <= ytol) { ln = l; break; }
      if (!ln) { ln = { y: w.y, items: [] }; lines.push(ln); }
      ln.items.push(w); ln.y = (ln.y + w.y) / 2;
    }
    for (const l of lines) { l.items.sort((a, b) => a.x - b.x); l.text = l.items.map(i => i.s).join(' '); }
    lines.sort((a, b) => a.y - b.y);
    return lines;
  }
  const tokAt = (items, xmin, xmax, wantNum) => {
    for (const it of items) if (it.x >= xmin && it.x <= xmax) {
      if (wantNum == null || isNum(it.s) === wantNum) return it;
    }
    return null;
  };
  const joinRange = (items, xmin, xmax) =>
    items.filter(i => i.x >= xmin && i.x <= xmax).map(i => i.s).join(' ').trim();
  const clean = (s) => (s || '').replace(/\s+/g, ' ').trim().replace(/\s*\.\s*$/, '').trim();

  // ------------------------------------------------------------- header
  function parseHeader(page1) {
    const lines = linesOf(page1);
    const h = { fundo: null, geradoEm: null, cotaData: null, cota: null, patrimonio: null };
    // nome do fundo = 2ª linha de texto (logo abaixo do título do relatório)
    if (lines[1]) h.fundo = clean(lines[1].text);
    for (const ln of lines) {
      const t = ln.text;
      let m = t.match(/Data da gera[çc][ãa]o do relat[óo]rio:\s*([\d/]+\s*-\s*[\d:]+)/);
      if (m) h.geradoEm = m[1].trim();
      m = t.match(/Valor da Cota\s+em\s*([\d/]+)/);
      if (m) h.cotaData = m[1];
    }
    // valores de Patrimônio (esq) e Cota (dir) ficam na linha logo abaixo dos rótulos:
    // procura a linha que tem "R$" à esquerda (x<150) e outro número à direita
    for (const ln of lines) {
      const rsLeft = tokAt(ln.items, 15, 60, false);
      const nLeft = tokAt(ln.items, 25, 150, true);
      if (rsLeft && rsLeft.s === 'R$' && nLeft && h.patrimonio == null) {
        h.patrimonio = toNum(nLeft.s);
        const nRight = tokAt(ln.items, 305, 420, true);
        if (nRight) h.cota = toNum(nRight.s);
        break;
      }
    }
    return h;
  }

  // ------------------------------------------------------------- liquidez
  const LIQ = ['D+0', 'D+1', 'D+2 a D+15', 'D+16 a D+35', 'D+36 a D+65', 'D+66 a D+1450',
    'D>1450', 'Total de fundos', 'Total ativos', 'Outros', 'Total geral'];
  function parseLiquidez(page2) {
    const out = [];
    for (const ln of linesOf(page2)) {
      for (const b of LIQ) {
        if (ln.text === b || ln.text.startsWith(b + ' ')) {
          const it = ln.items;
          const g = (a, c, n) => { const t = tokAt(it, a, c, true); return t ? toNum(t.s) : null; };
          out.push({ faixa: b, pct: g(88, 108), financeiro: g(118, 165), acumPct: g(188, 210), acumFin: g(230, 275) });
          break;
        }
      }
      if (ln.text.startsWith('Total geral')) break;
    }
    return out;
  }

  // --------------------------------------------------------- alocação classe
  function parseClasse(page2) {
    const lines = linesOf(page2); let on = false; const out = [];
    for (const ln of lines) {
      if (ln.text.indexOf('Alocação por Classe') >= 0) { on = true; continue; }
      if (!on) continue;
      if (ln.text.indexOf('Alocação por Gestor') >= 0) break;
      const pct = tokAt(ln.items, 30, 70, true);
      const rs = tokAt(ln.items, 205, 225, false);
      const val = tokAt(ln.items, 230, 275, true);
      const name = joinRange(ln.items, 72, 200);
      if (pct && rs && rs.s === 'R$' && name && name.toUpperCase() !== 'TOTAL')
        out.push({ classe: clean(name), pct: toNum(pct.s), valor: val ? toNum(val.s) : null });
    }
    return out;
  }

  // ------------------------------------------------------ alocação subclasse
  function parseSubclasse(page2) {
    const txt = page2.map(i => i.s).join(' ');
    const seen = {};
    const re = /([A-Za-zÀ-ÿ][A-Za-zÀ-ÿ /-]+?):\s*(\d+(?:\.\d+)?)%/g; let m;
    while ((m = re.exec(txt))) seen[m[1].replace(/\s+/g, ' ').trim()] = toNum(m[2]);
    return Object.keys(seen).map(k => ({ subclasse: k, pct: seen[k] }));
  }

  // -------------------------------------------- concentração gestor|emissor
  function parseConcentracao(page2) {
    const lines = linesOf(page2); let on = false; const c1 = [], c2 = [];
    for (const ln of lines) {
      if (ln.text.indexOf('Alocação por Gestor') >= 0) { on = true; continue; }
      if (!on || ln.y > 780) continue;
      for (const it of ln.items) {
        if (it.x >= 195 && it.x <= 335) c1.push(it);
        else if (it.x >= 390 && it.x <= 530) c2.push(it);
      }
    }
    const build = (col, xval) => linesOf(col, 4).map(ln => {
      let val = null; const names = [];
      for (const it of ln.items) { if (it.x >= xval && isNum(it.s)) val = toNum(it.s); else names.push(it.s); }
      const name = clean(names.join(' '));
      return (name && name !== '%PL' && val != null) ? { nome: name, pct: val } : null;
    }).filter(Boolean);
    return build(c1, 318).concat(build(c2, 512));
  }

  // ------------------------------------------------------------- carteira
  const SECTION = /^(Renda Fixa|Renda Variável|Retorno Absoluto|Moeda|Multimercado|Outros|Caixa|Derivativos|Cambial|Proteção)\s*:?\s*(.*)$/;
  const STOP = new Set(['Subclasse', 'Gestor', 'Emissor', 'Financeiro', 'Rentabilidade', 'Carteira',
    'Quantidade', 'Valor', 'Vencimento', 'Liquidez', 'Indexador', 'Preço', 'Meses', 'Aquisição',
    'Cotas', 'Volta', 'Dia', 'Mês', 'Ano', 'Vol.', 'Desde', 'Outros']);
  const skipTok = (t) => isNum(t) || /[|%$]|R\$/.test(t) || STOP.has(t);
  const DIRECT = new Set(['AÇÕES', 'ACOES', 'COMPROMISSADA', 'TÍTULOS PÚBLICOS', 'TITULOS PUBLICOS',
    'DEBÊNTURES', 'DEBENTURES', 'CRI', 'CRA', 'TÍTULOS PRIVADOS']);
  function parseCarteira(pages) {
    const holdings = [];
    let cur = { classe: null, subclasse: null };
    for (let pi = 2; pi < pages.length; pi++) {
      const lines = linesOf(pages[pi]);
      const anchors = [], events = [];
      for (const ln of lines) {
        if (ln.y < 90 || ln.y > 788) continue;
        const first = ln.items[0];
        if (!first || first.x < 15 || first.x > 24) continue;
        const m = ln.text.match(SECTION);
        if (m && /\|\s*R\$/.test(ln.text)) {
          const sub = m[2].split(/\d/)[0].trim() || null;
          cur = { classe: m[1], subclasse: sub };
          events.push(ln.y); continue;
        }
        const pct = tokAt(ln.items, 100, 112, true);
        const fin = tokAt(ln.items, 118, 158, true);
        const name = joinRange(ln.items, 15, 98);
        if (pct && fin && name && name.indexOf('Em atendimento') !== 0) {
          const liq = tokAt(ln.items, 160, 205, null);
          anchors.push({ y: ln.y, nome: clean(name), pct: toNum(pct.s), financeiro: toNum(fin.s),
            liquidezVenc: liq ? liq.s : null, classe: cur.classe, subclasse: cur.subclasse });
          events.push(ln.y);
        }
      }
      const evs = events.slice().sort((a, b) => a - b);
      for (const a of anchors) {
        const nxt = evs.find(y => y > a.y + 1) || 788;
        const direct = DIRECT.has((a.subclasse || '').toUpperCase());
        const names = [], sub = [];
        for (const ln of lines) {
          if (ln.y >= a.y - 7 && ln.y < nxt - 7) {
            for (const it of ln.items) {
              const t = it.s;
              if (skipTok(t) || ['CDI', 'IBOV', 'IPCA', '% CDI', '% IBOV', '% IPCA'].indexOf(t) >= 0) continue;
              if (direct) { if (it.x >= 485 && it.x <= 586) names.push(it); }
              else { if (it.x >= 485 && it.x < 546) names.push(it); else if (it.x >= 546 && it.x <= 586) sub.push(t); }
            }
          }
        }
        names.sort((p, q) => p.y - q.y || p.x - q.x);
        a.emissorGestor = clean(names.map(i => i.s).join(' ')) || null;
        a.subclasseAtivo = clean(sub.join(' ')) || null;
        holdings.push(a);
      }
    }
    return holdings;
  }

  // =====================================================================
  //  BRADESCO — "Carteira Diária" (formato tabular, números pt-BR)
  // =====================================================================
  function toNumBR(s) {
    if (s == null) return null;
    s = String(s).trim();
    const neg = /^\(.*\)$/.test(s);
    s = s.replace(/[()%\s]/g, '').replace(/\./g, '').replace(',', '.');
    if (s === '' || s === '-') return null;
    const v = parseFloat(s);
    if (isNaN(v)) return null;
    return neg ? -v : v;
  }
  const BRAD_SECTIONS = [
    { re: /^Ações\b/i, classe: 'Renda Variável', sub: 'AÇÕES', direct: true },
    { re: /Fundos de Investimentos/i, classe: 'Fundos', sub: 'FUNDOS', direct: false },
    { re: /^Renda Fixa|T[íi]tulos|Compromiss/i, classe: 'Renda Fixa', sub: 'TÍTULOS', direct: true },
    { re: /Derivativ/i, classe: 'Derivativos', sub: '—', direct: true },
    { re: /Contas a Pagar|Provis/i, classe: 'Outros', sub: '—', direct: true, contas: true },
  ];
  // localiza o item cujo x mais se aproxima da âncora da coluna (tolerância)
  const nearest = (items, x, tol) => {
    let best = null, bd = tol == null ? 45 : tol;
    for (const it of items) { const d = Math.abs(it.x - x); if (d <= bd) { bd = d; best = it; } }
    return best;
  };

  function assembleBradesco(pages) {
    let fundo = null, dataPos = null;
    for (const ln of linesOf(pages[0])) {
      let mm = ln.text.match(/Cliente\s*:?\s*(.+)$/); if (mm && !fundo) fundo = clean(mm[1].replace(/^:\s*/, ''));
      mm = ln.text.match(/Data de Posi[çc][ãa]o\s*:?\s*([\d/]+)/); if (mm && !dataPos) dataPos = mm[1];
    }
    const carteira = [];
    let cur = null, cols = null;  // cols: {nome, fin, pct, inst, codigo} -> x âncora
    for (const items of pages) {
      for (const ln of linesOf(items)) {
        const first = ln.items[0];
        if (!first) continue;
        // 1) cabeçalho de seção (x~44, texto sem números)
        if (first.x < 62 && !ln.items.some(i => /\d,\d/.test(i.s))) {
          const sec = BRAD_SECTIONS.find(s => s.re.test(ln.text.trim()) && !/Código|Descrição/.test(ln.text));
          if (sec) { cur = sec; cols = null; continue; }
        }
        if (!cur) continue;
        // 2) linha de cabeçalho de colunas -> lê âncoras x reais
        if (/^(Código|Descrição)$/.test(first.s)) {
          cols = { codigo: null, nome: null, fin: null, pct: null, inst: null };
          for (const it of ln.items) {
            if (/^Código$/.test(it.s)) cols.codigo = it.x;
            else if (/^(Papel|Fundo|Descrição)$/.test(it.s)) cols.nome = it.x;
            else if (/Institui/.test(it.s)) cols.inst = it.x;
            else if (/Valor.*L[íi]quido/i.test(it.s)) cols.fin = it.x;       // "Valor Líquido"/"Valor de Mercado Líquido"
            else if (/%\s*s\/\s*Total/i.test(it.s)) cols.pct = it.x;
          }
          if (cols.nome == null && cols.codigo != null) cols.nome = cols.codigo + 110;
          continue;
        }
        if (!cols) continue;
        // 3) linha TOTAL: para "Contas", captura como 1 item agregado
        if (/^Total$/i.test(first.s.trim())) {
          if (cur.contas) {
            const p = cols.pct != null ? nearest(ln.items, cols.pct, 30) : null;
            const fv = cols.fin != null ? nearest(ln.items, cols.fin, 40) : null;
            if (p && /%$/.test(p.s)) carteira.push({ nome: 'Contas a Pagar/Receber', classe: 'Outros', subclasse: '—',
              subclasseAtivo: 'Provisões', pct: toNumBR(p.s), financeiro: fv ? toNumBR(fv.s) : null,
              liquidezVenc: 'D+0', emissorGestor: 'Contas a Pagar/Receber', admin: null });
          }
          continue;
        }
        if (cur.contas) continue;  // detalhe de contas ignorado (só o total)
        // 4) linha de holding
        const pTok = cols.pct != null ? nearest(ln.items, cols.pct, 28) : null;
        if (!pTok || !/%$/.test(pTok.s)) continue;   // exige a coluna "% s/Total"
        const nTok = cols.nome != null ? nearest(ln.items, cols.nome, 60) : null;
        if (!nTok || /^\d/.test(nTok.s)) continue;    // exige um nome não-numérico
        // financeiro = valor monetário mais à direita antes das colunas de % (números right-aligned)
        const monet = ln.items.filter(i => i.x < pTok.x - 18 && /\d\.\d|\d,\d/.test(i.s) && !/%$/.test(i.s));
        const fTok = monet.length ? monet[monet.length - 1] : null;
        const iTok = cols.inst != null ? nearest(ln.items, cols.inst, 50) : null;
        const nome = clean(nTok.s);
        const inst = iTok ? clean(iTok.s) : null;
        carteira.push({ nome, classe: cur.classe, subclasse: cur.sub, subclasseAtivo: inst || cur.sub,
          pct: toNumBR(pTok.s), financeiro: fTok ? toNumBR(fTok.s) : null,
          liquidezVenc: cur.sub === 'AÇÕES' ? 'D+2' : '', emissorGestor: nome, admin: inst });
      }
    }
    // agregados
    const patrimonio = carteira.reduce((s, h) => s + (h.financeiro || 0), 0);
    const porClasse = {};
    for (const h of carteira) porClasse[h.classe] = (porClasse[h.classe] || 0) + (h.pct || 0);
    const alocacaoClasse = Object.entries(porClasse).map(([classe, pct]) => ({ classe, pct: Math.round(pct * 100) / 100, valor: null }));
    const porEmissor = {};
    for (const h of carteira) { const k = h.emissorGestor || h.nome; porEmissor[k] = (porEmissor[k] || 0) + (h.pct || 0); }
    const concentracao = Object.entries(porEmissor).map(([nome, pct]) => ({ nome, pct: Math.round(pct * 100) / 100 }))
      .sort((a, b) => b.pct - a.pct).slice(0, 20);
    const somaPL = carteira.reduce((s, h) => s + (h.pct || 0), 0);
    return {
      formato: 'bradesco',
      header: { fundo, geradoEm: null, cotaData: dataPos, cota: null, patrimonio },
      alocacaoClasse, alocacaoSubclasse: [], concentracao, liquidez: [], carteira,
      diagnostico: { holdings: carteira.length, somaPctPL: Math.round(somaPL * 100) / 100, classes: alocacaoClasse.length, formato: 'bradesco' },
    };
  }

  // =====================================================================
  //  BTG — "Resumo da Carteira" (fundo de fundos; CNPJ por posição)
  //  Layout tabular por colunas; números em formato US ($, vírgula=milhar).
  // =====================================================================
  function moneyNum(s) {
    if (s == null) return null;
    s = String(s).trim();
    const neg = /^\(.*\)$/.test(s);
    s = s.replace(/[$()]/g, '').replace(/,/g, '').trim();   // vírgula = separador de milhar
    if (s === '' || s === '-') return null;
    const v = parseFloat(s);
    if (isNaN(v)) return null;
    return neg ? -v : v;
  }
  // classe provisória do fundo investido pelo nome (o CNPJ + Quantum refinam depois)
  function classeResumo(nome) {
    const u = (nome || '').toUpperCase();
    if (/\bRF\b|\bCDB\b|RENDA FIXA|CR[ÉE]D|DEBENT|\bLFT\b|\bLTN\b|\bNTN|COMPROMISS/.test(u)) return { classe: 'Renda Fixa', sub: 'Fundo de renda fixa' };
    if (/\bFIA\b|FICFIA|FC ?FIA|FCFIA|A[ÇC][ÕO]ES|ACOES|IBOV|EQUITY|\bLB\b|LONG ?BIAS/.test(u)) return { classe: 'Renda Variável', sub: 'Fundo de ações' };
    if (/\bFIM\b|MULT|MACRO|TOTAL ?RET|RETORNO ABS|HEDGE|\bMM\b/.test(u)) return { classe: 'Retorno Absoluto', sub: 'Fundo multimercado' };
    return { classe: 'Renda Variável', sub: 'Fundo investido' };
  }
  function assembleResumo(pages) {
    // ---------- cabeçalho (página 1)
    let fundo = null, dataPos = null, patrimonio = null, cota = null;
    const L1 = linesOf(pages[0] || []);
    if (L1[0]) fundo = clean(L1[0].text.replace(/Posi[çc][ãa]o:.*$/i, ''));
    for (const ln of L1) {
      const t = ln.text;
      let m = t.match(/Posi[çc][ãa]o:\s*([\d/]+)/); if (m && !dataPos) dataPos = m[1];
      m = t.match(/^PATRIM[ÔO]NIO\s+\$?([\d.,]+)/i); if (m && patrimonio == null) patrimonio = moneyNum(m[1]);
      m = t.match(/COTA L[ÍI]QUIDA\s+([\d.,]+)/i); if (m && cota == null) cota = moneyNum(m[1]);
    }
    // ---------- posições (todas as páginas), por seção e âncoras de coluna
    const carteira = [];
    let section = null;
    for (const items of pages) {
      for (const ln of linesOf(items)) {
        const first = ln.items[0]; if (!first) continue;
        const t = ln.text.trim();
        // cabeçalhos de seção (linhas curtas, no início da coluna)
        if (ln.items.length <= 3 && first.x < 60) {
          if (/^Compromissada\b/i.test(t)) { section = 'comp'; continue; }
          if (/^Ações\b/i.test(t)) { section = 'acoes'; continue; }
          if (/^Portf[óo]lio Investido\b/i.test(t)) { section = 'port'; continue; }
          if (/^Despesas\b/i.test(t)) { section = null; continue; }
        }
        if (!section) continue;

        if (section === 'port') {
          const cn = tokAt(ln.items, 30, 80, null);
          if (!cn || !/^\d{14}$/.test(cn.s)) continue;                 // exige CNPJ de 14 dígitos
          const nome = clean(joinRange(ln.items, 100, 245));
          const finTok = ln.items.find(i => i.x >= 380 && i.x <= 445 && /\$?[\d,]+\.\d/.test(i.s));
          const pctTok = tokAt(ln.items, 450, 498, true);
          if (!nome || !finTok) continue;
          const cl = classeResumo(nome);
          carteira.push({ cnpj: cn.s, nome, classe: cl.classe, subclasse: cl.sub, subclasseAtivo: cl.sub,
            financeiro: moneyNum(finTok.s), pct: pctTok ? toNum(pctTok.s) : null, liquidezVenc: '', emissorGestor: nome });
        } else if (section === 'acoes') {
          const pap = tokAt(ln.items, 40, 100, false);
          if (!pap || !/^[A-Z0-9]{4}\d{1,2}$/.test(pap.s)) continue;   // ticker tipo BOVA11
          const finTok = ln.items.find(i => i.x >= 300 && i.x <= 348 && /[\d,]+\.\d/.test(i.s));
          const pctTok = tokAt(ln.items, 376, 404, true);
          if (!finTok) continue;
          carteira.push({ cnpj: null, nome: pap.s, classe: 'Renda Variável', subclasse: 'AÇÕES', subclasseAtivo: 'Ações',
            financeiro: moneyNum(finTok.s), pct: pctTok ? toNum(pctTok.s) : null, liquidezVenc: 'D+2', emissorGestor: pap.s });
        } else if (section === 'comp') {
          if (!/COMPROMISSADA/i.test(t)) continue;
          const finTok = ln.items.find(i => /^\$[\d,]+\.\d/.test(i.s));
          if (!finTok) continue;
          const fin = moneyNum(finTok.s);
          carteira.push({ cnpj: null, nome: 'Operação Compromissada', classe: 'Renda Fixa', subclasse: 'Compromissada',
            subclasseAtivo: 'Operação Compromissada', financeiro: fin,
            pct: patrimonio ? Math.round(fin / patrimonio * 10000) / 100 : null, liquidezVenc: 'D+1', emissorGestor: 'BTG Pactual (compromissada)' });
        }
      }
    }
    // % do PL de fallback (calcula do financeiro quando a coluna não veio)
    for (const h of carteira) if (h.pct == null && patrimonio) h.pct = Math.round(h.financeiro / patrimonio * 10000) / 100;

    const porClasse = {};
    for (const h of carteira) porClasse[h.classe] = (porClasse[h.classe] || 0) + (h.pct || 0);
    const alocacaoClasse = Object.entries(porClasse).map(([classe, pct]) => ({ classe, pct: Math.round(pct * 100) / 100, valor: null }));
    const porEmissor = {};
    for (const h of carteira) { const k = h.emissorGestor || h.nome; porEmissor[k] = (porEmissor[k] || 0) + (h.pct || 0); }
    const concentracao = Object.entries(porEmissor).map(([nome, pct]) => ({ nome, pct: Math.round(pct * 100) / 100 }))
      .sort((a, b) => b.pct - a.pct).slice(0, 20);
    const somaPL = carteira.reduce((s, h) => s + (h.pct || 0), 0);
    return {
      formato: 'resumo',
      header: { fundo, geradoEm: null, cotaData: dataPos, cota, patrimonio },
      alocacaoClasse, alocacaoSubclasse: [], concentracao, liquidez: [], carteira,
      diagnostico: { holdings: carteira.length, somaPctPL: Math.round(somaPL * 100) / 100, classes: alocacaoClasse.length, formato: 'resumo' },
    };
  }

  function detectarFormato(pages) {
    const t0 = (pages[0] || []).map(i => i.s).join(' ');
    const tAll = pages.reduce((a, p) => a + ' ' + p.map(i => i.s).join(' '), '');
    if (/Resumo da Carteira/i.test(t0) && /Portf[óo]lio Investido|\bCnpj\b|QUANTIDADE DE COTAS/i.test(tAll)) return 'resumo';
    if (/Carteira Di[áa]ria/i.test(t0) || /Data de Posi[çc][ãa]o/i.test(t0)) return 'bradesco';
    return 'btg';
  }

  // ----------------------------------------------------- extração de páginas
  async function pagesOf(pdfjsLib, data) {
    const doc = await pdfjsLib.getDocument({ data, isEvalSupported: false }).promise;
    const pages = [];
    for (let p = 1; p <= doc.numPages; p++) {
      const page = await doc.getPage(p);
      const vp = page.getViewport({ scale: 1 });
      const tc = await page.getTextContent({ disableCombineTextItems: true });
      const items = [];
      for (const it of tc.items) {
        if (!it.str || !it.str.trim()) continue;
        const t = pdfjsLib.Util.transform(vp.transform, it.transform);
        items.push({ x: Math.round(t[4] * 10) / 10, y: Math.round(t[5] * 10) / 10, s: it.str });
      }
      pages.push(items);
    }
    return pages;
  }

  function assembleBTG(pages) {
    const p1 = pages[0] || [], p2 = pages[1] || [];
    const header = parseHeader(p1);
    const carteira = parseCarteira(pages);
    const alocacaoClasse = parseClasse(p2);
    const somaPL = carteira.reduce((s, h) => s + (h.pct || 0), 0);
    return {
      formato: 'btg',
      header,
      alocacaoClasse,
      alocacaoSubclasse: parseSubclasse(p2),
      concentracao: parseConcentracao(p2),
      liquidez: parseLiquidez(p2),
      carteira,
      diagnostico: {
        holdings: carteira.length,
        somaPctPL: Math.round(somaPL * 100) / 100,
        classes: alocacaoClasse.length,
      },
    };
  }

  function assemble(pages) {
    const fmt = detectarFormato(pages);
    if (fmt === 'resumo') return assembleResumo(pages);
    if (fmt === 'bradesco') return assembleBradesco(pages);
    return assembleBTG(pages);
  }

  async function parse(pdfjsLib, data) {
    const buf = data instanceof Uint8Array ? data : new Uint8Array(data);
    return assemble(await pagesOf(pdfjsLib, buf));
  }

  return { parse, assemble, assembleBTG, assembleBradesco, assembleResumo, detectarFormato,
    _internals: { linesOf, parseHeader, parseLiquidez, parseClasse, parseSubclasse, parseConcentracao, parseCarteira, toNum, isNum } };
});
