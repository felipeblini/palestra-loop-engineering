#!/usr/bin/env node
/**
 * judge.mjs — o árbitro externo.
 *
 * Executado pelo ralph-loop.mjs, NUNCA pelo agente.
 *
 *   node judge.mjs --fase .loop/fase.json   o que o loop chama, fase a fase
 *   node judge.mjs                          modo manual: você, de manhã
 *   node judge.mjs --lock                   trava o hash dos testes existentes
 *   node judge.mjs --prova                  sabota o repo e confirma que reprova
 *
 * O `.loop/fase.json` é escrito pelo loop DEPOIS que a sessão do agente termina,
 * então o agente não consegue alargar o próprio escopo editando o arquivo:
 *   { n, titulo, tipo: "teste"|"impl", sha, arquivos, reservados, ultima }
 *
 * Ordem: travas baratas primeiro. Um `git diff` de 20ms reprova antes da suíte.
 */

import { createHash } from 'node:crypto';
import { spawnSync, execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, statSync,
         appendFileSync, unlinkSync, renameSync } from 'node:fs';
import { join, posix } from 'node:path';

const LOCK = '.loop/judge.lock';
const HIST = '.loop/ferramentas.json';
const CONTAGEM = '.loop/contagem.json';
const CONTAGEM_PEND = '.loop/contagem-pendente.json';
// O loop passa --sem-travar: a fase ainda tem a 2ª opinião pela frente. Travar aqui
// deixava o agente sem saída quando ela reprovava uma fase de teste — o teste já
// estava travado por hash, e corrigir virava "teste ALTERADO" (sorteio-brindes-6,
// fase 6, três tentativas). Quem trava é `--lock`, depois dos dois árbitros.
const SEM_TRAVAR = process.argv.includes('--sem-travar');
const WIN = process.platform === 'win32';

// INFRA é do loop. Nenhuma tarefa cita, nenhuma fase pode tocar. Nunca.
//
// O que NÃO está mais aqui: package.json, eslint.config, vitest.config, tokens.css.
// Travá-los por lista quebrou duas vezes — a T001 manda criar o package.json, e a
// T013 manda alterá-lo depois que o projeto já estava verde. Config não é
// contrato. O contrato é o ESCOPO: a fase só toca o que as tarefas dela citam.
const INFRA = [
  'judge.mjs', 'ralph-loop.mjs', 'loop.mjs', 'adaptar.mjs',
  '.specify/memory/constitution.md', 'openspec/config.yaml', 'CLAUDE.md', 'AGENTS.md',
  // Entrada do design: os PNG e o tokens.css. O CSS da aplicação é DERIVADO
  // deles no loop — se o agente pudesse editar a entrada, "zero literal fora de
  // tokens.css" viraria "acrescente o literal ao tokens.css".
  'design/',
];
const ehInfra = (f) => INFRA.some((i) => (i.endsWith('/') ? f.startsWith(i) : f === i));

const TESTE_RE = /\.(test|spec)\.(ts|tsx|js|mjs)$/;
const IGNORAR = ['node_modules', '.git', '.loop', 'dist', 'build', 'coverage', '.nuxt', '.output',
                 '.next', '.svelte-kit', 'vendor', '__pycache__', '.venv'];

// ─── A stack é do projeto, não do juiz ───────────────────────────────────────
// O juiz não sabe se é pnpm ou npm, Vitest ou Jest. Lê o que o repositório diz:
// o lockfile escolhe o gerenciador, os `scripts` do package.json escolhem os
// comandos, as devDependencies escolhem o runner. Stack sem package.json (Python,
// Go) passa tudo por JUDGE_CMDS="pytest,ruff check ." — que vence sempre.
const lerJson = (f) => (existsSync(f) ? JSON.parse(readFileSync(f, 'utf8')) : {});
const PKG = lerJson('package.json');
const DEPS = { ...(PKG.dependencies ?? {}), ...(PKG.devDependencies ?? {}) };
const LOCKFILES = ['package-lock.json', 'pnpm-lock.yaml', 'yarn.lock', 'bun.lock', 'bun.lockb'];
// Configuração da raiz: vite/vitest/eslint/tsconfig/package.json. Só na raiz.
const CONFIG_RE = /^(?:[\w.-]+\.config\.[cm]?[jt]s|tsconfig[\w.-]*\.json|package\.json|env\.d\.ts)$/;
// O HTML da raiz e o módulo que ele carrega: é onde toda fase de UI liga o que
// acabou de escrever. Derivado do próprio `index.html`, não de uma lista fixa.
const ENTRADAS = (() => {
  if (!existsSync('index.html')) return [];
  const html = readFileSync('index.html', 'utf8');
  const srcs = [...html.matchAll(/<script[^>]*\ssrc=["']([^"']+)["']/gi)]
    .map((m) => m[1].replace(/\\/g, '/').replace(/^\.?\//, ''))
    .filter((s) => !/^https?:/.test(s));
  return ['index.html', ...srcs];
})();
const GERENCIADOR = existsSync('pnpm-lock.yaml') ? 'pnpm'
  : existsSync('yarn.lock') ? 'yarn'
  : existsSync('bun.lock') || existsSync('bun.lockb') ? 'bun'
  : 'npm';
const script = (s) => ({ pnpm: ['pnpm', s], yarn: ['yarn', s], bun: ['bun', 'run', s], npm: ['npm', 'run', s] })[GERENCIADOR];
const exec = (...a) => ({ pnpm: ['pnpm', 'exec', ...a], yarn: ['yarn', ...a], bun: ['bunx', ...a], npm: ['npx', '--no-install', ...a] })[GERENCIADOR];

// Os comandos, nesta ordem de precedência:
//   1. JUDGE_CMDS="a,b,c"
//   2. CLAUDE.md, seção `## Comandos`, um comando por linha num bloco de código —
//      o mesmo arquivo que diz ao agente qual é a stack diz ao juiz o que rodar.
//      O juiz não depende do scaffold ter nomeado os scripts do jeito certo.
//   3. scripts do package.json (typecheck|type-check, lint, test|test:unit, test:e2e)
// `test:e2e` (ou qualquer comando com "e2e") é adiado enquanto alguma fase futura
// ainda reserva implementação, ou enquanto não há spec e2e.
// CLAUDE.md ou AGENTS.md: o arquivo de instruções muda de nome conforme a
// ferramenta que criou o projeto (o ralphy-spec gera AGENTS.md). O que importa é
// a seção `## Comandos`, não o nome do arquivo.
const INSTRUCOES = ['CLAUDE.md', 'AGENTS.md'].filter((f) => existsSync(f));
function comandosDoClaudeMd() {
  if (!INSTRUCOES.length) return [];
  const md = INSTRUCOES.map((f) => readFileSync(f, 'utf8')).join('\n\n');
  const secao = md.match(/^##\s+(?:Comandos|Gates|Verifica[çc][aã]o)\b[^\n]*\n([\s\S]*?)(?=^##\s|$(?![\s\S]))/im);
  const bloco = secao?.[1].match(/```[^\n]*\n([\s\S]*?)```/);
  return (bloco?.[1] ?? '').split('\n').map((l) => l.replace(/^\$\s*/, '').trim())
    .filter((l) => l && !l.startsWith('#'));
}
const ORIGEM_CMDS = process.env.JUDGE_CMDS ? 'JUDGE_CMDS' : comandosDoClaudeMd().length ? INSTRUCOES.join('+') : GERENCIADOR;
const CMDS = process.env.JUDGE_CMDS
  ? process.env.JUDGE_CMDS.split(',').map((x) => x.trim()).filter(Boolean)
  : comandosDoClaudeMd().length ? comandosDoClaudeMd()
  // `build` entra depois dos testes: em stack sem typecheck (JS puro), é o único
  // gate que pega import quebrado e arquivo que não existe. Só roda em fase de
  // implementação — a de teste usa o comando do vermelho.
  : [['typecheck', 'type-check'], ['lint'], ['test', 'test:unit'], ['build'], ['test:e2e']]
    .map((alts) => alts.find((s) => PKG.scripts?.[s])).filter(Boolean).map((s) => script(s).join(' '));
const ehE2e = (cmd) => /\be2e\b/.test(cmd);

const c = {
  red: (s) => `\x1b[31m${s}\x1b[0m`,
  grn: (s) => `\x1b[32m${s}\x1b[0m`,
  ylw: (s) => `\x1b[33m${s}\x1b[0m`,
};
const semAnsi = (s) => s.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '');

let falhou = false;
const reprovar = (m) => { console.log(c.red(`JUIZ REPROVOU: ${m}`)); falhou = true; };
const aviso = (m) => console.log(c.ylw(`-- ${m}`));

// Sem `\r`: o agente às vezes grava CRLF e o repo é `autocrlf=input`; um
// `reset --hard` devolveria LF e o lock acusaria alteração que ninguém fez.
const hashDe = (f) => createHash('sha256').update(readFileSync(f, 'utf8').replace(/\r\n/g, '\n')).digest('hex').slice(0, 16);
const norm = (p) => p.replace(/\\/g, '/').replace(/^\.\//, '');
const linhas = (s) => (s ?? '').split('\n').map((l) => l.trim()).filter(Boolean);

function git(...a) {
  try { return execFileSync('git', ['-c', 'core.quotepath=off', ...a], { encoding: 'utf8' }); }
  catch { return null; }
}

// A saída crua de Vitest/tsc/Vite no terminal parece desastre — e numa fase de
// teste o desastre é o esperado. Imprime só o que decide: a contagem, o arquivo
// que falhou e a primeira linha do erro. O restante fica no log do loop, e
// JUDGE_VERBOSE=1 traz tudo de volta.
const RELEVANTE = /^(?:\s*(?:Test Files|Tests)\b|.*\bFAIL\b|\s*(?:✕|×|✗|✖)\s|.*\berror\b.*TS\d+|Error:|AssertionError|SyntaxError|\s*(?:error|warning)\s+\w)/i;
const RUIDO = /node_modules|^\s*at |^\s*❯ |⎯⎯|Duration|Start at|^\s*RUN\b/;
function resumir(saida, max = 4) {
  if (process.env.JUDGE_VERBOSE) return saida;
  const linhas = semAnsi(saida).split('\n').map((l) => l.replace(/\s+$/, '')).filter(Boolean);
  const uteis = linhas.filter((l) => !RUIDO.test(l));
  const escolhidas = uteis.filter((l) => RELEVANTE.test(l));
  const fim = (escolhidas.length ? escolhidas : uteis.slice(-max)).slice(0, max);
  const resto = linhas.length - fim.length;
  return fim.length
    ? `${fim.map((l) => `   ${l.trim().slice(0, 160)}`).join('\n')}\n${resto > 0 ? `   … +${resto} linha(s) em .loop/\n` : ''}`
    : '';
}

function rodar(cmd) {
  const [bin, ...args] = Array.isArray(cmd) ? cmd : cmd.split(/\s+/);
  const r = spawnSync(bin, args, {
    stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8', shell: WIN, maxBuffer: 32 * 1024 * 1024,
  });
  // Sem shell (Linux/Git Bash), binário inexistente não imprime nada: vira ENOENT
  // em r.error com saída vazia. Traduzir para o texto que AUSENTE reconhece.
  const naoAchou = r.error?.code === 'ENOENT' ? `${bin}: command not found\n` : '';
  const saida = `${r.stdout ?? ''}${r.stderr ?? ''}${naoAchou}`;
  // O terminal recebe o resumo; a saída inteira fica aqui, que é o "…em .loop/"
  // que o resumo promete.
  try {
    mkdirSync('.loop', { recursive: true });
    appendFileSync('.loop/verificacao.log',
      `\n$ ${Array.isArray(cmd) ? cmd.join(' ') : cmd}  (exit ${r.status ?? 1})\n${saida}`);
  } catch {}
  return { status: r.status ?? 1, saida };
}

function varrer(dir, filtro) {
  if (!existsSync(dir)) return [];
  const out = [];
  for (const nome of readdirSync(dir)) {
    if (IGNORAR.includes(nome)) continue;
    const p = dir === '.' ? nome : join(dir, nome);
    if (statSync(p).isDirectory()) out.push(...varrer(p, filtro));
    else if (filtro(p)) out.push(norm(p));
  }
  return out;
}

const testes = () => varrer('.', (p) => TESTE_RE.test(p)).sort();

const lerLock = () => existsSync(LOCK)
  ? linhas(readFileSync(LOCK, 'utf8')).map((l) => { const [h, f] = l.split(/\s+/); return { h, f }; })
  : [];

function travar(lista) {
  mkdirSync('.loop', { recursive: true });
  writeFileSync(LOCK, lista.map((f) => `${hashDe(f)}  ${f}`).join('\n') + '\n');
}

// Ferramenta ou configuração ausente não é código errado. A fase que instala
// destrava o comando; até lá ele é adiado. `.loop/ferramentas.json` guarda o que
// já passou: se voltar a "não encontrado", alguém removeu — reprova.
const AUSENTE = [
  /is not recognized as an internal or external command/i,
  /command not found/i,
  /ERR_PNPM_NO_SCRIPT/i,
  /ERR_PNPM_RECURSIVE_EXEC_FIRST_FAIL.*not found/i,
  /Missing script:/i,                    // npm
  /npm (?:ERR!|error) could not determine executable/i,
  /npx canceled due to missing packages/i,
  /Script not found/i,                   // bun
  /executable not found/i,
  /: not found/i,
  /couldn't find an eslint\.config/i,
  /No ESLint configuration found/i,
  /error TS5057|error TS5058/,
];
// O pnpm 10 imprime `ERR_PNPM_RECURSIVE_EXEC_FIRST_FAIL Command "playwright" not
// found` depois de QUALQUER saída não-zero do Playwright via `-C dir exec` — com
// os 14 casos listados como `failed` logo acima. Se o runner deixou rastro de que
// rodou, "not found" é mentira do gerenciador, não ferramenta ausente.
const rodou = (s) => /Running \d+ tests?|\b\d+ (?:passed|failed)\b|Test Files|Tests:|^\s*(?:ℹ|#)\s*tests\b/m.test(s);
const ausente = (s) => !rodou(s) && AUSENTE.some((p) => p.test(s));

// ─── Imports relativos de um teste ───────────────────────────────────────────
// Usado duas vezes: (1) teste verde numa fase de teste só é aceito se tudo que
// ele importa já existia e não foi tocado; (2) teste travado cujo alvo ainda não
// existe é PENDENTE — a fase de implementação dele vem depois.

function resolverImport(de, spec) {
  const base = posix.normalize(posix.join(posix.dirname(de), spec));
  const cands = [base, `${base}.ts`, `${base}.tsx`, `${base}.mjs`, `${base}.js`,
    base.replace(/\.js$/, '.ts'), base.replace(/\.mjs$/, '.mts'), `${base}/index.ts`];
  return cands.find((p) => existsSync(p) && statSync(p).isFile()) ?? null;
}

function importsRelativos(arquivo) {
  const txt = readFileSync(arquivo, 'utf8');
  const specs = [...txt.matchAll(/(?:from\s+|import\s*\(\s*|import\s+)['"](\.{1,2}\/[^'"]+)['"]/g)].map((m) => m[1]);
  return [...new Set(specs)].map((s) => ({
    spec: s,
    alvo: norm(posix.normalize(posix.join(posix.dirname(arquivo), s))),
    resolvido: resolverImport(arquivo, s),
  }));
}

// ─── Contagem de testes passando ─────────────────────────────────────────────
// Nunca pode cair. Pega o `"test": "exit 0"` e o projeto removido do workspace
// mesmo quando a fase tem permissão de mexer no package.json.

function contarPassou(saida) {
  const t = semAnsi(saida);
  let n = 0, achou = false;
  for (const m of t.matchAll(/Tests\s+(?:\d+\s+\w+\s*\|\s*)*(\d+)\s+passed/g)) { n += Number(m[1]); achou = true; }
  for (const m of t.matchAll(/^\s*(?:ℹ|#)\s*pass\s+(\d+)/gm)) { n += Number(m[1]); achou = true; }
  // Playwright: "  14 passed (1.2m)"
  for (const m of t.matchAll(/^\s*(\d+)\s+passed\s+\(/gm)) { n += Number(m[1]); achou = true; }
  // Jest: "Tests:       1 failed, 3 passed, 4 total"
  for (const m of t.matchAll(/^Tests:\s+(?:\d+\s+\w+,\s+)*(\d+)\s+passed/gm)) { n += Number(m[1]); achou = true; }
  // pytest: "==== 3 passed in 0.12s ===="
  for (const m of t.matchAll(/^=+\s.*?\b(\d+) passed\b.*=+$/gm)) { n += Number(m[1]); achou = true; }
  return achou ? n : null;
}

// ═════════════════════════════════════════════════════════════════════════════
// --lock
// ═════════════════════════════════════════════════════════════════════════════

if (process.argv.includes('--lock')) {
  const lista = testes();
  if (!lista.length) { console.log(c.red('nenhum arquivo de teste encontrado.')); process.exit(1); }
  const antes = new Set(lerLock().map((x) => x.f));
  travar(lista);
  // A contagem que o juiz apurou nesta fase só vale quando a fase inteira passou.
  if (existsSync(CONTAGEM_PEND)) { renameSync(CONTAGEM_PEND, CONTAGEM); }
  lista.forEach((f) => console.log(antes.has(f) ? `  mantido: ${f}` : c.grn(`  travado: ${f}`)));
  process.exit(0);
}

// ═════════════════════════════════════════════════════════════════════════════
// --prova — um gate que você viu aprovar não provou nada
// ═════════════════════════════════════════════════════════════════════════════

if (process.argv.includes('--prova')) {
  if (!existsSync(LOCK)) { console.log(c.red('sem lock — rode uma fase antes')); process.exit(1); }
  if ((git('status', '--porcelain') ?? 'x').trim()) { console.log(c.red('árvore suja — commite antes')); process.exit(1); }

  const sha = git('rev-parse', 'HEAD').trim();
  const umTeste = lerLock()[0]?.f;
  // Um fonte da aplicação para quebrar o código: de preferência em src/. Vale
  // qualquer linguagem da web — o projeto pode ser JS puro, sem typecheck.
  const fontes = varrer('.', (p) => /\.(tsx?|jsx?|[cm]js|vue|svelte)$/.test(p)
    && !TESTE_RE.test(p) && !/\.d\.ts$/.test(p) && !/config/.test(p));
  const umFonte = fontes.find((p) => p.includes('/src/') || p.startsWith('src/')) ?? fontes[0];
  // Alvo INFRA que exista AQUI: os scripts do loop podem estar fora do projeto.
  const umInfra = INFRA.filter((f) => !f.endsWith('/')).find((f) => existsSync(f));
  if (!umTeste || !umFonte || !umInfra) { console.log(c.red('faltam arquivos para sabotar')); process.exit(1); }

  const FASE_PROVA = '.loop/prova-fase.json';
  const contexto = (extra = {}) => writeFileSync(FASE_PROVA, JSON.stringify({
    n: 0, titulo: 'prova', tipo: 'impl', sha, arquivos: ['*'], reservados: [], ultima: false, ...extra,
  }));
  // process.argv[1]: este mesmo arquivo, onde quer que ele esteja — o juiz pode
  // rodar de fora do projeto (`node C:\dev\loop-kit\judge.mjs --prova`).
  const verde = () => spawnSync('node', [process.argv[1], '--fase', FASE_PROVA], { stdio: 'ignore', shell: WIN }).status === 0;
  const restaurar = () => { git('reset', '-q', '--hard', sha); git('clean', '-fdq'); contexto(); };

  contexto();
  if (!verde()) { console.log(c.red('o juiz já está reprovando — conserte antes')); process.exit(1); }
  console.log(c.grn('sanidade: verde antes de sabotar\n'));

  // Nasce ao lado de um teste travado, com a extensão e o runner dele.
  const ext = umTeste.match(/\.(test|spec)\.(\w+)$/)[2];
  const NOVO = `${posix.dirname(umTeste)}/__prova.test.${ext}`;
  // O runner vem das DEPENDÊNCIAS, nunca da extensão: num projeto Vitest os testes
  // podem ser `.js`, e um teste `node:test` plantado ali roda o callback mas não
  // registra suíte — o Vitest reporta "No test suite found", o juiz lê como
  // vermelho e a sabotagem 10 passa por acidente de runner.
  const VERDE = DEPS.vitest ? "import { it, expect } from 'vitest';\nit('x', () => { expect(1).toBe(1); });\n"
    : DEPS.jest ? "import { it, expect } from '@jest/globals';\nit('x', () => { expect(1).toBe(1); });\n"
    : "import test from 'node:test';\nimport assert from 'node:assert';\ntest('x', () => { assert.equal(1, 1); });\n";
  const casos = [
    ['1. alterar um teste travado', () => appendFileSync(umTeste, '\n// sabotagem\n')],
    ['2. apagar um teste travado', () => unlinkSync(umTeste)],
    ['3. plantar .only num teste', () => appendFileSync(umTeste, '\nit.only("x", () => {});\n')],
    ['4. plantar .skip num teste', () => appendFileSync(umTeste, '\nit.skip("x", () => {});\n')],
    ['5. quebrar o código', () => appendFileSync(umFonte, '\nconst x: number = "texto";\n')],
    [`6. mexer em ${umInfra}`, () => appendFileSync(umInfra, '\n<!-- sabotagem -->\n')],
    ['7. trocar o comando de teste por `exit 0`', () => {
      const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
      pkg.scripts = { ...pkg.scripts, test: 'exit 0' };
      writeFileSync('package.json', JSON.stringify(pkg, null, 2) + '\n');
    }],
    [`8. mexer em ${umInfra} E COMMITAR`, () => {
      appendFileSync(umInfra, '\n<!-- sabotagem commitada -->\n');
      git('commit', '-qam', 'sabotagem');
    }],
    ['9. tocar arquivo fora do escopo da fase', () => {
      contexto({ arquivos: [umTeste] });
      appendFileSync(umFonte, '\n// fora do escopo\n');
    }],
    ['10. teste nascendo verde numa fase de teste', () => {
      contexto({ tipo: 'teste', arquivos: [NOVO], ultima: false });
      writeFileSync(NOVO, VERDE);
    }],
  ];

  let pegas = 0;
  for (const [nome, sabotar] of casos) {
    console.log(c.ylw(`== ${nome}`));
    sabotar();
    if (verde()) console.log(c.red('   FALHOU — o juiz APROVOU uma sabotagem'));
    else { console.log(c.grn('   OK — reprovou')); pegas++; }
    restaurar();
  }
  try { unlinkSync(FASE_PROVA); } catch {}

  console.log();
  if (pegas === casos.length) {
    console.log(c.grn(`${pegas}/${casos.length} sabotagens pegas. O árbitro é real.`));
    process.exit(0);
  }
  console.log(c.red(`${casos.length - pegas} passaram. NÃO rode sem supervisão.`));
  process.exit(1);
}

// ═════════════════════════════════════════════════════════════════════════════
// VERIFICAÇÃO
// ═════════════════════════════════════════════════════════════════════════════

const iFase = process.argv.indexOf('--fase');
const FASE = iFase > -1 ? JSON.parse(readFileSync(process.argv[iFase + 1], 'utf8')) : null;
const MANUAL = !FASE;
const SHA = FASE?.sha ?? (git('rev-parse', 'HEAD') ?? '').trim();

if (!/^[0-9a-f]{40}$/.test(SHA)) { reprovar(`SHA de referência inválido: "${SHA}"`); process.exit(1); }

// ─── 0. o que mudou desde o começo da fase ───────────────────────────────────
//
// Quem mudou NÃO se descobre pelo estado do arquivo. A versão anterior achava que
// "commitado = foi você" — e na fase 2 o agente rodou `git commit` e o juiz
// re-travou o arquivo agradecendo. O que vale é o diff contra o SHA gravado
// ANTES da sessão: pega mudança suja, staged, commitada e arquivo novo.

const diff = git('diff', '--name-only', SHA);
const novos = git('ls-files', '--others', '--exclude-standard');
if (diff === null || novos === null) { reprovar(`git não resolveu o diff contra ${SHA.slice(0, 8)}`); process.exit(1); }

const tocados = [...new Set([...linhas(diff), ...linhas(novos)])].map(norm).filter((f) => !f.startsWith('.loop/'));
const existiam = new Set(linhas(git('ls-tree', '-r', '--name-only', SHA)).map(norm));

console.log(c.ylw(`-- ${MANUAL ? 'modo manual' : `fase ${FASE.n} (${FASE.tipo})`} · ${tocados.length} arquivo(s) tocado(s) desde ${SHA.slice(0, 8)}`));

// ─── 1. infraestrutura ───────────────────────────────────────────────────────

for (const f of tocados.filter(ehInfra)) {
  if (MANUAL) { aviso(`infraestrutura alterada (modo manual, não reprova): ${f}`); continue; }
  reprovar(`INFRAESTRUTURA ALTERADA: ${f}`);
  console.log(c.red('  Este arquivo é do loop, não do projeto. Alterá-lo é mexer no juiz.'));
  console.log(c.red(`  Reverta: git checkout ${SHA.slice(0, 8)} -- ${f}`));
}

// ─── 2. escopo da fase ───────────────────────────────────────────────────────
//
// A ordem do tasks.md imposta por comando. Arquivo existente só pode ser alterado
// se uma tarefa desta fase o cita. Arquivo NOVO pode nascer dentro de um
// diretório citado (ou ao lado de um arquivo citado) — fixtures, componentes —
// desde que nenhuma OUTRA fase o reserve.

// Diferenças entre os tipos, todas pelo mesmo motivo — fase de teste não pode
// escrever implementação:
//
//   citação parcial (`index.ts` → packages/core/src/index.ts)   só impl
//   diretório citado libera ALTERAR arquivo existente            só impl
//   diretório citado libera arquivo NOVO                         impl sempre; teste só se
//                                                                o diretório ainda não existia
//
// `reservados` são arquivos de fases FUTURAS: nenhum tipo antecipa.
function permitido(f) {
  const A = FASE.arquivos.map(norm);
  const teste = FASE.tipo === 'teste';
  if (A.includes('*') || A.includes(f)) return true;
  // Lockfile é consequência de `install`, que tarefa nenhuma cita como arquivo.
  // Mexer nele não finge teste: ferramenta removida e contagem caindo reprovam.
  if (LOCKFILES.includes(f)) return true;
  // Configuração do projeto, em fase de implementação: o teste travado na fase 2
  // do sorteio-brindes-5 exigia Vitest em ambiente `node`, o scaffold tinha posto
  // `jsdom`, e nenhuma tarefa citava vitest.config.ts — três reprovações da
  // correção certa. O que impede abuso: contagem de testes nunca cai, hash dos
  // testes, e os comandos do juiz vêm do CLAUDE.md, não dos scripts.
  if (!teste && CONFIG_RE.test(f)) return true;
  // Ponto de entrada da aplicação, em fase de implementação. Toda fase de UI
  // termina ligando o que criou ao app, e plano nenhum lembra de citar o
  // `main.js` em todas as etapas: no sorteio-brindes-ralph-14 a fase 6 escreveu
  // o overlay e o card certos, precisou de uma linha no `src/main.js`, e o juiz
  // reprovou três vezes por escopo. O que segura o abuso continua de pé: teste
  // travado por hash, contagem que não cai e os comandos.
  if (!teste && ENTRADAS.includes(f)) return true;
  // Fase de testes cujo documento não nomeia os arquivos (o plano de teste do
  // ralphy-spec diz o que provar, não onde): arquivo de teste NOVO é sempre
  // permitido, e só ele. Alterar teste que já existe continua barrado abaixo,
  // pelo hash e por `existiam`.
  if (teste && TESTE_RE.test(f) && !existiam.has(f)) return true;

  const futuro = (FASE.reservados ?? []).map(norm).includes(f);
  const dirs = A.filter((a) => a.endsWith('/'));
  const arqs = A.filter((a) => !a.endsWith('/'));

  if (existiam.has(f)) {
    if (teste) return false;
    // O tasks.md escreve `index.ts` e `app.vue` quando o diretório já está no contexto.
    if (arqs.some((a) => f.endsWith(`/${a}`))) return true;
    return !futuro && dirs.some((d) => f.startsWith(d));
  }

  if (futuro) return false;
  const dirsDeArquivos = arqs
    .filter((a) => !teste || TESTE_RE.test(a))
    .map((a) => posix.dirname(a)).filter((d) => d && d !== '.').map((d) => `${d}/`);
  const dirsNovos = teste ? dirs.filter((d) => ![...existiam].some((e) => e.startsWith(d))) : dirs;
  return [...dirsNovos, ...dirsDeArquivos].some((d) => f.startsWith(d));
}

if (!MANUAL) {
  const fora = tocados.filter((f) => !ehInfra(f) && !permitido(f));
  if (fora.length) {
    reprovar(`${fora.length} arquivo(s) FORA DO ESCOPO da fase ${FASE.n}:`);
    fora.forEach((f) => console.log(c.red(`   ${f}${existiam.has(f) ? '' : ' (novo)'}`)));
    console.log(c.red('  Nenhuma tarefa desta fase cita esses arquivos. Eles são de outra fase.'));
    console.log(c.red('  Desfaça só eles. Não antecipe tarefa: a ordem do tasks.md é o contrato.'));
  }
}

// ─── 3. integridade dos testes travados ──────────────────────────────────────

const lock = lerLock();
for (const { h, f } of lock) {
  if (!existsSync(f)) { reprovar(`teste APAGADO: ${f}`); continue; }
  if (hashDe(f) !== h) {
    reprovar(`teste ALTERADO: ${f}`);
    console.log(c.red('  O teste é o contrato. Conserte a implementação, não o teste.'));
    console.log(c.red(`  Reverta com: git checkout -- ${f}`));
  }
}
if (!lock.length) aviso('sem lock ainda');

// ─── 4. nenhum teste desligado ───────────────────────────────────────────────

const lista = testes();
for (const f of lista) {
  if (/\b(it|test|describe)\.(only|skip|todo)\b|\.each\.skip\b/.test(readFileSync(f, 'utf8'))) {
    reprovar(`teste desligado ou focado em ${f}`);
    console.log(c.red('  Vale para skip condicional também. Cenário de um viewport só: use page.setViewportSize.'));
  }
}

if (falhou) {
  console.log(c.red('\n==== Reprovado nas travas. A suíte nem rodou. ===='));
  process.exit(1);
}

const jaFuncionou = lerJson(HIST);
const contagem = lerJson(CONTAGEM);
const novaContagem = { ...contagem };

// ═════════════════════════════════════════════════════════════════════════════
// 5a. FASE DE TESTE — o teste tem que nascer VERMELHO
//
// Esta é a janela em que o teste é honesto: a implementação ainda não existe,
// então ele não pode ser moldado para caber nela. A versão anterior exigia
// `pnpm test` verde em toda fase, e a fase que escrevia os testes implementou
// junto para passar — 38 testes verdes numa fase sem tarefa de implementação.
// ═════════════════════════════════════════════════════════════════════════════

function comandoVermelho(f) {
  if (/(^|\/)e2e\//.test(f)) {
    // Playwright roda com a config do app, não da raiz (monorepo).
    const [dir, resto] = f.split(/\/?e2e\//);
    if (!dir) return exec('playwright', 'test', f);
    return GERENCIADOR === 'pnpm'
      ? ['pnpm', '-C', dir, 'exec', 'playwright', 'test', `e2e/${resto}`]
      : ['npx', '--no-install', '--prefix', dir, 'playwright', 'test', `e2e/${resto}`];
  }
  if (DEPS.vitest) return exec('vitest', 'run', f);
  if (DEPS.jest) return exec('jest', '--runTestsByPath', f);
  return ['node', '--test', f];
}

if (FASE?.tipo === 'teste') {
  // O documento pode não nomear os arquivos de teste (o plano de teste do
  // ralphy-spec diz o que provar, não onde escrever). Então: os citados, ou, na
  // falta deles, os arquivos de teste que a fase acabou de criar. Sem nenhum dos
  // dois, a fase não escreveu teste nenhum — aí sim reprova.
  const novosNaFase = tocados.filter((f) => TESTE_RE.test(f) && !existiam.has(f));
  // Alvo citado sem diretório (`csv.test.js`, como o plano do ralphy-spec escreve)
  // vale onde quer que o agente o tenha criado: `tests/csv.test.js`. Sem isto o
  // juiz dizia "teste não foi escrito" com o arquivo pronto ao lado — três
  // tentativas e impasse (sorteio-brindes-ralph-3, fase 2).
  const resolver = (a) => {
    if (existsSync(a) || a.includes('/')) return a;
    const achados = testes().filter((f) => f.endsWith(`/${a}`));
    return achados.length === 1 ? achados[0] : a;
  };
  const citados = FASE.arquivos.map(norm).filter((a) => TESTE_RE.test(a)).map(resolver);
  const alvosFase = citados.length ? citados : novosNaFase;
  if (!alvosFase.length) reprovar('fase de teste sem nenhum arquivo de teste: nada foi escrito');
  // Teste já travado citado de novo (a T032 cita invariantes.test.ts para dizer
  // "não altere este, crie outro") não é teste novo: o hash já cuida dele.
  const travados = new Set(lock.map((x) => x.f));
  const alvos = alvosFase.filter((a) => !travados.has(a));

  const escritos = alvos.filter((f) => {
    if (!existsSync(f)) { reprovar(`teste não foi escrito: ${f}`); return false; }
    const t = readFileSync(f, 'utf8');
    if (!/\b(it|test)\s*\(/.test(t) || !/\b(expect|assert)\b/.test(t)) {
      reprovar(`${f} não tem caso com asserção`);
    }
    return true;
  });

  // Lint agora, enquanto o arquivo ainda pode mudar. Teste travado com erro de
  // lint seria impasse na fase de implementação: nem passa, nem pode ser editado.
  if (escritos.length) {
    console.log(c.ylw('-- lint dos testes novos'));
    const r = rodar(exec('eslint', ...escritos));
    process.stdout.write(resumir(r.saida));
    if (r.status !== 0 && !ausente(r.saida)) reprovar('lint dos testes novos falhou');
  }

  for (const f of escritos) {
    console.log(c.ylw(`-- vermelho esperado: ${f}`));
    const r = rodar(comandoVermelho(f));
    process.stdout.write(resumir(r.saida));

    if (/No test files found|No tests found/i.test(r.saida)) {
      reprovar(`${f} não é coletado pelo runner — este teste nunca rodaria`);
      continue;
    }
    if (ausente(r.saida)) { reprovar(`runner ausente para ${f}`); continue; }
    if (r.status !== 0) { console.log(c.grn('   vermelho, como deve')); continue; }

    // Verde. Só é legítimo se for teste de regressão: tudo que ele importa já
    // existia antes da fase e nada disso foi tocado agora.
    const imps = importsRelativos(f);
    const regressao = imps.length
      && imps.every((i) => i.resolvido && existiam.has(norm(i.resolvido)) && !tocados.includes(norm(i.resolvido)));
    if (regressao) { aviso(`${f} verde: teste de regressão de código que já existia`); continue; }

    reprovar(`${f} nasceu VERDE`);
    console.log(c.red('  Nesta fase só existe teste. Teste verde aqui significa implementação escrita'));
    console.log(c.red('  junto, ou teste que não importa o que diz testar. Os dois anulam o TDD.'));
  }
}

// ═════════════════════════════════════════════════════════════════════════════
// 5b. FASE DE IMPLEMENTAÇÃO (e modo manual) — os comandos do projeto
// ═════════════════════════════════════════════════════════════════════════════

// Teste travado cujo alvo ainda não existe é PENDENTE: a implementação dele é de
// uma fase posterior. Não pode ser pendente se:
//   - esta fase cita o alvo (ela tem que criá-lo)
//   - o alvo existia no começo da fase (foi apagado — o escopo já pegou)
//   - é a última fase (tudo é devido)
//
// Alvo que EXISTE mas está reservado por fase futura também é pendente: o
// adaptador dividiu a implementação da US2 em 1/2 e 2/2 com os testes da story
// inteira já travados, e os componentes eram esqueletos da 2/2. A 1/2 reprovou
// três vezes por teste que ela não tinha permissão de fazer passar.
const RESERVADOS = (FASE?.reservados ?? []).map(norm);
const casa = (alvo, p) => {
  // NodeNext: o teste importa `../src/x.js` e o arquivo é `x.ts`.
  const sem = alvo.replace(/\.[cm]?[jt]sx?$/, '');
  return p === alvo || new RegExp(`^${sem.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\.[cm]?[jt]sx?$`).test(p);
};
function pendentes() {
  if (FASE?.ultima) return [];
  const daFase = (FASE?.arquivos ?? []).map(norm);
  return lock.map((x) => x.f).filter((f) => existsSync(f) && importsRelativos(f).some((i) => {
    if (daFase.some((a) => casa(i.alvo, a))) return false;
    if (RESERVADOS.some((r) => casa(i.alvo, r))) return true;
    return !i.resolvido && ![...existiam].some((e) => casa(i.alvo, e));
  }));
}

// A falha só é aceitável se TODO arquivo do repositório citado nas linhas de erro
// for um teste pendente ou um arquivo reservado por fase futura (o esqueleto que
// lança). Nenhum arquivo identificável = não dá para provar = reprova.
function falhaSoEmPendentes(saida, pend) {
  const repo = [...new Set([...existiam, ...tocados])];
  const raiz = norm(process.cwd()).toLowerCase() + '/';
  const citados = new Set();
  for (const l of semAnsi(saida).split('\n')) {
    if (/✓|√|\bpassed\b|^\s*(ℹ|#)\s*pass\b/.test(l)) continue;
    for (const m of l.matchAll(/(?:[A-Za-z]:)?[\w@.\-\\/[\]]+\.(?:[cm]?[jt]sx?|vue)/g)) {
      let t = norm(m[0]);
      if (t.toLowerCase().startsWith(raiz)) t = t.slice(raiz.length);
      repo.filter((p) => p === t || p.endsWith(`/${t}`)).forEach((p) => citados.add(p));
    }
  }
  return citados.size > 0 && [...citados].every((p) => pend.includes(p) || RESERVADOS.includes(p));
}

// Só caminho ABSOLUTO dentro do repositório (formato do `node arquivo.mjs`). Import
// relativo de teste não entra aqui — isso é pendente, e tem a própria regra.
function moduloDoRepoAusente(saida) {
  const raiz = norm(process.cwd()).toLowerCase() + '/';
  for (const m of semAnsi(saida).matchAll(/Cannot find module '([^']+)'/g)) {
    const abs = norm(m[1]);
    if (!abs.toLowerCase().startsWith(raiz)) continue;
    const rel = abs.slice(raiz.length);
    if (!existsSync(rel)) return rel;
  }
  return null;
}

if (FASE?.tipo !== 'teste') {
  const pend = pendentes();
  if (pend.length) aviso(`${pend.length} teste(s) travado(s) aguardam fase posterior: ${pend.join(', ')}`);

  // Fase futura ainda reserva implementação: o e2e não tem como estar verde.
  // Sem nenhum spec e2e no repositório, o Playwright sai 1 ("No tests found").
  const implPendente = (FASE?.reservados ?? []).some((a) => !TESTE_RE.test(norm(a)));
  const semE2e = !testes().some((f) => /(^|\/)e2e\//.test(f));

  if (!CMDS.length) {
    reprovar('nenhum comando de verificação: declare em CLAUDE.md (## Comandos, bloco de código), em scripts do package.json, ou em JUDGE_CMDS');
  } else {
    aviso(`comandos (${ORIGEM_CMDS}): ${CMDS.join(' · ')}`);
  }

  let adiou = false;
  for (const cmd of CMDS) {
    if (ehE2e(cmd) && (implPendente || semE2e)) {
      aviso(`${cmd}: adiado — ${semE2e ? 'nenhum spec e2e ainda' : 'fase posterior ainda reserva implementação'}`);
      continue;
    }
    console.log(c.ylw(`-- ${cmd}`));
    const r = rodar(cmd);
    process.stdout.write(resumir(r.saida));

    let aceito = r.status === 0;
    if (aceito) jaFuncionou[cmd] = true;

    if (!aceito && pend.length && falhaSoEmPendentes(r.saida, pend)) {
      aviso(`${cmd}: falha restrita a testes pendentes — aceita`);
      aceito = true;
    }

    // `node scripts/verificar-tokens.mjs` no lint, definido na T001, com o script
    // nascendo na T019. Módulo do repositório que ainda não existe é ausência, não
    // erro — a menos que ESTA fase cite o arquivo: aí era obrigação dela criá-lo.
    const faltando = !aceito && moduloDoRepoAusente(r.saida);
    if (faltando && (FASE?.arquivos ?? []).map(norm).includes(faltando)) {
      reprovar(`${cmd}: \`${faltando}\` não existe, e esta fase deveria criá-lo`);
      continue;
    }

    if (!aceito && (faltando || ausente(r.saida))) {
      if (jaFuncionou[cmd]) {
        reprovar(`${cmd}: a ferramenta sumiu — este comando já funcionou antes`);
      } else {
        aviso(`ferramenta ou configuração ainda não existe — ${cmd} adiado`);
        adiou = true;
      }
      continue;
    }

    if (!aceito) { reprovar(`${cmd} falhou`); continue; }

    const n = contarPassou(r.saida);
    const antes = contagem[cmd] ?? 0;
    if (n === null && antes > 0) {
      reprovar(`${cmd}: saída sem contagem de testes — antes passavam ${antes}`);
    } else if (n !== null && n < antes) {
      reprovar(`${cmd}: ${n} teste(s) passando, antes eram ${antes} — teste sumiu ou deixou de rodar`);
    } else if (n !== null) {
      novaContagem[cmd] = n;
    }
  }

  if (adiou && !existsSync('package.json')) {
    reprovar('nenhum comando pôde rodar e não há package.json — a fase não produziu nada');
  }
}

mkdirSync('.loop', { recursive: true });
writeFileSync(HIST, JSON.stringify(jaFuncionou, null, 2) + '\n');

// ─── 6. trava os testes novos ────────────────────────────────────────────────
// Fase de teste: trava VERMELHO, antes de a implementação existir.
// Fase de implementação: trava os que nasceram junto com ela.

if (!falhou) {
  const antes = new Set(lock.map((x) => x.f));
  const recem = lista.filter((f) => !antes.has(f));
  if (SEM_TRAVAR) {
    // Aprovado aqui, mas a fase ainda não acabou: guarda a contagem e deixa os
    // testes destravados até `--lock`. O agente ainda pode precisar corrigi-los.
    writeFileSync(CONTAGEM_PEND, JSON.stringify(novaContagem, null, 2) + '\n');
    if (recem.length) aviso(`${recem.length} teste(s) novo(s) — travam quando a fase fechar`);
  } else {
    writeFileSync(CONTAGEM, JSON.stringify(novaContagem, null, 2) + '\n');
    if (recem.length) {
      travar(lista);
      aviso(`${recem.length} teste(s) novo(s) travado(s) por hash`);
      recem.forEach((f) => console.log(c.ylw(`   ${f}`)));
    }
  }
}

console.log();
// Sob o loop (--sem-travar) o veredito completo é dele: 'Juiz 1' e 'Juiz 2ª opinião'
// na mesma caixa. Avulso, o juiz assina sozinho.
if (falhou) { console.log(c.red(SEM_TRAVAR ? '==== JUIZ ====' : '==== JUIZ: REPROVADO ====')); process.exit(1); }
console.log(c.grn(SEM_TRAVAR ? '==== JUIZ ====' : '==== JUIZ: APROVADO ===='));
process.exit(0);
