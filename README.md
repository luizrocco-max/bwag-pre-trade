# BWAG — Dashboard Pré-Trade

Ferramenta de apoio ao **enquadramento pré-negociação (pré-trade)** exigido por
ANBIMA e CVM (Resolução CVM 175), para a mesa de gestão da BWAG.

O fluxo é: **importar a posição dos fundos → importar métricas do Quantum Axis →
configurar a política/mandato → montar cenários de alocação (proxy) → rodar o
parecer de pré-trade** com as checagens de enquadramento antes de negociar.

Tudo roda **100% no navegador** (nenhum dado sai da máquina). O app é um único
arquivo HTML autossuficiente — sem servidor, sem CDN, funciona offline.

---

## Como usar

1. Abra **`dashboard.html`** no navegador (duplo-clique) — ou publique a versão
   `dist/artifact.html` como Artifact.
2. **Posição** — arraste os PDFs dos fundos. O formato é detectado sozinho:
   - **BTG** — *Relatório de Performance Diário / Acompanhamento de FI (AcompFI)*
   - **Bradesco** — *Carteira Diária*
3. **Métricas** — importe a planilha do **Quantum Axis** (`.xlsx`/`.csv`). As
   colunas são reconhecidas automaticamente (nome, retorno, volatilidade,
   Sharpe, VaR, taxas, liquidez…). Botão *Baixar modelo* gera o CSV esperado.
4. **Política** — escolha a classe/preset, o público-alvo e ajuste bandas por
   classe e limites (emissor, concentração, liquidez, crédito privado, risco).
   As configurações ficam salvas localmente por fundo.
5. **Proxy de alocação** — parta da posição atual, edite pesos-alvo ou gere
   alternativas automáticas (*reduzir concentração*, *aumentar liquidez*,
   *enquadrar bandas*). O app mostra a lista de ordens (compra/venda) e o
   impacto de cada cenário.
6. **Pré-trade** — o parecer roda o motor de regras sobre o cenário escolhido:
   enquadramento, concentração, liquidez, crédito privado e risco, com o
   valor apurado × limite e a fonte regulatória. Inclui o checklist procedural
   (contrato, suitability, KYC, melhor execução) e a comparação de cenários.
   Botão *Imprimir / PDF* para arquivar o parecer.

> Sem nenhum arquivo em mãos, o botão **Carregar exemplo** demonstra o fluxo
> completo com um fundo fictício.

---

## O que o motor avalia

Checagens **automáticas** a partir dos dados importados (limites CVM 175 como
padrão, todos configuráveis):

| Categoria | Regras |
|---|---|
| **Enquadramento** | tipificação da classe (Ações ≥67%, RF ≥80%, Cambial ≥80%), bandas de alocação por classe, exposição ao exterior por público-alvo (20/40/100%) |
| **Concentração** | por emissor, por grupo econômico, ativo individual, Top-5 / Top-10 |
| **Diversificação** | HHI / número efetivo de posições, mínimo de posições |
| **Liquidez** | liquidez × prazo de resgate, LCR D+1 / D+5, caixa mínimo |
| **Crédito privado** | gatilho de 50% do PL |
| **Risco de mercado** | volatilidade e VaR estimados (via métricas do Quantum Axis) |

Regras **procedurais** (atestação humana): contrato/mandato, suitability/API,
KYC-PLD, análise de crédito, melhor execução, conflito/cross-trade, rateio,
registro. O catálogo completo de **69 regras** (ANBIMA + CVM 175) fica na
aba Pré-trade como referência.

---

## Estrutura do projeto

```
src/
  index.html       Template do corpo (placeholders)
  styles.css       Design system institucional BWAG
  parser.js        Parser de PDF (BTG AcompFI + Bradesco Carteira Diária) via pdf.js
  engine.js        Motor de pré-trade (presets, perfil da carteira, regras)
  catalog-data.js  Dados de referência (69 regras, 39 métricas, colunas Quantum) — gerado
  app.js           Interface e interação
vendor/            SheetJS + pdf.js (main + worker) — para o app ser autossuficiente
assets/            Logos BWAG
build.mjs          Inlina tudo em dashboard.html + dist/artifact.html
dashboard.html     ← Entregável (abrir no navegador)
```

### Build

```bash
node build.mjs
```

Gera `dashboard.html` (documento completo) e `dist/artifact.html` (corpo para
publicar como Artifact). Nenhuma dependência de runtime — só Node para montar.

---

## Notas

- **Privacidade:** os PDFs e a planilha são processados no navegador; nada é
  enviado a servidores. Dados reais de carteira não são versionados no repositório.
- **Bradesco:** a *Carteira Diária* não traz a escada de liquidez detalhada;
  nesse formato a liquidez por ativo é estimada (ações D+2, fundos pelo prazo
  de resgate da política).
- Esta ferramenta apoia a decisão e **não substitui** a análise formal de
  compliance e o registro da ordem.
