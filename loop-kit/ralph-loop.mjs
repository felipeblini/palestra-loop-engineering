#!/usr/bin/env node
/**
 * ralph-loop.mjs — executa um documento de fases, uma sessão de agente por fase.
 *
 *   node ralph-loop.mjs                    openspec/changes/<change>/project-phases.md (specloop), senão o tasks.md
 *   node ralph-loop.mjs <arquivo.md>       outro documento
 *   node ralph-loop.mjs --ate 4            para depois da fase 4 (primeira execução, acordado)
 *   node ralph-loop.mjs --desde 5          retoma na fase 5 (fases anteriores já commitadas)
 *   node ralph-loop.mjs --verboso          saída crua do agente e do juiz na tela (padrão: resumida, tarefa atual)
 *   node ralph-loop.mjs --sem-segunda-opiniao   só o juiz (demo curta)
 *   node ralph-loop.mjs --listar           só mostra as fases (tipo, tarefas, arquivos)
 *   node ralph-loop.mjs --com-mcp          deixa a sessão usar servidores MCP (padrão: nenhum)
 *   node ralph-loop.mjs --max-fases 4      recusa começar se o documento virar mais fases
 *   node ralph-loop.mjs --modelo sonnet --esforco medium   repassados ao `claude` das fases
 *   node ralph-loop.mjs --demo             palco: --sem-segunda-opiniao --max-fases 4
 *   node ralph-loop.mjs --tentativas 2     sessões por fase antes de desistir (padrão: 3)
 *
 * O ciclo, por fase: implementa → juiz → segunda opinião → commit.
 * Falhou? Volta com a CAUSA. Três tentativas (--tentativas N). Na última, o loop para.
 *
 * Cada fase tem tipo (teste|impl) e arquivos, derivados do tasks.md. O loop grava o SHA
 * antes da sessão e entrega tudo ao juiz em `.loop/fase.json` DEPOIS que a sessão
 * termina — o agente não tem como alargar o próprio escopo.
 */

import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync, mkdirSync, appendFileSync, readdirSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

// O juiz mora ao lado deste arquivo, não no projeto. Assim o loop pode rodar de
// fora — `node C:\dev\loop-kit\ralph-loop.mjs` dentro da cobaia — e os dois scripts
// ficam fora da árvore que o agente vê, do `git add -A` e do `eslint .`.
const JUDGE = fileURLToPath(new URL('judge.mjs', import.meta.url));

const ARGS = process.argv.slice(2);
const numArg = (nome) => {
  const i = ARGS.indexOf(nome);
  if (i === -1) return null;
  const n = Number(ARGS[i + 1]);
  if (!Number.isInteger(n) || n < 1) { console.error(`${nome} precisa de um número inteiro ≥ 1`); process.exit(1); }
  return n;
};
// Valor livre repassado ao `claude`. Vai na linha de comando do cmd.exe: sem espaço.
const strArg = (nome) => {
  const i = ARGS.indexOf(nome);
  if (i === -1) return null;
  const v = ARGS[i + 1];
  if (!v || !/^[\w.:\[\]-]+$/.test(v)) { console.error(`${nome} precisa de um valor sem espaço`); process.exit(1); }
  return v;
};
const COM_VALOR = ['--ate', '--desde', '--max-fases', '--modelo', '--esforco', '--tentativas'];
const posicional = ARGS.filter((a, i) => !a.startsWith('--') && !COM_VALOR.includes(ARGS[i - 1]));
const DEMO = ARGS.includes('--demo');

// Sem argumento: o project-phases.md do specloop (uma change em openspec/changes/), senão o
// tasks.md do Spec Kit ou do OpenSpec, senão o documento de fases do adaptar.mjs.
function acharFases() {
  if (existsSync('.spec/init/project-phases.md')) return '.spec/init/project-phases.md';
  const unico = (base) => {
    if (!existsSync(base)) return null;
    const dirs = readdirSync(base).filter((d) => d !== 'archive' && existsSync(join(base, d, 'tasks.md')));
    if (dirs.length !== 1) return null;
    // project-phases.md vence: é o contrato estrito, sem heurística. `phases.md` é o
    // nome do specloop 0.7 (cobaias brindes-ralph, -2). O tasks.md fica para quem não
    // gera nenhum dos dois (ralphy-spec, Spec Kit).
    const achado = ['project-phases.md', 'phases.md', 'tasks.md']
      .map((f) => join(base, dirs[0], f)).find((f) => existsSync(f));
    return achado;
  };
  // Spec Kit: specs/<feature>/tasks.md · OpenSpec: openspec/changes/<change>/tasks.md
  return unico('openspec/changes') ?? unico('specs') ?? 'specs/*/tasks.md';
}

const CFG = {
  tentativas: numArg('--tentativas') ?? 3,   // por fase; a última reprovação para o loop
  fases: posicional[0] ?? acharFases(),
  desde: numArg('--desde') ?? 1,
  ate: numArg('--ate'),
  juiz: ['node', JUDGE],
  modeloVerificador: 'sonnet',
  maxEsperas: 20,
  esperaPadraoSeg: 1800,
  bufferResetSeg: 60,
  dir: '.loop',
  // Tela resumida (tarefa atual, juiz resumido) é o padrão: a saída crua vai para o
  // .loop/*.log de qualquer jeito. `--log` continua aceito, e não muda nada.
  log: !ARGS.includes('--verboso'),
  // Demo curta: só o juiz. Contra-dado: a 2ª opinião pegou uma falta real na fase 4
  // da execução 2 do financia. ~1 min por fase.
  semSegundaOpiniao: DEMO || ARGS.includes('--sem-segunda-opiniao'),
  comMcp: ARGS.includes('--com-mcp'),        // servidores MCP na sessão (padrão: nenhum)
  // Etapa vira duas fases, e cada fase custa uma sessão. O plano com fase demais
  // estoura o palco: melhor saber no preflight do que na fase 5.
  maxFases: numArg('--max-fases') ?? (DEMO ? 4 : null),
  // Só as sessões das fases. A 2ª opinião tem o modelo dela (modeloVerificador).
  argsAgente: [
    ...(strArg('--modelo') ? ['--model', strArg('--modelo')] : []),
    ...(strArg('--esforco') ? ['--effort', strArg('--esforco')] : []),
  ],
};

const WIN = process.platform === 'win32';
const c = {
  r: (s) => `\x1b[31m${s}\x1b[0m`,
  g: (s) => `\x1b[32m${s}\x1b[0m`,
  y: (s) => `\x1b[33m${s}\x1b[0m`,
  d: (s) => `\x1b[2m${s}\x1b[0m`,
};

mkdirSync(CFG.dir, { recursive: true });
const LOG = join(CFG.dir, `loop-${new Date().toISOString().replace(/[:.]/g, '-')}.log`);
const semAnsi = (s) => String(s).replace(/\x1b\[[0-9;]*[A-Za-z]/g, '');
const log = (m) => { VISOR.limpar(); console.log(m); appendFileSync(LOG, semAnsi(m) + '\n'); };
const soLog = (m) => appendFileSync(LOG, semAnsi(m) + '\n');   // detalhe: só no arquivo

let BASE = '';

// ═════════════════════════════════════════════════════════════════════════════
// 1. Invocar o agente
//
// O prompt vai por STDIN. Nenhum argumento da linha de comando contém espaço.
//
// Por quê: no Windows o `claude` é um .cmd, então o Node precisa de `shell: true`
// para executá-lo — e o cmd.exe corta qualquer argumento no primeiro espaço.
// Passar o prompt como argumento entregava a primeira palavra; passar o caminho
// de um arquivo entregava a palavra "Leia". Por stdin nada é interpretado.
//
// A saída vem em `stream-json`: uma linha JSON por evento. Com `text` o CLI só
// imprime no fim, e o terminal fica mudo por cinco minutos. Aqui cada tool_use
// vira uma linha (`Write src/core/sac.ts`) na hora em que acontece. O que volta
// para o loop continua sendo o texto final do agente, mais a linha `result` crua
// (é nela que aparece `"api_error_status":429`) e o stderr.
// ═════════════════════════════════════════════════════════════════════════════

// No Windows o .cmd exige shell, e o Node 24 avisa (DEP0190) quando recebe array de
// argumentos junto com shell. Nenhum argumento tem espaço, então a string é igual.
const comando = (bin, args, opts, fn = spawn) =>
  WIN ? fn([bin, ...args].join(' '), { ...opts, shell: true }) : fn(bin, args, opts);

function resumoFerramenta(nome, input = {}) {
  const curto = (s, n = 90) => String(s ?? '').replace(/\s+/g, ' ').slice(0, n);
  const rel = (p) => String(p ?? '').replaceAll('\\', '/').replace(process.cwd().replaceAll('\\', '/') + '/', '');
  if (input.file_path) return `${nome} ${rel(input.file_path)}`;
  if (input.command) return `${nome} ${curto(input.command)}`;
  if (input.pattern) return `${nome} ${curto(input.pattern)}`;
  if (input.description) return `${nome} ${curto(input.description)}`;
  return nome;
}

// Qual tarefa o agente está fazendo? Ele não diz; mas escreve em arquivos, e cada
// tarefa cita os seus. Write/Edit num arquivo citado por T008 = "está na T008".
// Ele também escreve por Bash (`cat > src/core/x.ts <<'EOF'`), então o comando conta.
function tarefaDoArquivo(tarefas, caminho) {
  const p = String(caminho ?? '').replaceAll('\\', '/').replace(process.cwd().replaceAll('\\', '/') + '/', '');
  return tarefas.find((t) => t.arquivos.some((a) => (a.endsWith('/') ? p.startsWith(a) : p === a || p.endsWith(`/${a}`))));
}
function tarefaDoComando(tarefas, comando) {
  const cmd = String(comando ?? '');
  const scaffold = tarefas.find((t) => t.arquivos.includes('*'));   // escopo total: qualquer comando é dela
  if (scaffold) return scaffold;
  if (!/(?:^|[^>])>(?!>)|>>|\btee\b|\bsed -i|\bcp\b|\bmv\b/.test(cmd)) return null;
  return tarefas.find((t) => t.arquivos.some((a) => !a.endsWith('/') && cmd.includes(a)));
}

// ─── Visor: uma linha por tarefa, barra de tarefas da fase, spinner com o tempo ──
// Nada de Bash, Read, texto do agente: isso vai para o .log. O projetor mostra o
// que a plateia entende: "está na T007, 3 de 5, há 2 min".
const VISOR = {
  timer: null, t0: 0, ultimaLinhaSpinner: false,
  quadros: ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'], q: 0,
  tempo() { const s = Math.round((Date.now() - this.t0) / 1000); return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`; },
  limpar() { if (this.ultimaLinhaSpinner) { process.stdout.write('\r' + ' '.repeat(40) + '\r'); this.ultimaLinhaSpinner = false; } },
  iniciar() {
    this.t0 = Date.now();
    if (!CFG.log || !process.stdout.isTTY) return;
    this.timer = setInterval(() => {
      this.q = (this.q + 1) % this.quadros.length;
      process.stdout.write(`\r   ${c.d(`${this.quadros[this.q]} ${this.tempo()}`)}`);
      this.ultimaLinhaSpinner = true;
    }, 200);
  },
  parar() { if (this.timer) { clearInterval(this.timer); this.timer = null; } this.limpar(); },
};
const barraTarefas = (feitas, total) => `${'▮'.repeat(feitas)}${'▯'.repeat(Math.max(0, total - feitas))}`;

function agente(prompt, { mostrar = true, args = [], rotulo = 'fase', tarefas = [] } = {}) {
  let tarefaAtual = null;
  const iniciadas = new Set();
  // Cópia em disco só para você inspecionar. O agente não sabe que existe.
  try { writeFileSync(join(CFG.dir, `prompt-${rotulo}.txt`), prompt, 'utf8'); } catch {}

  const env = { ...process.env };
  delete env.CLAUDECODE;   // senão o CLI aninhado se comporta como sessão filha

  // Com --log, o que não é tarefa vai só para o arquivo.
  const mostrarOuLog = (m) => (CFG.log ? soLog(m) : log(m));
  if (mostrar) VISOR.iniciar();

  return new Promise((resolve) => {
    const p = comando(
      'claude',
      // `--strict-mcp-config` sem `--mcp-config`: nenhum servidor MCP na sessão.
      // Na fase da tela do sorteio-brindes-10 o agente abriu o Playwright, navegou
      // e tirou screenshots para comparar com os mocks — bonito, e vários minutos.
      // A fase é julgada por comando, não por olho. `--com-mcp` traz de volta.
      ['-p', '--dangerously-skip-permissions', '--output-format', 'stream-json', '--verbose',
       ...(CFG.comMcp ? [] : ['--strict-mcp-config']), ...args],
      { env, stdio: ['pipe', 'pipe', 'pipe'] },
    );

    let resultado = '';       // texto final do agente
    let ultimoTexto = '';     // para não imprimir o mesmo texto duas vezes
    let resultLinha = '';     // evento `result` cru
    let stderr = '';
    let resto = '';
    let usoImpresso = false;

    const evento = (linha) => {
      let e;
      try { e = JSON.parse(linha); } catch { if (mostrar) mostrarOuLog(c.d(`   ${linha.slice(0, 200)}`)); return; }

      if (e.type === 'assistant') {
        for (const b of e.message?.content ?? []) {
          if (b.type === 'tool_use' && mostrar) {
            const t = /^(Write|Edit|MultiEdit|NotebookEdit)$/.test(b.name) ? tarefaDoArquivo(tarefas, b.input?.file_path)
              : /^(Bash|PowerShell)$/.test(b.name) ? tarefaDoComando(tarefas, b.input?.command) : null;
            if (t && t !== tarefaAtual) {
              tarefaAtual = t;
              iniciadas.add(t.id);
              VISOR.limpar();
              log(c.g(`   ▶ ${t.id} ${t.texto.slice(0, 110)}${t.texto.length > 110 ? '…' : ''}`));
              if (CFG.log) log(c.d(`   ${barraTarefas(iniciadas.size, tarefas.length)} ${iniciadas.size}/${tarefas.length} · ${VISOR.tempo()}`));
            }
            mostrarOuLog(c.d(`   ▸ ${resumoFerramenta(b.name, b.input)}`));
          }
          if (b.type === 'text' && mostrar && b.text?.trim()) {
            ultimoTexto = b.text.trim();
            mostrarOuLog(c.d(`   ${ultimoTexto.split('\n').map((l) => l.trim()).filter(Boolean).slice(0, 3).join(' ⏎ ').slice(0, 240)}`));
          }
        }
      } else if (e.type === 'rate_limit_event' && mostrar && !usoImpresso) {
        // Uma vez por sessão: para saber, antes da palestra, quanto sobrou da janela.
        const w = e.rate_limit_info?.unifiedWindows;
        if (w?.five_hour && w?.seven_day) {
          usoImpresso = true;
          log(c.d(`   uso: 5h ${Math.round(w.five_hour.utilization * 100)}% · 7d ${Math.round(w.seven_day.utilization * 100)}%`));
        }
      } else if (e.type === 'result') {
        resultado = typeof e.result === 'string' ? e.result : '';
        resultLinha = linha;
      }
    };

    p.stdout.setEncoding('utf8').on('data', (d) => {
      resto += d;
      const linhas = resto.split('\n');
      resto = linhas.pop();
      for (const l of linhas) if (l.trim()) evento(l);
    });
    p.stderr.setEncoding('utf8').on('data', (d) => { stderr += d; });

    const fim = (code) => {
      if (resto.trim()) evento(resto);
      if (mostrar) VISOR.parar();
      const primeira = resultado.trim().split('\n')[0];
      if (mostrar && primeira && primeira !== ultimoTexto.split('\n')[0]) mostrarOuLog(`   ${primeira.slice(0, 300)}`);
      if (mostrar && CFG.log) log(c.d(`   sessão encerrada em ${VISOR.tempo()} · ${iniciadas.size}/${tarefas.length} tarefa(s) tocadas`));
      // Ordem importa: limite() lê as últimas 20 linhas.
      const saida = [resultado, resultLinha, stderr].filter(Boolean).join('\n');
      // `texto` é só a resposta do agente. `saida` leva também o evento `result` cru
      // e o stderr (é neles que o limite de uso aparece) — ruim para ler o veredito.
      resolve({ saida, texto: resultado, code: code ?? 1 });
    };
    p.on('error', (err) => { stderr += `\n${err.message}`; fim(1); });
    p.on('close', fim);

    p.stdin.on('error', () => {});
    p.stdin.end(prompt);
  });
}

// ═════════════════════════════════════════════════════════════════════════════
// 2. Limite de uso
//
// O Claude Code não tem UMA mensagem de limite. Sem isto, o limite mata a sessão
// em segundos, o juiz reprova, e as três tentativas queimam em um minuto — com o
// loop achando que o código está errado.
// ═════════════════════════════════════════════════════════════════════════════

const PADROES = [
  /usage limit reached/i,
  /hit your (session|usage|\d+-hour) limit/i,
  /\d+-hour limit reached/i,
  /"api_error_status"\s*:\s*429/i,
];

function limite(texto) {
  // Só a cauda: um "429" no meio da saída de teste do projeto não é limite de uso.
  const cauda = texto.split('\n').slice(-20).join('\n');
  if (!PADROES.some((p) => p.test(cauda))) return null;

  const epoch = cauda.match(/usage limit reached\|(\d{9,})/i);
  if (epoch) return Number(epoch[1]) * 1000;

  // "resets 10pm", "resets 10:30pm", "resets at 22:00"
  const hora = cauda.match(/resets?\s+(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/i);
  if (hora) {
    const [, hh, mm = '0', ap] = hora;
    const d = new Date();
    let h = Number(hh);
    if (ap?.toLowerCase() === 'pm' && h < 12) h += 12;
    if (ap?.toLowerCase() === 'am' && h === 12) h = 0;
    d.setHours(h, Number(mm), 0, 0);
    if (d.getTime() <= Date.now()) d.setDate(d.getDate() + 1);
    return d.getTime();
  }
  return Date.now() + CFG.esperaPadraoSeg * 1000;
}

const dormir = (ms) => new Promise((r) => setTimeout(r, ms));

// ═════════════════════════════════════════════════════════════════════════════
// 3. Parser de fases
//
// Contrato rígido: só `## Phase N: `. Qualquer outro heading de nível 2 cortaria
// uma fase ao meio e o agente receberia meia instrução, sem nenhum sinal.
// ═════════════════════════════════════════════════════════════════════════════

function lerFases(caminho) {
  if (!existsSync(caminho)) { log(c.r(`não encontrei ${caminho}`)); process.exit(1); }
  const texto = readFileSync(caminho, 'utf8');

  // tasks.md do Spec Kit: sem metadados, com headings que não são fase
  // (## Format, ## Dependencies...). O loop deriva tipo e arquivos na hora.
  if (!/<!--\s*loop:/.test(texto)) return lerTasksSpecKit(texto, caminho);

  const ruins = (texto.match(/^## .*$/gm) ?? []).filter((h) => !/^## Phase \d+: /.test(h));
  if (ruins.length) {
    log(c.r('heading de nível 2 fora do contrato:'));
    ruins.forEach((h) => log(c.r(`   ${h}`)));
    process.exit(1);
  }

  const blocos = texto.match(/^## Phase \d+:[\s\S]*?(?=^## Phase \d+:|$(?![\s\S]))/gm) ?? [];
  if (!blocos.length) { log(c.r('nenhuma fase. O formato é: ## Phase 1: Titulo')); process.exit(1); }

  // project-phases.md do specloop: gerado de um tasks.md cujo sha256 vai no cabeçalho. Se o
  // tasks.md mudou depois, o escopo aqui é de outro plano — recusar custa um comando;
  // executar custa a noite.
  const origem = texto.match(/<!--\s*specloop:\s*(\{[\s\S]*?\})\s*-->/);
  if (origem) {
    const { fonte, sha256 } = JSON.parse(origem[1]);
    const arq = join(dirname(caminho), fonte);
    if (existsSync(arq) && createHash('sha256').update(readFileSync(arq)).digest('hex') !== sha256) {
      log(c.r(`${caminho} foi gerado de outra versão do ${fonte}. Rode de novo: specloop phases`));
      process.exit(1);
    }
  }

  // Metadados em comentário HTML: o agente não precisa do JSON, precisa da linha
  // legível **Arquivos desta fase**. O project-phases.md traz só as tarefas; as regras e o
  // "Pronto quando" são do loop e entram aqui.
  // Tarefa: `- [ ] T001 ...` ou `- [ ] 1.1 ...`, mais as linhas recuadas (CRIA,
  // Casos, Import) — é lá que estão os arquivos e a interface.
  const TAREFA_RE = /^- \[ \]\s*(T\d+|\d+\.\d+)\s*(.*(?:\n[ \t]+\S.*)*)/gm;
  const fases = blocos.map((bruto) => {
    const m = bruto.match(/<!--\s*loop:\s*(\{[\s\S]*?\})\s*-->/);
    const meta = m ? JSON.parse(m[1]) : null;
    let corpo = bruto.replace(/<!--\s*loop:[\s\S]*?-->\n?/, '').trim();
    if (meta && !corpo.includes('**Arquivos desta fase:**')) {
      const lista = meta.arquivos.map((a) => `\`${a}\``).join(', ');
      corpo += `\n\n**Arquivos desta fase:** ${lista || '(nenhum citado)'}\n\n${REGRAS}\n\n**Pronto quando:** ${meta.tipo === 'teste'
        ? `${lista} existe(m), é(são) coletado(s) pelo runner e FALHA(M) — a implementação só vem na fase seguinte.`
        : `o verificador externo sai 0, e ${lista || 'o projeto'} existe(m) com a implementação completa — sem TODO, sem placeholder.`}`;
    }
    return {
      // Sem o "Phase N:": o loop numera sozinho, e o commit saía `feat(phase-1): Phase 1: ...`.
      titulo: bruto.split('\n')[0].replace(/^#+\s*(?:Phase \d+:\s*)?/, ''),
      corpo,
      primeira: (bruto.match(/- \[ \]\s*(T\d+|\d+\.\d+)/) ?? [])[1] ?? null,
      tarefas: [...bruto.matchAll(TAREFA_RE)].map((x) => {
        const txt = x[2].replace(/\[P\]\s*/g, '').replace(/\s+/g, ' ').trim();
        return { id: x[1], texto: txt, arquivos: caminhos(txt) };
      }),
      meta,
    };
  });

  const semMeta = fases.filter((f) => !f.meta);
  if (semMeta.length) {
    log(c.r(`${semMeta.length} fase(s) sem metadados de escopo (<!-- loop: {...} -->).`));
    log(c.r('Gere de novo: specloop phases'));
    process.exit(1);
  }
  return fases;
}

// ═════════════════════════════════════════════════════════════════════════════
// 3b. tasks.md do Spec Kit, direto
//
// Era o adaptar.mjs. Com o template enxuto (duas fases por story, sem esqueleto)
// não há o que redimensionar; sobrou derivar `tipo` e `arquivos` de cada fase e
// separar teste de implementação quando o template não foi seguido. Isso cabe
// aqui, e a palestra fica com duas peças em vez de três.
// ═════════════════════════════════════════════════════════════════════════════

const EXT = /\.(?:[cm]?[jt]sx?|json|ya?ml|css|scss|vue|html|md|txt|svg|png|csv)$/i;
const TESTE_RE = /\.(test|spec)\.[cm]?[jt]sx?$/;

// Caminho citado SEM crase: `src/core/sorteio.ts` escrito no meio da frase. Nem
// todo gerador de spec usa crase (o ralphy-spec mistura), e exigir o formato
// seria pedir ao usuário que soubesse do loop. Spec fica de fora: uma tarefa que
// diz "confira openspec/project.md" não pode liberar a edição da própria spec.
const SOLTO_RE = /(?:^|[\s("'])((?:[\w.@-]+\/)+[\w.@-]+\.\w{1,5})(?=$|[\s,;:)"'.])/g;
const SPEC_RE = /^(?:openspec|specs|\.specify|\.spec)\//;
// Entrada e infraestrutura: o juiz nunca deixa tocar, então citá-las não é escopo.
// Uma tarefa "conferir contra design/mocks/" daria à fase um escopo que só contém
// arquivos proibidos — pior do que escopo nenhum.
const INFRA_RE = /^(?:design\/|openspec\/|specs\/|\.specify\/|\.spec\/|judge\.mjs$|loop\.mjs$|CLAUDE\.md$|AGENTS\.md$)/;

// Todo caminho entre crases: arquivo (por extensão ou dotfile) ou diretório com
// barra. O escopo da fase é a união do que as tarefas dela citam.
function caminhos(texto) {
  const out = [];
  for (const m of texto.matchAll(/`([^`\s]+)`/g)) {
    const p = m[1].replace(/\\/g, '/').replace(/^\.\//, '');
    if (p === '*') { out.push('*'); continue; }   // escopo total: a fase de scaffold cria a árvore inteira
    if (/[*@(){}=:,'"<>$]/.test(p) || /^[\d/]/.test(p) || p.includes('..')) continue;   // `/sortear` é rota, não pasta
    if (/^\.[\w-]+$/.test(p) && EXT.test(`x${p}`)) continue;        // `.css` é extensão, não arquivo
    if (EXT.test(p) || /^\.[\w-]+$/.test(p)) { out.push(p); continue; }
    if (p.includes('/') && !/\.\w+$/.test(p.split('/').filter(Boolean).pop() ?? '')) {
      out.push(p.endsWith('/') ? p : `${p}/`);
    }
  }
  // Depois das crases, para não bagunçar a ordem (o primeiro arquivo decide se a
  // tarefa é de teste): caminhos soltos na prosa. Entrada de design e spec ficam
  // de fora — "confira openspec/project.md" não libera editar a spec.
  for (const m of texto.matchAll(SOLTO_RE)) {
    const p = m[1].replace(/\\/g, '/');
    if (EXT.test(p) && !SPEC_RE.test(p) && !p.startsWith('design/') && !p.includes('..')) out.push(p);
  }
  return [...new Set(out)].filter((p) => !INFRA_RE.test(p));
}

// Tarefa de teste é a que ESCREVE um teste: o primeiro arquivo citado é um teste.
const tipoTarefa = (t) => {
  const primeiro = t.arquivos.find((a) => !a.endsWith('/'));
  return primeiro && TESTE_RE.test(primeiro) ? 'teste' : 'impl';
};

const REGRAS = [
  '**Regras desta fase** (a constitution vence em qualquer conflito):',
  '- NUNCA altere, desabilite ou remova um teste existente para fazer a suíte passar.',
  '- A verificação que vale é a do processo externo, não a que você rodou na sessão.',
  '- Dúvida que a spec não cobre vai para `.loop/duvidas.md` antes de seguir.',
].join('\n');

// Spec Kit: "## Phase 1: Título" (ou "## Fase 1:"). OpenSpec: "## 1. Título".
// ralphy-spec: "## Etapa 1 — Título". O separador pode ser :, —, - ou nada.
const FASE_RE = /^(?:(?:Phase|Fase|Etapa|Step)\s+\d+\s*[:—–-]?|\d+\.)\s*/i;

function lerTasksSpecKit(texto, caminho) {
  const blocos = texto.split(/^## /m).slice(1)
    .filter((b) => FASE_RE.test(b.split('\n')[0]));
  if (!blocos.length) { log(c.r(`nenhum "## Phase N:" / "## Fase N:" / "## N." em ${caminho}`)); process.exit(1); }

  // Uma fase do Spec Kit → uma ou mais fases do loop (teste e impl nunca dividem sessão).
  const fases = [];
  for (const bloco of blocos) {
    const linhas = bloco.split('\n');
    // "## 1. [ ] Andaime do projeto": a caixa no título do grupo não é conteúdo.
    const titulo = linhas[0].replace(FASE_RE, '').replace(/^\[\s*[xX]?\s*\]\s*/, '').trim();
    // Uma linha cada (o Spec Kit escreve assim); ler o bloco inteiro engolia a
    // primeira tarefa dentro do Goal.
    const campo = (rotulo) => (linhas.find((l) => l.startsWith(`**${rotulo}**:`)) ?? '')
      .replace(`**${rotulo}**:`, '').trim() || null;
    const goal = campo('Goal');
    const indep = campo('Independent Test');
    // O que provar antes de programar, do jeito que cada gerador escreve:
    //   "**Plano de teste.** ..."            (parágrafo, até a linha em branco)
    //   "### Testar antes de programar"      (subseção, até o próximo ###)
    // Sem isso, um documento que não separa teste de implementação vira uma fase
    // `impl` só, e o teste nasce junto com o código.
    const plano = (() => {
      // Qualquer subtítulo que fale de teste antes de programar, do jeito que cada
      // rodada do gerador escolheu escrever: "Testar antes de programar",
      // "Testes da Etapa 2 — escrever antes de programar", "Plano de teste".
      const iSub = linhas.findIndex((l) => /^#{3,}[^\n]*(?:\btest\w*\b[^\n]*\bantes\b|\btests?\b[^\n]*\bbefore\b|plano de testes?|test plan)/i.test(l.trim()));
      if (iSub > -1) {
        const out = [];
        for (const l of linhas.slice(iSub + 1)) { if (/^#{2,}\s/.test(l)) break; out.push(l.trim()); }
        return out.join(' ').replace(/\s+/g, ' ').trim() || null;
      }
      // "**Plano de teste**", "**Teste:** test/csv.test.js — ...", "**Test plan**".
      const iPar = linhas.findIndex((l) => /^\*\*(?:plano de testes?|test plan|testes?|tests?)\b/i.test(l.trim()));
      if (iPar === -1) return null;
      const out = [];
      for (const l of linhas.slice(iPar)) { if (!l.trim() && out.length) break; out.push(l.trim()); }
      return out.join(' ').replace(/^\*\*[^*]+\*\*\.?\s*/, '').replace(/\s+/g, ' ').trim() || null;
    })();

    // Tarefa = linha `- [ ] Txxx ...` mais as continuações indentadas (é lá que
    // ficam os valores esperados).
    const tarefas = [];
    let atual = null;
    const fechar = () => {
      if (!atual) return;
      const texto = atual.linhas.join(' ').replace(/\s+/g, ' ').trim();
      tarefas.push({ id: atual.id, texto, arquivos: caminhos(texto) });
      atual = null;
    };
    for (const l of linhas.slice(1)) {
      // T001, 1.1, ou nada: o ralphy-spec escreve `- [ ] Criar o projeto...` sem
      // identificador. Exigir ID seria exigir que o gerador conhecesse o loop; o
      // loop numera o que encontrar, na ordem do documento.
      const t = l.match(/^\s*-\s*\[\s*[ xX]?\s*\]\s*\*{0,2}(?:(T\d+|\d+\.\d+)\s+)?(.*)$/);
      if (t) { fechar(); atual = { id: t[1] ?? `T${String(tarefas.length + 1).padStart(3, '0')}`, linhas: [t[2]] }; }
      // Sub-bullet de dois espaços ("  - Cria: `src/lib/csv.js`") é continuação da
      // tarefa: é lá que o ralphy-spec diz quais arquivos ela cria.
      else if (atual && /^\s{2,}\S/.test(l)) atual.linhas.push(l.trim());
      else if (!l.trim() || !/^\s/.test(l)) fechar();
    }
    fechar();

    // Grupo sem nenhuma caixa: o gerador escreveu só bullets ("- Criar o projeto
    // na raiz..."). Vale como tarefa, mas apenas o que vem ANTES do plano de
    // teste — os bullets do plano descrevem o que provar, não o que fazer.
    if (!tarefas.length) {
      const fim = linhas.findIndex((l) => /^(?:#{3,}|\*\*)[^\n]*(?:\btest\w*\b|plano de testes?|test plan)/i.test(l.trim()));
      const ate = fim === -1 ? linhas.length : fim;
      for (const l of linhas.slice(1, ate)) {
        const m = l.match(/^\s*[-*]\s+(?!\[)(.*)$/);
        if (m && m[1].trim()) {
          const txt = m[1].replace(/\s+/g, ' ').trim();
          tarefas.push({ id: `T${String(tarefas.length + 1).padStart(3, '0')}`, texto: txt, arquivos: caminhos(txt) });
        }
      }
    }
    if (!tarefas.length) continue;

    // O arquivo pode estar no título do grupo — "## 2. Parser de CSV
    // (`src/lib/csv.js`)" — e não nas tarefas. Sem isto a fase fica sem escopo.
    const doTitulo = caminhos(titulo);

    const trechos = [];
    for (const t of tarefas) {
      // Com plano de teste separado, TODO item é implementação: o item cita o
      // teste que deve ficar verde ("*Teste:* ui-brindes.test.js verde") e a
      // heurística do primeiro arquivo o classificaria como tarefa de teste.
      // Com plano de teste separado, item é implementação — salvo o item que só
      // toca arquivo de teste ("Escrever os testes da lógica pura"), que pertence
      // à fase de testes.
      const soTestes = t.arquivos.length > 0 && t.arquivos.every((a) => TESTE_RE.test(a));
      const tipo = plano ? (soTestes ? 'teste' : 'impl') : tipoTarefa(t);
      const ult = trechos[trechos.length - 1];
      if (ult && ult.tipo === tipo) ult.tarefas.push(t); else trechos.push({ tipo, tarefas: [t] });
    }

    // Documento que não separa teste de implementação, mas descreve o que testar
    // (o ralphy-spec escreve "**Plano de teste.** ..." em cada grupo): o plano
    // vira uma fase de TESTES antes da implementação. Sem isso o grupo inteiro é
    // uma fase `impl` e o teste nasce junto com o código — que é exatamente o que
    // o loop existe para impedir. Quem cita arquivo de teste nas tarefas já vem
    // separado acima e não passa por aqui.
    // Projeto ainda vazio: o primeiro grupo é o scaffold. Teste antes do código
    // não se aplica — não há runner instalado para ficar vermelho — e o escopo é
    // a árvore inteira, que ele vai criar.
    const scaffold = !fases.length && !existsSync('package.json');

    if (!scaffold && trechos.length === 1 && trechos[0].tipo === 'impl' && plano) {
      // Do plano só entram no escopo os arquivos de TESTE que ele nomeia. O resto
      // (`src/csv.js` citado como alvo do teste) é da fase de implementação.
      const tarefaTeste = { id: 'T000', texto: plano, arquivos: caminhos(plano).filter((a) => TESTE_RE.test(a)) };
      trechos.unshift({ tipo: 'teste', tarefas: [tarefaTeste], doPlano: true });
    }

    if (trechos.length > 1) log(c.y(`   separada: "${titulo}" → ${trechos.map((x) => `${x.tipo} (${x.tarefas.length})`).join(' → ')}`));

    trechos.forEach((tr, i) => {
      const citados = [...new Set([...tr.tarefas.flatMap((t) => t.arquivos), ...(tr.tipo === 'impl' ? doTitulo : [])])];
      // Fase de implementação de um grupo com plano de teste: os arquivos de teste
      // que os itens citam são os que devem ficar verdes, não os que ela pode
      // editar. Ficam fora do escopo.
      const doGrupo = plano && tr.tipo === 'impl' ? citados.filter((a) => !TESTE_RE.test(a)) : citados;
      // Fase de implementação que não cita arquivo nenhum (itens descritivos, do
      // tipo "área de importação com arrastar e clicar"): o escopo vira a árvore
      // inteira. Perde-se o gate de escopo nesta fase; seguram o resto os testes
      // travados por hash, a contagem que não cai e os comandos do juiz. É melhor
      // do que escopo vazio, em que o agente não pode escrever nada.
      const semEscopo = !scaffold && tr.tipo === 'impl' && !doGrupo.length;
      if (semEscopo) log(c.y(`   escopo total: "${titulo}" não cita arquivo nenhum`));
      const arquivos = scaffold || semEscopo ? ['*'] : doGrupo;
      const testes = arquivos.filter((a) => TESTE_RE.test(a));
      const pronto = tr.tipo === 'teste'
        ? tr.doPlano
          ? 'os arquivos de teste que esta fase criar (em `tests/` ou ao lado do código, com um caso por afirmação do plano acima) são coletados pelo runner e FALHAM — nenhuma implementação agora; ela vem na fase seguinte.'
          : `${testes.map((a) => `\`${a}\``).join(', ')} existe(m), com um caso por valor esperado listado acima, é(são) coletado(s) pelo runner e FALHA(M) — a implementação só vem na fase seguinte.`
        : indep && i === trechos.length - 1
          ? `o verificador externo sai 0 e o teste independente passa: ${indep}`
          : `o verificador externo sai 0, e ${arquivos.filter((a) => !a.endsWith('/')).map((a) => `\`${a}\``).join(', ') || 'o projeto'} existe(m) com a implementação completa — sem TODO, sem placeholder.`;
      const tituloFase = trechos.length > 1 ? `${titulo} — ${tr.tipo === 'teste' ? 'testes' : 'implementação'}` : titulo;
      fases.push({
        titulo: tituloFase,
        primeira: tr.tarefas[0].id,
        tarefas: tr.tarefas,
        meta: { tipo: tr.tipo, arquivos },
        corpo: [
          `## Phase ${fases.length + 1}: ${tituloFase}`, '',
          ...(goal ? [goal, ''] : []),
          ...tr.tarefas.map((t) => `- [ ] ${t.id} ${t.texto}`), '',
          `**Arquivos desta fase:** ${arquivos.length ? arquivos.map((a) => `\`${a}\``).join(', ') : '(nenhum citado)'}`, '',
          REGRAS, '', `**Pronto quando:** ${pronto}`,
        ].join('\n'),
      });
    });
  }
  return fases;
}

// ═════════════════════════════════════════════════════════════════════════════
// 4. O prompt
//
// Três coisas aprendidas apanhando:
//
//   a) A ordem de executar vai no FIM. No topo, ela fica soterrada sob 60 linhas
//      de tarefas e o agente volta ao modo "deixa eu me orientar primeiro".
//   b) Ela cita a primeira tarefa pelo ID. "Execute a fase" é abstrato;
//      "comece pela T001" é uma ação que ele reconhece na lista logo acima.
//   c) Proibir explicitamente o que ele faz por conta: resumir o projeto,
//      propor plano, pedir confirmação, investigar o loop.
// ═════════════════════════════════════════════════════════════════════════════

// A fase de testes não conhece a interface: ela está nas tarefas da fase seguinte.
// Sem ela, o agente abria proposal, specs e project.md para descobrir nomes de
// função — ~1 min de `cat` por sessão no sorteio-brindes-ralph-14.
function montarPrompt(fase, causa, proxima) {
  const teste = fase.meta.tipo === 'teste';
  const interfaceSeguinte = teste && proxima?.meta.tipo === 'impl' && proxima.tarefas?.length
    ? ['', 'Interface que a PROXIMA fase vai implementar (so referencia para os imports e nomes; nao implemente):',
       ...proxima.tarefas.map((t) => `- ${t.texto}`)].join('\n')
    : '';
  return [
    causa ? `A tentativa anterior foi REPROVADA. Causa:\n\n${causa}\n\n---\n` : '',
    fase.corpo,
    interfaceSeguinte,
    '',
    '---',
    '',
    // Cada sessão começava com `ls` e `find` na árvore inteira. Proibir também a spec
    // foi demais: no brindes-ralph a fase 2 escreveu "a spec não foi consultada" e
    // chutou quantos avatares existiam. Spec e proposal são a fonte da decisão.
    'Nao liste nem varra a arvore (ls, find, tree): os arquivos desta fase estao acima.',
    teste
      ? 'Abra o que as tarefas citam; na duvida sobre comportamento, leia a spec e o proposal da change antes de supor.'
      : 'Abra o que as tarefas citam e os testes que precisam passar; na duvida sobre comportamento, leia a spec e o proposal da change antes de supor.',
    teste
      ? `Escreva SO os testes agora${fase.primeira ? `, comecando pela ${fase.primeira}` : ''}, ate a ultima tarefa desta fase.`
      : `Escreva o codigo agora${fase.primeira ? `, comecando pela ${fase.primeira}` : ''}, ate a ultima tarefa desta fase.`,
    '',
    teste
      ? 'Nao crie nem altere implementacao. Os testes DEVEM falhar ao fim desta fase: o juiz reprova teste que nasce verde.'
      : '',
    // No brindes-ralph o teste da tela "importou" o CSV por um textarea que não existe
    // no mock, porque o agente achou que o jsdom não simula arquivo. A implementação
    // obedeceu ao teste, e a tela ganhou um campo e um botão a mais.
    teste
      ? 'Teste pela interface que o usuario usa (o input de arquivo, o botao do mock). Nao invente elemento so para o teste. No jsdom, escolher arquivo e: Object.defineProperty(input, "files", { value: [new File([texto], "x.csv")] }) e depois input.dispatchEvent(new Event("change")).'
      : '',
    // Documento que descreve a fase sem nomear arquivo ("Seção Participantes:
    // input de arquivo + drag-and-drop") entra aqui com escopo `*`. O gate de
    // escopo não pode ajudar; a instrução, sim.
    fase.meta.arquivos?.[0] === '*' && !teste
      ? 'O documento nao nomeia os arquivos desta fase. Escreva apenas o necessario para os testes desta fase passarem: crie o que falta e NAO altere arquivo de fase anterior que ja esta verde.'
      : 'Toque so os arquivos de "Arquivos desta fase". Nao antecipe tarefa de outra fase, mesmo que parecer necessario.',
    'Nao faca commit e nao marque tarefa no tasks.md: o loop cuida dos dois.',
    '',
    'Voce esta num loop autonomo. Nao ha ninguem para responder pergunta.',
    '',
    'Nao peca confirmacao. Nao proponha plano. Nao resuma o estado do projeto.',
    'Nao investigue o loop nem leia .loop/. Nao altere arquivo de teste existente.',
    '',
    'Se a spec nao cobrir uma decisao, registre em .loop/duvidas.md a pergunta e a',
    'suposicao adotada, e siga. Nunca decida em silencio.',
    '',
    'Ao terminar, responda em UMA linha o que foi feito.',
  ].filter((l) => l !== '').join('\n');
}

// ═════════════════════════════════════════════════════════════════════════════
// 5. Os dois árbitros
// ═════════════════════════════════════════════════════════════════════════════

function juiz(fase, contexto) {
  // Escrito AGORA, depois da sessão — se o agente editou este arquivo, perdeu.
  writeFileSync(join(CFG.dir, 'fase.json'), JSON.stringify({ ...contexto, ...fase.meta }, null, 2));
  // `--sem-travar`: o hash dos testes só é gravado quando a fase inteira passa
  // (`travarTestes`, depois da 2ª opinião). Ver judge.mjs, bloco 6.
  const [bin, ...args] = [...CFG.juiz, '--fase', `${CFG.dir}/fase.json`, '--sem-travar'];
  const r = comando(bin, args, {
    stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8', maxBuffer: 32 * 1024 * 1024,
  }, spawnSync);
  const saida = `${r.stdout ?? ''}${r.stderr ?? ''}`;
  if (CFG.log) {
    // Só as linhas do próprio juiz (`-- ...`, `JUIZ REPROVOU`, `====`, veredito por
    // teste). A saída crua dos comandos vai para o arquivo de log.
    soLog(saida);
    for (const l of saida.split('\n')) {
      // As linhas vermelhas do juiz ficam no log; o loop resume o motivo em amarelo.
      if (/^(--|====)|^\s{3}(vermelho|travado)/.test(semAnsi(l))) console.log(l);
    }
  } else {
    process.stdout.write(saida);
  }
  return { ok: r.status === 0, saida };
}

// A única reprovação é FORA DO ESCOPO? Devolve os arquivos ({ f, novo }); senão null.
// Qualquer outra reprovação junto (teste vermelho, infra, trava) é do agente.
function soEscopo(saida) {
  const ls = semAnsi(saida).split('\n');
  const reprovas = ls.filter((l) => l.startsWith('JUIZ REPROVOU: '));
  if (reprovas.length !== 1 || !/FORA DO ESCOPO/.test(reprovas[0])) return null;
  const i0 = ls.indexOf(reprovas[0]);
  const fora = [];
  for (const l of ls.slice(i0 + 1)) {
    const m = l.match(/^ {3}(\S.*?)( \(novo\))?$/);
    if (!m) break;
    fora.push({ f: m[1], novo: !!m[2] });
  }
  return fora.length ? fora : null;
}

// Fase fechada: trava o hash dos testes e promove a contagem apurada pelo juiz.
function travarTestes() {
  const [bin, ...args] = [...CFG.juiz, '--lock'];
  const r = comando(bin, args, {
    stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8', maxBuffer: 8 * 1024 * 1024,
  }, spawnSync);
  const saida = `${r.stdout ?? ''}${r.stderr ?? ''}`;
  soLog(saida);
  const novos = semAnsi(saida).split('\n').filter((l) => l.includes('travado: '));
  if (novos.length) log(c.g(`   ${novos.length} teste(s) travado(s) por hash`));
}

// Barra de fases para o projetor: ▮▮▯▯▯
const barra = (n, total) => `${'▮'.repeat(n)}${'▯'.repeat(Math.max(0, total - n))}`;

async function segundaOpiniao(fase) {
  // Na fase de teste a implementação NÃO deve existir. Sem esta distinção o
  // verificador responde "FALTA - não implementado" e empurra o agente a implementar.
  const alvo = fase.meta.tipo === 'teste'
    ? ['Esta fase escreve SO testes; a implementacao ainda NAO deve existir, e isso esta correto.',
       'Verifique se cada tarefa tem teste com assercao sobre o valor esperado que ela cita.',
       '  FALTA - <caso ou valor esperado sem teste>']
    : ['  FALTA - <o que ainda nao esta implementado>'];
  const prompt = [
    'Voce e um verificador independente. NAO escreva nem edite nenhum arquivo.',
    'Leia o codigo real do repositorio. A ULTIMA LINHA da sua resposta e o veredito,',
    'sozinha na linha, sem nenhum outro texto, e e uma destas:',
    '  DONE',
    ...alvo,
    'Na duvida, responda FALTA.',
    '',
    fase.corpo,
  ].join('\n');

  const { saida, texto } = await agente(prompt, {
    mostrar: false,
    rotulo: 'verificacao',
    args: ['--allowedTools', 'Read,Glob,Grep', '--model', CFG.modeloVerificador],
  });

  // O veredito é a ÚLTIMA linha não vazia. `/^\s*DONE\b/m` exigia DONE no início da
  // linha: na fase 6 do sorteio-brindes-6 o verificador escreveu "…All 7 cases present
  // with hand-computed expected values. DONE" e o loop leu como FALTA — mandou o agente
  // corrigir um teste correto e já travado, e a fase desistiu em três tentativas.
  // FALTA na última linha vence, mesmo acompanhada de DONE.
  const ultima = (texto || saida).trim().split('\n').map((l) => l.trim()).filter(Boolean).pop() ?? '';
  const ok = /\bDONE\b/.test(ultima) && !/\bFALTA\b/.test(ultima);
  return { ok, veredito: ultima, saida };
}

// ═════════════════════════════════════════════════════════════════════════════
// 6. Git
// ═════════════════════════════════════════════════════════════════════════════

function git(...a) {
  try { return execFileSync('git', a, { encoding: 'utf8' }).trim(); }
  catch (e) { return `${e.stdout ?? ''}${e.stderr ?? ''}`; }
}

// ═════════════════════════════════════════════════════════════════════════════
// 7. Preflight — cada checagem é um erro que custaria uma sessão inteira
// ═════════════════════════════════════════════════════════════════════════════

function preflight() {
  log(c.y('== preflight'));

  if (process.env.ANTHROPIC_API_KEY) {
    log(c.r('ANTHROPIC_API_KEY está setada — sairia em token de API, não no plano.'));
    process.exit(1);
  }
  // `.loop/` não conta: o log desta execução nasce antes do preflight, e exigir
  // que cada projeto novo se lembre de ignorá-lo é exigir que o mundo conheça o
  // loop. O juiz já descarta `.loop/` do diff pelo mesmo motivo.
  const sujo = (git('status', '--porcelain') ?? '').split('\n')
    .filter((l) => l.trim() && !l.includes('.loop/'));
  if (sujo.length) {
    log(c.r('árvore suja. Commite ou guarde antes:'));
    log(sujo.join('\n'));
    process.exit(1);
  }
  // CLAUDE.md ou AGENTS.md: basta um. O ralphy-spec gera AGENTS.md; o Spec Kit, CLAUDE.md.
  if (!existsSync('CLAUDE.md') && !existsSync('AGENTS.md')) { log(c.r('faltando: CLAUDE.md ou AGENTS.md')); process.exit(1); }
  for (const f of [JUDGE, CFG.fases]) {
    if (!existsSync(f)) { log(c.r(`faltando: ${f}`)); process.exit(1); }
  }

  // Ponto de comparação: o SHA de agora, nunca o nome de uma branch. Em outra
  // branch o `git diff main..HEAD` falha e devolve vazio — e vazio é o que o
  // relatório leria como "nenhum teste alterado".
  // Retomar sem o estado do juiz é retomar sem as travas: os testes das fases
  // anteriores seriam travados de novo no estado em que estiverem agora.
  if (CFG.desde > 1 && !existsSync(join(CFG.dir, 'ferramentas.json'))) {
    log(c.r(`--desde ${CFG.desde} sem .loop/ferramentas.json — o estado do juiz se perdeu.`));
    log(c.r('Recomece do zero ou restaure .loop/.'));
    process.exit(1);
  }

  BASE = git('rev-parse', 'HEAD');
  if (!/^[0-9a-f]{40}$/.test(BASE)) { log(c.r('HEAD não resolve. O repositório tem commit?')); process.exit(1); }
  writeFileSync(join(CFG.dir, 'base.sha'), BASE + '\n');

  log(c.g(`preflight ok — base ${BASE.slice(0, 8)} em ${git('rev-parse', '--abbrev-ref', 'HEAD')}`));
}

// ═════════════════════════════════════════════════════════════════════════════
// 8. O loop
// ═════════════════════════════════════════════════════════════════════════════

async function executar() {
  const fases = lerFases(CFG.fases);
  log(c.g(`\n== ${fases.length} fase(s) de ${CFG.fases}`));
  fases.forEach((f, i) => log(c.d(`   ${i + 1}. ${f.titulo}`)));
  if (CFG.maxFases && fases.length > CFG.maxFases) {
    log(c.r(`${fases.length} fases, o limite é ${CFG.maxFases}. Refaça o plano com menos etapas (cada etapa vira teste + implementação).`));
    process.exit(1);
  }

  const t0 = Date.now();
  let esperas = 0;

  for (const [i, fase] of fases.entries()) {
    const n = i + 1;
    if (n < CFG.desde) continue;
    if (CFG.ate && n > CFG.ate) {
      log(c.y(`\n--ate ${CFG.ate}: parando antes da fase ${n}. Retome com: node ralph-loop.mjs --desde ${n}`));
      return { ok: true, min: Math.round((Date.now() - t0) / 60000), parou: null, pausa: n };
    }
    let causa = '';
    let ok = false;

    // O ponto de comparação desta fase. Tudo que mudar depois dele — sujo,
    // staged, commitado pelo agente, arquivo novo — é trabalho desta fase.
    const sha = git('rev-parse', 'HEAD');
    const contexto = {
      n, titulo: fase.titulo, sha,
      ultima: n === fases.length,
      // Só fases FUTURAS: antecipar é o problema. Arquivo de fase passada pode ser
      // tocado quando citado — a T064 existe para limpar o que as outras escreveram.
      reservados: [...new Set(fases.filter((_, j) => j > i).flatMap((f) => f.meta.arquivos)
        .filter((a) => !fase.meta.arquivos.includes(a) && !a.endsWith('/')))],
    };

    for (let t = 1; t <= CFG.tentativas; t++) {
      log(c.y(`\n[fase ${n}/${fases.length}] ${barra(n - 1, fases.length)} tentativa ${t}/${CFG.tentativas} — ${fase.titulo} [${fase.meta.tipo}]`));

      // O limite pode aparecer na sessão, no juiz ou na 2ª opinião. Em qualquer
      // um: dormir, sem consumir tentativa. Na execução 3 ele apareceu só na 2ª
      // opinião e o loop leu "You've hit your session limit" como veredito
      // FALTA — três vezes, e desistiu da fase com o juiz aprovando.
      const esperarLimite = async (texto) => {
        const reset = limite(texto);
        if (!reset || esperas >= CFG.maxEsperas) return false;
        esperas++;
        const ms = Math.max(0, reset - Date.now()) + CFG.bufferResetSeg * 1000;
        log(c.y(`   limite de uso — dormindo até ~${new Date(reset).toLocaleTimeString('pt-BR')}`));
        await dormir(ms);
        t--;                       // limite não consome tentativa
        return true;
      };

      const a = await agente(montarPrompt(fase, causa, fases[i + 1]), { rotulo: `fase-${n}`, tarefas: fase.tarefas ?? [], args: CFG.argsAgente });
      if (await esperarLimite(a.saida)) continue;

      let v = juiz(fase, contexto);
      if (await esperarLimite(v.saida)) continue;

      // Reprovou SÓ por escopo: desfazer os arquivos e julgar de novo custa segundos;
      // outra sessão para o agente desfazer custava ~3 min (fase 6 do -14, por um
      // `src/estilos.css`). Se o que sobrou não passa, a causa volta ao agente como sempre.
      const fora = soEscopo(v.saida);
      if (fora) {
        for (const { f, novo } of fora) {
          if (novo) rmSync(f, { force: true });
          else git('checkout', sha, '--', f);
        }
        log(c.y(`   Juiz 1: fora do escopo, desfeito pelo loop — ${fora.map((x) => x.f).join(', ')}`));
        v = juiz(fase, contexto);
      }

      if (!v.ok) {
        causa = semAnsi(v.saida).split('\n').slice(-40).join('\n');   // cor crua é token de lixo
        // Reprovar é o loop funcionando, não quebrando: amarelo, com o motivo, e a
        // próxima tentativa já anunciada. Vermelho fica para "desistindo".
        // Primeira reprovação + as linhas indentadas que a detalham (arquivos, comando).
        const ls = semAnsi(v.saida).split('\n');
        const i0 = ls.findIndex((l) => l.startsWith('JUIZ REPROVOU: '));
        const detalhe = i0 === -1 ? [] : ls.slice(i0 + 1).filter((l, i, arr) => /^\s{3}\S/.test(l) && arr.slice(0, i).every((x) => /^\s{3}\S/.test(x))).slice(0, 3).map((l) => l.trim());
        const motivo = i0 === -1 ? '' : [ls[i0].replace('JUIZ REPROVOU: ', ''), ...detalhe].join(' ');
        log(c.y(`   Juiz 1: reprovou — ${motivo.slice(0, 120)}${t < CFG.tentativas ? ` — o agente corrige na tentativa ${t + 1}` : ''}`));
        continue;
      }
      log(c.g('   Juiz 1: aprovado'));

      const s = CFG.semSegundaOpiniao ? { ok: true, saida: '', veredito: '' } : await segundaOpiniao(fase);
      if (await esperarLimite(s.saida)) continue;
      if (!s.ok) {
        causa = `O verificador independente reprovou: ${s.veredito}`;
        log(c.y(`   Juiz 2ª opinião: reprovou — ${s.veredito.slice(0, 120)}${t < CFG.tentativas ? ` — o agente corrige na tentativa ${t + 1}` : ''}`));
        continue;
      }
      log(c.g(CFG.semSegundaOpiniao ? '   Juiz 2ª opinião: pulado (--sem-segunda-opiniao)' : '   Juiz 2ª opinião: aprovado'));
      travarTestes();

      // Um commit por fase, mesmo que o agente tenha commitado no meio: o reset
      // --soft dobra os commits dele neste. O `git log` da manhã fica legível.
      git('reset', '--soft', sha);
      git('add', '-A');
      git('reset', '-q', '--', CFG.dir);   // `.loop/` é efêmero: nunca entra no commit
      if (git('diff', '--cached', '--name-only')) {
        git('commit', '-q', '-m', `feat(phase-${n}): ${fase.titulo}`);
        log(c.g(`   commit: feat(phase-${n})`));
      } else {
        log(c.y(`   fase ${n} aprovada sem nenhuma mudança — nada a commitar`));
      }
      ok = true;
      break;
    }

    // Parar é o certo: fase quebrada faz as seguintes construírem em cima de
    // fundação torta, e o diff da manhã fica impossível de revisar.
    if (!ok) {
      log(c.r(`\nDESISTINDO da fase ${n}: ${fase.titulo}`));
      log(c.r('Fases seguintes NÃO foram executadas.'));
      return { ok: false, min: Math.round((Date.now() - t0) / 60000), parou: n };
    }
  }
  return { ok: true, min: Math.round((Date.now() - t0) / 60000), parou: null };
}

// ═════════════════════════════════════════════════════════════════════════════
// 9. Relatório
// ═════════════════════════════════════════════════════════════════════════════

function relatorio(res) {
  const dif = git('diff', '--name-only', `${BASE}..HEAD`, '--', '*.test.ts', '*.spec.ts', '*.test.tsx', '*.test.mjs');
  const falhou = /fatal|unknown revision/i.test(dif);
  const duvidas = existsSync(join(CFG.dir, 'duvidas.md'))
    ? readFileSync(join(CFG.dir, 'duvidas.md'), 'utf8') : '';

  writeFileSync(join(CFG.dir, 'relatorio.md'), [
    `# ${new Date().toLocaleString('pt-BR')}`,
    '',
    `- branch \`${git('rev-parse', '--abbrev-ref', 'HEAD')}\` · base \`${BASE.slice(0, 8)}\``,
    `- ${res.min} min · ${res.pausa ? `PAUSADO antes da fase ${res.pausa} (--ate)` : res.ok ? 'COMPLETO' : `PAROU na fase ${res.parou}`}`,
    '',
    '## A trava aguentou?',
    '```',
    falhou ? `INCONCLUSIVO — o git não resolveu o range:\n${dif}`
      : dif ? `ATENÇÃO — testes no diff (confira se são NOVOS):\n${dif}`
      : 'SIM — nenhum teste existente foi alterado.',
    '```',
    '',
    '## Commits desta execução',
    '```', git('log', '--oneline', `${BASE}..HEAD`) || '(nenhum)', '```',
    '',
    duvidas ? `## O que o agente chutou\n\n${duvidas.split('\n').map((l) => `> ${l}`).join('\n')}\n` : '',
    '## Agora',
    '```',
    `node ${JUDGE} --prova    # prove que ele reprova`,
    `node ${JUDGE}            # rode você mesmo, de fora`,
    '```',
  ].join('\n'));

  log(res.pausa ? c.y(`\nPAUSADO em ${res.min} min. Rode: node ${JUDGE} --prova`)
    : res.ok ? c.g(`\nCOMPLETO em ${res.min} min — leia .loop/relatorio.md`)
             : c.y(`\nPAROU em ${res.min} min — leia .loop/relatorio.md`));
}

// ═════════════════════════════════════════════════════════════════════════════

// --listar: só mostra como o documento vira fases (tipo, tarefas, arquivos). Não
// toca em nada. É o que era `adaptar.mjs --relatorio`.
if (ARGS.includes('--listar')) {
  const fases = lerFases(CFG.fases);
  console.log(c.g(`${fases.length} fase(s) de ${CFG.fases}\n`));
  fases.forEach((f, i) => {
    console.log(`${String(i + 1).padStart(2)}. [${f.meta.tipo}] ${f.titulo}`);
    console.log(c.d(`    ${(f.corpo.match(/- \[ \] (?:T\d+|\d+\.\d+)/g) ?? []).length} tarefa(s) · ${f.meta.arquivos.join(', ') || '(nenhum arquivo citado)'}`));
  });
  if (CFG.maxFases && fases.length > CFG.maxFases) {
    console.log(c.r(`\n${fases.length} fases, o limite é ${CFG.maxFases}: o loop vai recusar.`));
    process.exit(1);
  }
  process.exit(0);
}

preflight();
const res = await executar();
relatorio(res);
process.exit(res.ok ? 0 : 1);
