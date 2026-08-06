/* ============================================================================
   engine.js — Motor de pré-trade.
   - Normaliza a carteira parseada (liquidez em dias, emissor, exterior, crédito).
   - Calcula o "perfil" de qualquer alocação (atual ou cenário proposto).
   - Avalia as regras automáticas (limites CVM 175 / ANBIMA / política).
   - Fornece checklist procedural (regras que exigem atestação humana).
   ==========================================================================*/
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.Engine = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // ------------------------------------------------------ presets por classe
  // Público-alvo -> teto de exposição ao exterior (CVM 175).
  const EXTERIOR_TETO = { VAREJO: 20, QUALIFICADO: 40, PROFISSIONAL: 100 };

  const PRESETS = {
    ACOES: {
      rotulo: 'Ações (FIA / FIC FIA)', tipificacaoClasse: 'Renda Variável', tipificacaoMin: 67,
      bandas: { 'Renda Variável': [67, 100], 'Renda Fixa': [0, 33], 'Outros': [-5, 5] },
      limiteEmissor: 10, limiteGrupo: 25, top5: 40, top10: 60, maxAtivo: 20,
      hhiMax: 0.20, minPosicoes: 8, caixaMin: 0, resgateDias: 30, lcrD1: 0, lcrD5: 20,
      creditoMax: 50, volMax: 30, varMax: 3.0,
    },
    MULTIMERCADO: {
      rotulo: 'Multimercado (FIM)', tipificacaoClasse: null, tipificacaoMin: 0,
      bandas: { 'Renda Variável': [0, 70], 'Renda Fixa': [0, 100], 'Retorno Absoluto': [0, 70], 'Moeda': [0, 40], 'Outros': [-5, 10] },
      limiteEmissor: 20, limiteGrupo: 30, top5: 60, top10: 80, maxAtivo: 25,
      hhiMax: 0.25, minPosicoes: 6, caixaMin: 2, resgateDias: 30, lcrD1: 10, lcrD5: 40,
      creditoMax: 50, volMax: 20, varMax: 2.0,
    },
    RF: {
      rotulo: 'Renda Fixa (FIRF)', tipificacaoClasse: 'Renda Fixa', tipificacaoMin: 80,
      bandas: { 'Renda Fixa': [80, 100], 'Renda Variável': [0, 20], 'Moeda': [0, 20], 'Outros': [-5, 5] },
      limiteEmissor: 20, limiteGrupo: 25, top5: 50, top10: 70, maxAtivo: 20,
      hhiMax: 0.20, minPosicoes: 8, caixaMin: 2, resgateDias: 5, lcrD1: 15, lcrD5: 40,
      creditoMax: 50, volMax: 6, varMax: 1.0,
    },
    RF_CP: {
      rotulo: 'Renda Fixa Crédito Privado', tipificacaoClasse: 'Renda Fixa', tipificacaoMin: 80,
      bandas: { 'Renda Fixa': [80, 100], 'Retorno Absoluto': [0, 40], 'Renda Variável': [0, 20], 'Moeda': [0, 30], 'Outros': [-5, 5] },
      limiteEmissor: 20, limiteGrupo: 25, top5: 55, top10: 75, maxAtivo: 20,
      hhiMax: 0.22, minPosicoes: 8, caixaMin: 2, resgateDias: 30, lcrD1: 10, lcrD5: 35,
      creditoMax: 100, volMax: 8, varMax: 1.2,
    },
    CAMBIAL: {
      rotulo: 'Cambial', tipificacaoClasse: 'Moeda', tipificacaoMin: 80,
      bandas: { 'Moeda': [80, 100], 'Renda Fixa': [0, 20], 'Outros': [-5, 5] },
      limiteEmissor: 20, limiteGrupo: 25, top5: 60, top10: 80, maxAtivo: 25,
      hhiMax: 0.25, minPosicoes: 4, caixaMin: 2, resgateDias: 5, lcrD1: 15, lcrD5: 40,
      creditoMax: 50, volMax: 25, varMax: 2.5,
    },
  };

  function detectarClasse(nomeFundo) {
    const n = (nomeFundo || '').toUpperCase();
    // O TIPO do fundo (FIA/Cambial/FIM/FIRF) tem prioridade sobre o qualificador
    // "CP"/"Crédito Privado", que apenas refina um fundo de Renda Fixa.
    // Ex.: "... FIM CP ..." é um Multimercado crédito privado → MULTIMERCADO (sem piso),
    // e não um Renda Fixa Crédito Privado (que forçaria piso de 80% em RF).
    const cp = /\bCP\b|CRED|CRÉD|CREDITO|CRÉDITO/.test(n);
    if (/\bFIA\b|AÇÕES|ACOES|A[ÇC][OÕ]ES|EQUITY|\bAÇ\b/.test(n)) return 'ACOES';
    if (/CAMBIAL|CÂMBIO|CAMBIO|DÓLAR|DOLAR/.test(n)) return 'CAMBIAL';
    if (/\bFIM\b|MULT|MULTIMERCADO|MACRO/.test(n)) return 'MULTIMERCADO';
    if (/\bFIRF\b|\bRF\b|RENDA FIXA/.test(n)) return cp ? 'RF_CP' : 'RF';
    if (cp) return 'RF_CP';
    return 'MULTIMERCADO';
  }
  function presetDe(chave) {
    const p = { chave, ...JSON.parse(JSON.stringify(PRESETS[chave])) };
    if (p.liqResgateMin == null) p.liqResgateMin = 90;   // % mín. conversível no prazo de resgate
    if (p.lcrD1Dias == null) p.lcrD1Dias = 1;            // janela do LCR curtíssimo prazo
    if (p.lcrD5Dias == null) p.lcrD5Dias = 5;            // janela do LCR curto prazo
    return p;
  }
  function presetPara(nomeFundo) {
    return presetDe(detectarClasse(nomeFundo));
  }

  // ------------------------------------------------- normalização de holdings
  const up = (s) => (s || '').toUpperCase();
  const normEmissor = (s) => up(s).replace(/[.\-,]/g, ' ').replace(/\s+/g, ' ').trim();
  const PUBLICO = /BACEN|BANCO CENTRAL|TESOURO|UNI[ÃA]O|SELIC|NTN|LTN|LFT|TP\b|IPCA_MESA/;
  const CRED_KW = /\bCDB\b|\bCP\b|CRI|CRA|DEBENT|DEB\b|CRED|CRÉD|LETRA|LF\b|LCI|LCA|SPARTA/;
  const EXT_KW = / IE\b|\bIE$|EXTERIOR|GLOBAL|USD|D[ÓO]LAR|DOLAR|WORLD|OFFSHORE|INTERNAC|PIMCO|MFS|FRANKLIN|JANUS|GEO EM/;

  function diasLiquidez(liquidezVenc, baseISO) {
    if (!liquidezVenc) return null;
    let m = String(liquidezVenc).match(/D\s*\+\s*(\d+)/i);
    if (m) return parseInt(m[1], 10);
    m = String(liquidezVenc).match(/(\d{2})\/(\d{2})\/(\d{4})/);
    if (m && baseISO) {
      const venc = new Date(+m[3], +m[2] - 1, +m[1]);
      const base = new Date(baseISO);
      const d = Math.round((venc - base) / 86400000);
      return isFinite(d) ? Math.max(0, d) : null;
    }
    return null;
  }
  function baseISO(fund) {
    const s = fund?.header?.cotaData || fund?.header?.geradoEm;
    const m = String(s || '').match(/(\d{2})\/(\d{2})\/(\d{4})/);
    return m ? `${m[3]}-${m[2]}-${m[1]}` : null;
  }

  // Enriquece cada holding com campos derivados (uma vez por fundo).
  function normalizarCarteira(fund) {
    if (fund.__norm) return fund.__norm;
    const bISO = baseISO(fund);
    const hs = (fund.carteira || []).map((h, i) => {
      const emissor = normEmissor(h.emissorGestor);
      let liq = diasLiquidez(h.liquidezVenc, bISO);
      const isAcao = /A[ÇC][ÕO]ES/i.test(h.subclasse || '');
      if (liq == null) liq = isAcao ? 2 : (up(h.classe) === 'OUTROS' ? 0 : 30);
      const exterior = EXT_KW.test(up(h.subclasseAtivo) + ' ' + up(h.nome)) || /EXTERIOR/i.test(up(h.subclasse));
      const publico = PUBLICO.test(up(h.nome) + ' ' + up(h.emissorGestor));
      const credito = !publico && (up(h.classe).includes('RENDA FIXA') || up(h.classe).includes('RETORNO ABSOLUTO')) && CRED_KW.test(up(h.nome) + ' ' + up(h.subclasseAtivo));
      return {
        key: h.nome + '#' + i, nome: h.nome, classe: h.classe || 'Outros', subclasse: h.subclasse || '',
        subclasseAtivo: h.subclasseAtivo || '', pesoAtual: h.pct || 0, financeiro: h.financeiro || 0,
        cnpj: (h.cnpj || '').toString().replace(/\D/g, '') || null,
        emissor: emissor || h.nome, grupo: (emissor || h.nome).split(' ').slice(0, 2).join(' '),
        liqDias: liq, exterior, publico, credito, liquidezVenc: h.liquidezVenc || (isAcao ? 'D+2' : ''),
      };
    });
    fund.__norm = hs;
    return hs;
  }

  // ---------------------------------------------------- índice do Quantum Axis
  const normNome = (s) => up(s).replace(/[^A-Z0-9 ]/g, ' ').replace(/\b(FIC|FIA|FIM|FI|FICFIM|FCFIA|FCFM|PCO|RF|CP|IE|SUB|GERAL|FUNDO|DE|DA|DO|INVESTIMENTO)\b/g, ' ').replace(/\s+/g, ' ').trim();
  // casamento automático (por nome), ignorando o De-Para manual
  function autoMatch(holding, quantumIndex) {
    if (!quantumIndex) return null;
    // 1) casamento por CNPJ (exato e mais confiável), quando disponível dos dois lados
    if (holding.cnpj && quantumIndex.byCnpj && quantumIndex.byCnpj[holding.cnpj]) return quantumIndex.byCnpj[holding.cnpj];
    // 2) casamento por nome (fallback)
    const key = normNome(holding.nome);
    if (!key) return null;
    if (quantumIndex.exact[key]) return quantumIndex.exact[key];
    const toks = new Set(key.split(' ').filter(t => t.length > 2));
    let best = null, bestScore = 0;
    for (const q of quantumIndex.list) {
      const qt = q.__toks; if (!qt) continue;
      let s = 0;
      for (const t of toks) if (qt.has(t)) s++;
      const score = s / Math.max(1, toks.size);
      if (score > bestScore) { bestScore = score; best = q; }
    }
    return bestScore >= 0.6 ? best : null;
  }
  // casamento efetivo: respeita o De-Para manual (quantumIndex.overrides) e cai no automático
  function casarQuantum(holding, quantumIndex) {
    if (!quantumIndex) return null;
    if (quantumIndex.overrides) {
      const ov = quantumIndex.overrides[holding.nome];
      if (ov !== undefined) return ov === '__none__' ? null : ((quantumIndex.byNome && quantumIndex.byNome[ov]) || null);
    }
    return autoMatch(holding, quantumIndex);
  }
  // como o casamento automático foi obtido: 'cnpj' | 'nome' | null (usado só p/ rotular)
  function matchType(holding, quantumIndex) {
    if (!quantumIndex || !autoMatch(holding, quantumIndex)) return null;
    if (holding.cnpj && quantumIndex.byCnpj && quantumIndex.byCnpj[holding.cnpj]) return 'cnpj';
    return 'nome';
  }

  // ------------------------------------------------------------- perfil
  // pesos: objeto {key: peso%} ; se ausente usa pesoAtual.
  // extra: ativos incluídos no cenário (fora da carteira original), já normalizados.
  function perfil(fund, pesos, quantumIndex, policy, extra) {
    const hs = normalizarCarteira(fund).concat(extra || []);
    const w = (h) => (pesos && pesos[h.key] != null) ? pesos[h.key] : h.pesoAtual;
    const total = hs.reduce((s, h) => s + w(h), 0) || 100;

    const porClasse = {}, porSub = {}, porEmissor = {}, porGrupo = {};
    let exterior = 0, credito = 0, caixa = 0, hhi = 0, nPos = 0, maxAtivo = 0;
    let volNum = 0, volDen = 0, ret12Num = 0, sharpeNum = 0, sharpeDen = 0, custoNum = 0, custoDen = 0;
    const holdingsW = [];
    const buckets = { 'D+0': 0, 'D+1': 0, 'D+2 a D+15': 0, 'D+16 a D+35': 0, 'D+36 a D+65': 0, 'D+66 a D+1450': 0, 'D>1450': 0 };
    const liqSorted = [];

    for (const h of hs) {
      const p = w(h) / total * 100;  // peso normalizado (%)
      holdingsW.push({ h, peso: p });
      porClasse[h.classe] = (porClasse[h.classe] || 0) + p;
      const sub = h.subclasseAtivo || h.subclasse || '—';
      porSub[sub] = (porSub[sub] || 0) + p;
      porEmissor[h.emissor] = (porEmissor[h.emissor] || 0) + p;
      porGrupo[h.grupo] = (porGrupo[h.grupo] || 0) + p;
      if (h.exterior) exterior += p;
      if (h.credito) credito += p;
      hhi += (p / 100) * (p / 100);
      if (p >= 0.5) nPos++;
      if (p > maxAtivo) maxAtivo = p;
      const q = casarQuantum(h, quantumIndex);
      // liquidez efetiva: prioriza a cotização do Quantum Axis quando disponível
      const d = (q && q.cotDias != null) ? q.cotDias : h.liqDias;
      h.__liq = d;
      if (d === 0) caixa += p;
      const b = d <= 0 ? 'D+0' : d <= 1 ? 'D+1' : d <= 15 ? 'D+2 a D+15' : d <= 35 ? 'D+16 a D+35' : d <= 65 ? 'D+36 a D+65' : d <= 1450 ? 'D+66 a D+1450' : 'D>1450';
      buckets[b] += p;
      liqSorted.push({ d, p });
      if (q) {
        if (q.vol != null) { volNum += p * q.vol; volDen += p; }
        if (q.ret12 != null) ret12Num += p * q.ret12;
        if (q.sharpe != null) { sharpeNum += p * q.sharpe; sharpeDen += p; }
        if (q.taxaAdm != null) { custoNum += p * q.taxaAdm; custoDen += p; }
        h.__q = q;
      }
    }
    liqSorted.sort((a, b) => a.d - b.d);
    const liqCum = (nd) => hs.reduce((s, h) => s + (((h.__liq != null ? h.__liq : h.liqDias) <= nd) ? w(h) / total * 100 : 0), 0);

    const top = holdingsW.map(x => x.peso).sort((a, b) => b - a);
    const somaTop = (n) => top.slice(0, n).reduce((s, v) => s + v, 0);
    const volEst = volDen ? volNum / volDen : null;                 // vol anual estimada (média ponderada)
    const coberturaVol = volDen / 100;
    const varEst = volEst != null ? 1.645 * volEst / Math.sqrt(252) : null;  // VaR 1d 95% paramétrico

    return {
      total, porClasse, porSubclasse: porSub, porEmissor, porGrupo, buckets, holdingsW,
      exteriorPct: exterior, creditoPct: credito, caixaPct: caixa, hhi, nEfetivo: hhi ? 1 / hhi : null,
      nPosicoes: nPos, maxAtivo, top5: somaTop(5), top10: somaTop(10),
      liqCum, volEst, coberturaVol, varEst,
      ret12Est: total ? ret12Num / 100 : null, sharpeEst: sharpeDen ? sharpeNum / sharpeDen : null,
      custoEst: custoDen ? custoNum / custoDen : null,
      maiorEmissor: Object.entries(porEmissor).sort((a, b) => b[1] - a[1])[0] || ['—', 0],
      maiorGrupo: Object.entries(porGrupo).sort((a, b) => b[1] - a[1])[0] || ['—', 0],
    };
  }

  // ------------------------------------------------------------- regras auto
  const OK = 'ok', AL = 'alerta', BL = 'bloqueio', NA = 'na';
  const pct = (v) => (v == null ? '—' : (Math.round(v * 100) / 100).toLocaleString('pt-BR') + '%');

  // helper: compara "menor ou igual" com severidade base
  function leq(atual, limite, sev) { return atual <= limite + 1e-9 ? OK : sev; }
  function geq(atual, limite, sev) { return atual >= limite - 1e-9 ? OK : sev; }

  const AUTO_RULES = [
    { id: 'tipificacao', nome: 'Tipificação da classe (piso no fator de risco)', categoria: 'Enquadramento', fonte: 'CVM 175 (tipificação)',
      evaluate: (P, pol) => {
        if (!pol.tipificacaoClasse) return { status: NA, atual: '—', limite: 'sem piso (Multimercado)', msg: 'Classe multimercado não tem piso obrigatório por fator.' };
        const a = P.porClasse[pol.tipificacaoClasse] || 0;
        return { status: geq(a, pol.tipificacaoMin, BL), atual: pct(a), limite: '≥ ' + pct(pol.tipificacaoMin) + ' em ' + pol.tipificacaoClasse,
          msg: `A classe deve manter no mínimo ${pct(pol.tipificacaoMin)} em ${pol.tipificacaoClasse}.` };
      } },
    { id: 'bandas', nome: 'Bandas de alocação por classe (política)', categoria: 'Enquadramento', fonte: 'Política / SAA · ANBIMA',
      evaluate: (P, pol) => {
        const viol = [];
        for (const [cl, [mn, mx]] of Object.entries(pol.bandas || {})) {
          const a = P.porClasse[cl] || 0;
          if (a < mn - 1e-9) viol.push(`${cl} ${pct(a)} < mín ${pct(mn)}`);
          else if (a > mx + 1e-9) viol.push(`${cl} ${pct(a)} > máx ${pct(mx)}`);
        }
        return { status: viol.length ? AL : OK, atual: viol.length ? viol.join(' · ') : 'dentro das bandas',
          limite: 'min/máx por classe', msg: 'Alocação por classe deve respeitar as bandas da política de investimento.' };
      } },
    { id: 'exterior', nome: 'Exposição a ativos no exterior', categoria: 'Enquadramento', fonte: 'CVM 175 · público-alvo',
      evaluate: (P, pol) => {
        const teto = EXTERIOR_TETO[pol.publicoAlvo] ?? 100;
        return { status: leq(P.exteriorPct, teto, BL), atual: pct(P.exteriorPct), limite: '≤ ' + pct(teto) + ' (' + (pol.publicoAlvo || '—').toLowerCase() + ')',
          msg: `Exterior: varejo 20% · qualificado 40% · profissional 100%.` };
      } },
    { id: 'conc-emissor', nome: 'Concentração por emissor (maior)', categoria: 'Concentração', fonte: 'CVM 175 art. 44',
      evaluate: (P, pol) => {
        const [nome, v] = P.maiorEmissor;
        return { status: leq(v, pol.limiteEmissor, BL), atual: nome + ': ' + pct(v), limite: '≤ ' + pct(pol.limiteEmissor),
          msg: 'Limite por emissor: IF 20% · cia. aberta/fundo 10% · PF/PJ 5% (ajuste conforme o tipo do emissor).' };
      } },
    { id: 'conc-grupo', nome: 'Concentração por grupo econômico', categoria: 'Concentração', fonte: 'CVM 175 · risco de contraparte',
      evaluate: (P, pol) => {
        const [nome, v] = P.maiorGrupo;
        return { status: leq(v, pol.limiteGrupo, AL), atual: nome + ': ' + pct(v), limite: '≤ ' + pct(pol.limiteGrupo),
          msg: 'Soma dos emissores do mesmo grupo econômico (agrupamento heurístico por nome).' };
      } },
    { id: 'conc-ativo', nome: 'Concentração em ativo individual', categoria: 'Concentração', fonte: 'Risco idiossincrático',
      evaluate: (P, pol) => ({ status: leq(P.maxAtivo, pol.maxAtivo, AL), atual: pct(P.maxAtivo), limite: '≤ ' + pct(pol.maxAtivo),
        msg: 'Nenhum ativo isolado deve exceder o limite de concentração single-line.' }) },
    { id: 'conc-top5', nome: 'Concentração Top-5', categoria: 'Concentração', fonte: 'Diversificação',
      evaluate: (P, pol) => ({ status: leq(P.top5, pol.top5, AL), atual: pct(P.top5), limite: '≤ ' + pct(pol.top5), msg: 'Soma dos 5 maiores ativos.' }) },
    { id: 'conc-top10', nome: 'Concentração Top-10', categoria: 'Concentração', fonte: 'Diversificação',
      evaluate: (P, pol) => ({ status: leq(P.top10, pol.top10, AL), atual: pct(P.top10), limite: '≤ ' + pct(pol.top10), msg: 'Soma dos 10 maiores ativos.' }) },
    { id: 'hhi', nome: 'Índice de concentração HHI', categoria: 'Diversificação', fonte: 'HHI = Σ pesoᵢ²',
      evaluate: (P, pol) => ({ status: leq(P.hhi, pol.hhiMax, AL), atual: (Math.round(P.hhi * 1000) / 1000) + ' (N≈' + (P.nEfetivo ? P.nEfetivo.toFixed(1) : '—') + ')',
        limite: '≤ ' + pol.hhiMax, msg: 'HHI baixo indica carteira mais pulverizada (N efetivo = 1/HHI).' }) },
    { id: 'min-posicoes', nome: 'Número mínimo de posições (≥0,5%)', categoria: 'Diversificação', fonte: 'Pulverização',
      evaluate: (P, pol) => ({ status: geq(P.nPosicoes, pol.minPosicoes, AL), atual: P.nPosicoes + ' posições', limite: '≥ ' + pol.minPosicoes,
        msg: 'Contagem de ativos com peso relevante (≥ 0,5%).' }) },
    { id: 'liq-resgate', nome: 'Liquidez × prazo de resgate', categoria: 'Liquidez', fonte: 'CVM 175 · compatibilidade',
      evaluate: (P, pol) => {
        const min = pol.liqResgateMin != null ? pol.liqResgateMin : 90;
        const a = P.liqCum(pol.resgateDias);
        return { status: geq(a, min, BL), atual: pct(a) + ' até D+' + pol.resgateDias, limite: '≥ ' + pct(min, 0) + ' em D+' + pol.resgateDias,
          msg: `Ao menos ${pct(min, 0)} do PL deve ser conversível dentro do prazo de cotização+liquidação (D+${pol.resgateDias}).` };
      } },
    { id: 'lcr-d1', nome: 'Liquidez de curtíssimo prazo', categoria: 'Liquidez', fonte: 'LCR interno',
      evaluate: (P, pol) => { const d = pol.lcrD1Dias != null ? pol.lcrD1Dias : 1;
        return { status: geq(P.liqCum(d), pol.lcrD1, AL), atual: pct(P.liqCum(d)) + ' em D+' + d, limite: '≥ ' + pct(pol.lcrD1),
          msg: `Colchão liquidável em até D+${d} para resgates de curtíssimo prazo.` }; } },
    { id: 'lcr-d5', nome: 'Liquidez de curto prazo', categoria: 'Liquidez', fonte: 'LCR interno',
      evaluate: (P, pol) => { const d = pol.lcrD5Dias != null ? pol.lcrD5Dias : 5;
        return { status: geq(P.liqCum(d), pol.lcrD5, AL), atual: pct(P.liqCum(d)) + ' em D+' + d, limite: '≥ ' + pct(pol.lcrD5),
          msg: `Percentual liquidável em até D+${d}.` }; } },
    { id: 'caixa-min', nome: 'Caixa mínimo pós-trade', categoria: 'Liquidez', fonte: 'Colchão de liquidez',
      evaluate: (P, pol) => ({ status: geq(P.caixaPct, pol.caixaMin, AL), atual: pct(P.caixaPct) + ' em D+0', limite: '≥ ' + pct(pol.caixaMin),
        msg: 'Disponibilidades + ativos de liquidez imediata (D+0).' }) },
    { id: 'credito-privado', nome: 'Crédito privado (gatilho 50%)', categoria: 'Crédito privado', fonte: 'CVM 175 · sufixo "Crédito Privado"',
      evaluate: (P, pol) => ({ status: leq(P.creditoPct, pol.creditoMax, BL), atual: pct(P.creditoPct), limite: '≤ ' + pct(pol.creditoMax),
        msg: 'Acima de 50% em crédito privado exige sufixo "Crédito Privado" e público qualificado (classificação heurística).' }) },
    { id: 'vol', nome: 'Volatilidade estimada da carteira', categoria: 'Risco de mercado', fonte: 'Quantum Axis (vol anual)',
      evaluate: (P, pol) => {
        if (P.volEst == null) return { status: NA, atual: 'sem dados', limite: '≤ ' + pct(pol.volMax) + ' a.a.', msg: 'Importe métricas do Quantum Axis para estimar a volatilidade.' };
        if (P.coberturaVol < 0.4) return { status: NA, atual: 'cobertura ' + pct(P.coberturaVol * 100), limite: '≤ ' + pct(pol.volMax) + ' a.a.', msg: 'Cobertura de vol do Quantum < 40% da carteira — estimativa não confiável. Case mais ativos.' };
        return { status: leq(P.volEst, pol.volMax, AL), atual: pct(P.volEst) + ' a.a. (cob. ' + pct(P.coberturaVol * 100) + ')',
          limite: '≤ ' + pct(pol.volMax) + ' a.a.', msg: 'Média ponderada das vols (estimativa sem correlação — conservadora).' };
      } },
    { id: 'var', nome: 'VaR 1d 95% estimado', categoria: 'Risco de mercado', fonte: 'Paramétrico (1,645·σ/√252)',
      evaluate: (P, pol) => {
        if (P.varEst == null || P.coberturaVol < 0.4) return { status: NA, atual: P.varEst == null ? 'sem dados' : 'cobertura ' + pct(P.coberturaVol * 100), limite: '≤ ' + pct(pol.varMax), msg: 'Depende da volatilidade do Quantum Axis (cobertura ≥ 40% da carteira).' };
        return { status: leq(P.varEst, pol.varMax, AL), atual: pct(P.varEst) + ' do PL', limite: '≤ ' + pct(pol.varMax),
          msg: 'Perda potencial em 1 dia a 95% (estimativa paramétrica).' };
      } },
  ];

  // ------------------------------------------------------- checklist procedural
  const CHECKLIST = [
    { id: 'mandato-escrito', nome: 'Contrato/mandato escrito assinado, com política de investimento', fonte: 'ANBIMA · CVM 21' },
    { id: 'suitability-api', nome: 'API/suitability vigente (≤24m) e produto adequado ao perfil', fonte: 'Res. CVM 30' },
    { id: 'cadastro-kyc', nome: 'Cadastro/KYC-PLD atualizado (≤5 anos), sem hit de sanção pendente', fonte: 'Res. CVM 50 · PLD' },
    { id: 'credito-analise', nome: 'Análise de crédito formalizada e arquivada (se houver crédito privado)', fonte: 'CVM 175' },
    { id: 'melhor-execucao', nome: 'Política de melhor execução observada (preço, custo, liquidez)', fonte: 'ANBIMA · best execution' },
    { id: 'conflito-crosstrade', nome: 'Conflitos/partes ligadas e cross-trade autorizados por escrito', fonte: 'CVM 175 · conflito' },
    { id: 'rateio', nome: 'Critério de rateio pré-estabelecido aplicado (ordens agregadas)', fonte: 'ANBIMA · rateio' },
    { id: 'registro', nome: 'Ordem, fundamentação e enquadramento registrados (trilha de auditoria)', fonte: 'Governança' },
  ];

  // ------------------------------------------------------------- runner
  function avaliar(fund, pesos, quantumIndex, policy, extra) {
    const P = perfil(fund, pesos, quantumIndex, policy, extra);
    const resultados = AUTO_RULES.map(r => {
      const out = r.evaluate(P, policy);
      return { id: r.id, nome: r.nome, categoria: r.categoria, fonte: r.fonte, ...out };
    });
    const resumo = { ok: 0, alerta: 0, bloqueio: 0, na: 0 };
    for (const r of resultados) resumo[r.status]++;
    return { perfil: P, resultados, resumo };
  }

  return { PRESETS, PRESET_KEYS: Object.keys(PRESETS), EXTERIOR_TETO, presetPara, presetDe, detectarClasse,
    normalizarCarteira, perfil, avaliar, AUTO_RULES, CHECKLIST, casarQuantum, autoMatch, matchType, normNome, baseISO };
});
