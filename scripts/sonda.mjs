// A SONDA: um gravador. Enquanto o jogo roda, grava a cada segundo, em tempo real, num arquivo: o que foi feito naquele segundo (cliques,
// arrastos, roda, teclas, ferramenta e estado do jogo trocados, a câmera para onde foi) e tudo o que o jogo fez - por elemento e por linha
// de código, contado (nunca cronometrado: o que conta é o mesmo em qualquer máquina). Nada é julgado - nenhum limite, nenhum corte.
//
// Cada segundo traz:
//  AÇÕES       - eventos de entrada (com o alvo), arrastos (quantos px), mudanças do estado do jogo (`__state`), a câmera (de onde para onde);
//  CENA MUDOU  - elementos que apareceram ou sumiram, e cada número de um elemento que mudou (de -> para): objetos, malhas, instâncias,
//                triângulos, vértices, geometrias, bytes de geometria, texturas, bytes de textura, quantos projetam sombra;
//  DESENHO     - cada elemento e passe (cena, sombra, ortográfica): chamadas, triângulos, vértices, instâncias;
//  ATUALIZA    - cada elemento: matriz mudou, visibilidade trocou, nº de instâncias e faixa de desenho mudaram, atributos/índice/texturas
//                reenviados (bytes), materiais alterados;
//  CRIA        - cada elemento: objetos, geometrias, materiais e texturas que nasceram e que sumiram;
//  WEBGL       - cada chamada WebGL: quantas, bytes; as que criam, apagam, enviam, compilam ou leem do driver com a linha do código;
//  CHAMADAS    - cada função do jogo e quantas vezes foi chamada (contagem exata do V8);
//  ALOCA       - cada linha do jogo e os bytes de memória JS que alocou (amostragem do V8);
//  WORKERS     - workers criados; mensagens para e de cada worker/porta, bytes, com a linha;
//  TIMERS, EVENTOS, REDE, INDEXEDDB, STORAGE - por chamada e linha; DOM - mutações por parte da interface;
//  MEMÓRIA     - heap JS, geometrias, texturas e programas do renderer, e quanto mudaram.
// Ela não traz o trabalho de dentro dos workers (só as mensagens com a página).
//
// Uso (com `npm run dev` rodando):
//   node scripts/sonda.mjs              abre o jogo num Chrome do Playwright, com janela, para jogar; grava até a janela fechar
//   node scripts/sonda.mjs --roteiro    sem janela: a cidade parada, jogando e a câmera andando em três vistas, gravando do mesmo jeito
//   [--seed 7] [--seconds 5 (por cenário do roteiro)] [--views cidade:1,bairro:4,rua:14]
// Arquivos (escritos a cada segundo): test-results/sonda/registro.txt (legível) e test-results/sonda/registro.jsonl (um segundo por linha).
import { appendFileSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { SourceMapConsumer } from 'source-map-js';
import { arg, lookAt, openCity } from './lib/measureCity.mjs';

const ABERTURA = process.argv.includes('--abertura');
const ROTEIRO = process.argv.includes('--roteiro') || ABERTURA;
const SECONDS = Number(arg('--seconds', '5'));
const VIEWS = arg('--views', 'cidade:1,bairro:4,rua:14').split(',').map((v) => { const [name, zoom] = v.split(':'); return { name, zoom: Number(zoom) }; });
const BASE = arg('--base', 'http://127.0.0.1:5300/');
const OUT = 'test-results/sonda';
const TXT = join(OUT, 'registro.txt'), JSONL = join(OUT, 'registro.jsonl');

// ------------------------------------------------------------------ instrumentação, antes do código do jogo
function instrument() {
  const S = window.__sonda = { on: false, tables: {}, actions: [], notes: [] };
  const table = (name) => (S.tables[name] ??= new Map());
  const STACK = /\(?((?:https?:)?\/\/[^\s()]+):(\d+):(\d+)\)?\s*$/;
  /** A linha do código do jogo que chamou (a primeira de /src/ na pilha), ou a primeira fora dele. */
  const site = () => {
    const lines = new Error().stack.split('\n');
    let first = null;
    for (let i = 3; i < lines.length; i++) {
      const m = lines[i].match(STACK);
      if (!m) continue;
      if (m[1].includes('/src/')) return `${m[1]}:${m[2]}:${m[3]}`;
      first ??= `${m[1]}:${m[2]}:${m[3]}`;
    }
    return first ?? '(sem pilha)';
  };
  /** Conta `key` na tabela `name`, com bytes; `where`: e a linha que chamou. */
  const tally = S.tally = (name, key, bytes = 0, where = true) => {
    if (!S.on) return;
    const t = table(name);
    let e = t.get(key);
    if (!e) { e = { n: 0, bytes: 0, sites: new Map() }; t.set(key, e); }
    e.n++; e.bytes += bytes;
    if (where) { const s = site(); e.sites.set(s, (e.sites.get(s) ?? 0) + 1); }
  };
  const sizeOf = (v, depth = 0) => {
    if (v == null) return 0;
    if (v instanceof ArrayBuffer) return v.byteLength;
    if (ArrayBuffer.isView(v)) return v.byteLength;
    if (typeof v === 'string') return v.length * 2;
    if (typeof v !== 'object' || depth > 3) return 8;
    let n = 0;
    if (Array.isArray(v)) { for (let i = 0; i < Math.min(v.length, 256); i++) n += sizeOf(v[i], depth + 1); return n; }
    for (const k in v) n += sizeOf(v[k], depth + 1);
    return n;
  };

  // WebGL: toda chamada contada; as que criam, apagam, enviam, compilam ou leem do driver, com a linha.
  const WITH_SITE = /^(create|delete|buffer|tex|compressedTex|copyTex|compile|link|shaderSource|generateMipmap|readPixels|getError|finish|flush|fenceSync|clientWaitSync|getParameter|getProgram|getShader|getUniformLocation|getAttribLocation|getActive|getExtension|getSupported|getBufferSubData|getQuery|beginQuery|endQuery)/;
  const bytesOf = (name, args) => {
    if (name === 'bufferData') return typeof args[1] === 'number' ? args[1] : (args[1]?.byteLength ?? 0);
    if (name === 'bufferSubData') return args[2]?.byteLength ?? 0;
    if (/^(tex|compressedTex)(Sub)?Image[23]D$/.test(name)) {
      for (const a of args) if (a && (ArrayBuffer.isView(a) || a instanceof ArrayBuffer)) return a.byteLength;
      for (const a of args) if (a && typeof a === 'object' && 'width' in a) return a.width * a.height * 4;
    }
    return 0;
  };
  for (const Ctx of [window.WebGL2RenderingContext, window.WebGLRenderingContext]) {
    if (!Ctx) continue;
    for (const name of Object.getOwnPropertyNames(Ctx.prototype)) {
      const d = Object.getOwnPropertyDescriptor(Ctx.prototype, name);
      if (!d || typeof d.value !== 'function' || name === 'constructor') continue;
      const fn = d.value, where = WITH_SITE.test(name);
      Ctx.prototype[name] = function (...args) { if (S.on) tally('webgl', name, bytesOf(name, args), where); return fn.apply(this, args); };
    }
  }

  // Workers e portas.
  const workerName = new WeakMap(), portsOf = new WeakMap();
  const OrigWorker = window.Worker;
  let serial = 0;
  S.workersMade = [];
  window.Worker = function (url, options) {
    const w = new OrigWorker(url, options);
    const name = `${options?.name ?? String(url).replace(/^.*\//, '').replace(/\?.*$/, '')}#${++serial}`;
    workerName.set(w, name);
    S.workersMade.push({ name, url: String(url), site: site(), fresh: true });
    // Os serviços do pool de jobs (`jobs/jobScope.ts`): ToJob { port, service }, FromJob { port }: cada resposta pelo serviço da porta.
    const ports = new Map();
    portsOf.set(w, ports);
    w.addEventListener('message', (e) => tally('workers', `recebe de ${name}${e.data?.port !== undefined && ports.has(e.data.port) ? ` [${ports.get(e.data.port)}]` : ''}`, sizeOf(e.data), false));
    return w;
  };
  window.Worker.prototype = OrigWorker.prototype;
  const wpost = OrigWorker.prototype.postMessage;
  OrigWorker.prototype.postMessage = function (data, transfer) {
    const service = data?.service ?? data?.adopt;
    if (data?.service !== undefined && data?.port !== undefined) portsOf.get(this)?.set(data.port, data.service);
    tally('workers', `envia para ${workerName.get(this) ?? 'worker'}${service ? ` [${service}]` : ''}`, sizeOf(data));
    return wpost.call(this, data, transfer);
  };
  const ppost = MessagePort.prototype.postMessage;
  MessagePort.prototype.postMessage = function (data, transfer) { tally('workers', 'envia por porta', sizeOf(data)); return ppost.call(this, data, transfer); };
  for (const Proto of [MessagePort.prototype, OrigWorker.prototype]) {
    const d = Object.getOwnPropertyDescriptor(Proto, 'onmessage') ?? Object.getOwnPropertyDescriptor(Object.getPrototypeOf(Proto), 'onmessage');
    if (!d?.set) continue;
    const label = Proto === MessagePort.prototype ? 'recebe por porta' : 'recebe (onmessage)';
    Object.defineProperty(Proto, 'onmessage', { configurable: true, get: d.get, set(fn) { d.set.call(this, typeof fn === 'function' ? function (e) { tally('workers', label, sizeOf(e.data), false); return fn.call(this, e); } : fn); } });
  }

  // As ações do jogador (fase de captura, antes do jogo): registradas com o alvo; os arrastos somados.
  const describe = (node) => {
    let el = node?.nodeType === 1 ? node : node?.parentElement;
    const path = [];
    while (el && path.length < 3) {
      const label = el.getAttribute?.('aria-label') || el.getAttribute?.('title') || '';
      path.unshift(el.id ? `#${el.id}` : `${el.tagName.toLowerCase()}${el.classList?.[0] ? '.' + el.classList[0] : ''}${label ? `[${label.slice(0, 40)}]` : ''}`);
      if (el.id) break;
      el = el.parentElement;
    }
    return path.join(' > ') || '(documento)';
  };
  const drag = { moves: 0, px: 0, buttons: 0, target: '' };
  const act = (text) => { if (S.on) S.actions.push(text); };
  const capture = { capture: true, passive: true };
  EventTarget.prototype.addEventListener.call(window, 'pointerdown', (e) => act(`aperta botão ${e.button} em ${describe(e.target)} (${e.clientX}, ${e.clientY})`), capture);
  EventTarget.prototype.addEventListener.call(window, 'pointerup', (e) => act(`solta botão ${e.button} em ${describe(e.target)} (${e.clientX}, ${e.clientY})`), capture);
  EventTarget.prototype.addEventListener.call(window, 'click', (e) => act(`clique em ${describe(e.target)}`), capture);
  EventTarget.prototype.addEventListener.call(window, 'dblclick', (e) => act(`duplo clique em ${describe(e.target)}`), capture);
  EventTarget.prototype.addEventListener.call(window, 'wheel', (e) => act(`roda ${e.deltaY > 0 ? 'para trás' : 'para frente'} (${Math.round(e.deltaY)}) em ${describe(e.target)}`), capture);
  EventTarget.prototype.addEventListener.call(window, 'keydown', (e) => act(`tecla ${[e.ctrlKey && 'Ctrl', e.shiftKey && 'Shift', e.altKey && 'Alt', e.key].filter(Boolean).join('+')}${e.repeat ? ' (repetindo)' : ''} em ${describe(e.target)}`), capture);
  EventTarget.prototype.addEventListener.call(window, 'pointermove', (e) => {
    if (!S.on || !e.buttons) return;
    drag.moves++; drag.px += Math.hypot(e.movementX, e.movementY); drag.buttons = e.buttons; drag.target = describe(e.target);
  }, capture);
  S.takeDrag = () => { const d = drag.moves ? `arrasta (botões ${drag.buttons}) ${Math.round(drag.px)} px em ${drag.moves} movimentos sobre ${drag.target}` : null; drag.moves = 0; drag.px = 0; return d; };

  // Timers, eventos, rede, IndexedDB, storage.
  for (const name of ['setTimeout', 'setInterval', 'requestAnimationFrame', 'requestIdleCallback', 'queueMicrotask']) {
    const fn = window[name];
    if (typeof fn === 'function') window[name] = function (...args) { tally('timers', name); return fn.apply(this, args); };
  }
  const add = EventTarget.prototype.addEventListener, remove = EventTarget.prototype.removeEventListener;
  EventTarget.prototype.addEventListener = function (type, fn, o) { tally('eventos', `add ${type}`); return add.call(this, type, fn, o); };
  EventTarget.prototype.removeEventListener = function (type, fn, o) { tally('eventos', `remove ${type}`); return remove.call(this, type, fn, o); };
  const fetch0 = window.fetch;
  window.fetch = function (input, init) { tally('rede', `fetch ${String(input?.url ?? input).replace(/\?.*$/, '')}`); return fetch0.call(this, input, init); };
  const xopen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (method, url, ...rest) { tally('rede', `xhr ${method} ${String(url).replace(/\?.*$/, '')}`); return xopen.call(this, method, url, ...rest); };
  for (const name of ['put', 'add', 'delete', 'clear', 'get', 'getAll', 'getAllKeys', 'count', 'openCursor']) {
    const fn = IDBObjectStore.prototype[name];
    if (typeof fn === 'function') IDBObjectStore.prototype[name] = function (...args) { tally('idb', `${name} ${this.name}`, name === 'put' || name === 'add' ? sizeOf(args[0]) : 0); return fn.apply(this, args); };
  }
  for (const name of ['setItem', 'removeItem', 'getItem']) {
    const fn = Storage.prototype[name];
    Storage.prototype[name] = function (key, value) { tally('storage', `${name} ${key}`, value ? String(value).length * 2 : 0); return fn.call(this, key, value); };
  }
  // DOM.
  S.observer = new MutationObserver((list) => {
    if (!S.on) return;
    const t = table('dom');
    for (const m of list) {
      const key = `${describe(m.target)}  [${m.type}${m.attributeName ? ' ' + m.attributeName : ''}]`;
      const e = t.get(key) ?? { n: 0, bytes: 0, sites: new Map() };
      e.n++; t.set(key, e);
    }
  });
  add.call(window, 'DOMContentLoaded', () => S.observer.observe(document.documentElement, { subtree: true, childList: true, attributes: true, characterData: true }));
}

// ------------------------------------------------------------------ dentro da página: o rastreador da cena e o fecho de cada segundo
function installTracker() {
  const S = window.__sonda, r = window.__roadcraft, handle = r.scene(), scene = handle.scene, gl = handle.gl;
  const keyOf = (o) => {
    const parts = [];
    for (let x = o; x && !x.isScene; x = x.parent) parts.unshift((x.name || '').replace(/[-_:@#\s]*\d[\w.,:-]*$/, '') || (x === o ? x.type : ''));
    const outside = o.parent || o.isScene ? '' : '(fora da cena) ';
    const named = parts.filter(Boolean);
    const short = named.length > 3 ? [named[0], '…', ...named.slice(-2)] : named;
    return outside + (short.join(' / ') || o.type);
  };
  const bump = (map, key, field, n = 1) => { const e = map.get(key) ?? {}; e[field] = (e[field] ?? 0) + n; map.set(key, e); };
  // Um buffer já entregue à GPU pode ter o array solto (`mesh/gpuOnly.ts`) e uma textura os texels (`surfaceTextures.ts`): os bytes vêm da contagem.
  const arrayOf = (a) => (a.isInterleavedBufferAttribute ? a.data.array : a.array);
  const attrVersion = (a) => (a.isInterleavedBufferAttribute ? a.data.version : a.version);
  const attrBytes = (a) => {
    const arr = arrayOf(a), unit = arr?.BYTES_PER_ELEMENT ?? 4;
    const ranges = a.isInterleavedBufferAttribute ? a.data.updateRanges : a.updateRanges;
    if (ranges?.length) return ranges.reduce((s, x) => s + x.count * unit, 0);
    return arr?.byteLength ?? a.count * (a.isInterleavedBufferAttribute ? a.data.stride : a.itemSize) * unit;
  };
  const texturesOf = (m) => {
    const out = [];
    for (const k in m) { const v = m[k]; if (v?.isTexture) out.push(v); }
    if (m.uniforms) for (const k in m.uniforms) { const v = m.uniforms[k]?.value; if (v?.isTexture) out.push(v); }
    return out;
  };
  const texBytes = (t) => {
    if (t.mipmaps?.length) return t.mipmaps.reduce((s, l) => s + (l?.data?.byteLength ?? (l?.width ?? 0) * (l?.height ?? 0) * 4 * (t.image?.depth ?? 1)), 0);
    const img = t.image;
    if (img?.data?.byteLength) return img.data.byteLength;
    if (img?.width) return img.width * img.height * (img.depth ?? 1) * 4;
    return 0;
  };

  // Desenhos por elemento e passe.
  let draws = new Map();
  const rbd = gl.renderBufferDirect.bind(gl);
  gl.renderBufferDirect = function (camera, sceneArg, geometry, material, object, group) {
    if (S.on) {
      const pass = sceneArg === null ? 'sombra' : camera?.isOrthographicCamera ? 'ortográfica' : 'cena';
      const index = geometry.index, pos = geometry.attributes.position;
      let count = index ? index.count : (pos ? pos.count : 0);
      const dr = geometry.drawRange;
      count = Math.max(0, Math.min(count, dr.count) - (dr.start || 0));
      if (group) count = Math.min(count, group.count);
      const inst = object.isInstancedMesh ? object.count : (geometry.isInstancedBufferGeometry ? geometry.instanceCount : 1);
      const k = `${keyOf(object)}  [${pass}]`;
      bump(draws, k, 'chamadas'); bump(draws, k, 'triângulos', object.isMesh ? (count / 3) * inst : 0); bump(draws, k, 'vértices', count * inst); bump(draws, k, 'instâncias', inst);
    }
    return rbd(camera, sceneArg, geometry, material, object, group);
  };

  /** Cada elemento da cena agora. */
  const inventory = () => {
    const inv = new Map(), geoms = new Set(), texs = new Set();
    scene.traverse((o) => {
      const k = keyOf(o);
      bump(inv, k, 'objetos');
      if (!o.geometry) return;
      const g = o.geometry, pos = g.attributes.position, idx = g.index, inst = o.isInstancedMesh ? o.count : 1;
      let shown = true;
      for (let x = o; x; x = x.parent) if (!x.visible) { shown = false; break; }
      bump(inv, k, o.isInstancedMesh ? 'malhas instanciadas' : o.isMesh ? 'malhas' : o.isLine ? 'linhas' : o.isPoints ? 'pontos' : 'outros desenháveis');
      if (shown) bump(inv, k, 'visíveis');
      bump(inv, k, 'instâncias', inst);
      if (o.isMesh) bump(inv, k, 'triângulos', ((idx ? idx.count : pos?.count ?? 0) / 3) * inst);
      bump(inv, k, 'vértices', (pos?.count ?? 0) * inst);
      if (o.castShadow) bump(inv, k, 'projetam sombra');
      if (!geoms.has(g)) {
        geoms.add(g);
        bump(inv, k, 'geometrias');
        let b = idx ? attrBytes(idx) : 0;
        const seen = new Set();
        for (const name in g.attributes) { const a = g.attributes[name], key = a.isInterleavedBufferAttribute ? a.data : a; if (!seen.has(key)) { seen.add(key); b += attrBytes(a); } }
        if (o.isInstancedMesh) { b += attrBytes(o.instanceMatrix); if (o.instanceColor) b += attrBytes(o.instanceColor); }
        bump(inv, k, 'bytes de geometria', b);
      }
      for (const m of [].concat(o.material ?? [])) {
        for (const t of texturesOf(m)) if (!texs.has(t)) { texs.add(t); bump(inv, k, 'texturas'); bump(inv, k, 'bytes de textura', texBytes(t)); }
        const e = inv.get(k); (e.materiais ??= new Set()).add(`${m.type}${m.name ? ' ' + m.name : ''}`);
      }
    });
    return inv;
  };

  // O que muda e o que nasce, a cada quadro.
  let updates = new Map(), created = new Map(), frames = 0;
  let seen = null;
  const state = new Map(), versions = new WeakMap();
  const snapshot = (first) => {
    const now = { objetos: new Map(), geometrias: new Map(), materiais: new Map(), texturas: new Map() };
    scene.traverse((o) => {
      const k = keyOf(o);
      now.objetos.set(o.uuid, k);
      const s = state.get(o.uuid), e = o.matrixWorld.elements, g = o.geometry;
      if (!s) state.set(o.uuid, { m: Float64Array.from(e), v: o.visible, c: o.count, ds: g?.drawRange.start, dc: g?.drawRange.count });
      else if (!first) {
        let moved = false;
        for (let i = 0; i < 16; i++) if (s.m[i] !== e[i]) { moved = true; s.m[i] = e[i]; }
        if (moved) bump(updates, k, 'matriz mudou');
        if (s.v !== o.visible) { bump(updates, k, 'visibilidade trocou'); s.v = o.visible; }
        if (o.isInstancedMesh && s.c !== o.count) { bump(updates, k, 'nº de instâncias mudou'); s.c = o.count; }
        if (g && (s.ds !== g.drawRange.start || s.dc !== g.drawRange.count)) { bump(updates, k, 'faixa de desenho mudou'); s.ds = g.drawRange.start; s.dc = g.drawRange.count; }
      }
      if (g) {
        now.geometrias.set(g.uuid, k);
        const list = Object.entries(g.attributes);
        if (g.index) list.push(['índice', g.index]);
        if (o.isInstancedMesh) { list.push(['instanceMatrix', o.instanceMatrix]); if (o.instanceColor) list.push(['instanceColor', o.instanceColor]); }
        for (const [name, a] of list) {
          const v = attrVersion(a), was = versions.get(a);
          if (!first && was !== undefined && was !== v) { bump(updates, k, `reenvio de ${name}`); bump(updates, k, 'bytes reenviados', attrBytes(a)); }
          versions.set(a, v);
        }
      }
      for (const m of [].concat(o.material ?? [])) {
        now.materiais.set(m.uuid, k);
        const was = versions.get(m);
        if (!first && was !== undefined && was !== m.version) bump(updates, k, 'material alterado (needsUpdate)');
        versions.set(m, m.version);
        for (const t of texturesOf(m)) {
          now.texturas.set(t.uuid, k);
          const tw = versions.get(t);
          if (!first && tw !== undefined && tw !== t.version) { bump(updates, k, 'textura reenviada'); bump(updates, k, 'bytes reenviados', texBytes(t)); }
          versions.set(t, t.version);
        }
      }
    });
    if (seen && !first) {
      for (const kind of Object.keys(now)) {
        for (const [uuid, k] of now[kind]) if (!seen[kind].has(uuid)) bump(created, k, `${kind} criados`);
        for (const [uuid, k] of seen[kind]) if (!now[kind].has(uuid)) { bump(created, k, `${kind} removidos`); if (kind === 'objetos') state.delete(uuid); }
      }
    }
    seen = now;
  };
  const tick = () => { if (S.on) { frames++; snapshot(false); } requestAnimationFrame(tick); };

  const memory = () => ({ 'heap MB': Math.round(performance.memory.usedJSHeapSize / 1e6), geometrias: gl.info.memory.geometries, texturas: gl.info.memory.textures, programas: gl.info.programs?.length ?? 0 });
  let lastInventory = new Map(), lastSerial = Infinity, lastCamera = null, lastMemory = memory(), t0 = performance.now(), workersSeen = 0;
  const camera = () => ({ x: Math.round(r.camera.x), y: Math.round(r.camera.y), zoom: Math.round(r.camera.zoom * 1000) / 1000 });
  const stateChanges = () => {
    const changes = (window.__state?.(200)?.changes ?? []).map((c) => ({ serial: Number(c.match(/^#(\d+)/)?.[1] ?? 0), text: c }));
    const fresh = lastSerial === Infinity ? [] : changes.filter((c) => c.serial > lastSerial).map((c) => c.text);
    if (changes.length) lastSerial = Math.max(...changes.map((c) => c.serial), lastSerial === Infinity ? 0 : lastSerial);
    return fresh;
  };
  S.note = (text) => S.notes.push(text);
  S.start = () => {
    snapshot(true);
    lastInventory = inventory();
    stateChanges();
    lastCamera = camera();
    t0 = performance.now();
    S.on = true;
    requestAnimationFrame(tick);
  };
  /** O segundo que passou: tudo o que foi contado nele, e os contadores zerados. */
  S.flush = () => {
    const seconds = (performance.now() - t0) / 1000;
    t0 = performance.now();
    const inv = inventory();
    const sceneChanges = [];
    for (const [k, e] of inv) {
      const was = lastInventory.get(k);
      if (!was) { sceneChanges.push({ elemento: k, mudou: 'apareceu', ...Object.fromEntries(Object.entries(e).filter(([f]) => f !== 'materiais')) }); continue; }
      const diff = {};
      for (const f of new Set([...Object.keys(e), ...Object.keys(was)])) if (f !== 'materiais' && (e[f] ?? 0) !== (was[f] ?? 0)) diff[f] = `${was[f] ?? 0} → ${e[f] ?? 0}`;
      if (Object.keys(diff).length) sceneChanges.push({ elemento: k, mudou: 'mudou', ...diff });
    }
    for (const [k] of lastInventory) if (!inv.has(k)) sceneChanges.push({ elemento: k, mudou: 'sumiu' });
    lastInventory = inv;
    const cam = camera(), camWas = lastCamera;
    lastCamera = cam;
    const mem = memory(), memWas = lastMemory;
    lastMemory = mem;
    const out = (m) => [...m].map(([k, e]) => ({ elemento: k, ...e }));
    const tables = {};
    for (const [name, t] of Object.entries(S.tables)) tables[name] = [...t].map(([key, e]) => ({ chave: key, n: e.n, bytes: e.bytes, linhas: [...e.sites].sort((a, b) => b[1] - a[1]) }));
    const drag = S.takeDrag();
    const result = {
      seconds, frames, camera: cam, cameraWas: camWas, memory: mem, memoryWas: memWas,
      sim: { pausada: r.sim.clock.paused, velocidade: r.sim.clock.speed, veículos: r.sim.vehicles.size, pessoas: r.sim.pedViews.length },
      actions: [...S.actions, ...(drag ? [drag] : [])], state: stateChanges(), notes: S.notes.splice(0),
      sceneChanges, draws: out(draws), updates: out(updates), created: out(created), tables,
      workersMade: S.workersMade.slice(workersSeen),
      inventory: [...inv].map(([k, e]) => ({ elemento: k, ...e, materiais: [...(e.materiais ?? [])] })),
    };
    workersSeen = S.workersMade.length;
    S.actions = []; S.tables = {}; draws = new Map(); updates = new Map(); created = new Map(); frames = 0;
    return result;
  };
}

// ------------------------------------------------------------------ linhas servidas -> linhas do código-fonte
const served = new Map();
async function servedSource(url) {
  const clean = url.replace(/\?.*$/, '');
  if (served.has(clean)) return served.get(clean);
  let entry = null;
  try {
    const text = await (await fetch(url.startsWith('http') ? url : BASE + url.replace(/^\//, ''))).text();
    const m = text.match(/\/\/# sourceMappingURL=data:application\/json;(?:charset=utf-8;)?base64,([A-Za-z0-9+/=]+)\s*$/);
    const lineStarts = [0];
    for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) lineStarts.push(i + 1);
    entry = { lineStarts, map: m ? new SourceMapConsumer(JSON.parse(Buffer.from(m[1], 'base64').toString('utf8'))) : null };
  } catch { entry = null; }
  served.set(clean, entry);
  return entry;
}
const shortPath = (p) => p.replace(/^.*?\/src\//, 'src/').replace(/^.*?\/node_modules\/\.vite\/deps\//, 'deps/').replace(/^.*?\/node_modules\//, 'node_modules/').replace(/\?.*$/, '');
async function original(url, line, column) {
  const src = await servedSource(url);
  if (src?.map) {
    const p = src.map.originalPositionFor({ line, column: Math.max(0, column - 1) });
    if (p.source) return `${shortPath(p.source)}:${p.line}`;
  }
  return `${shortPath(url)}:${line}`;
}
async function originalAtOffset(url, offset) {
  const src = await servedSource(url);
  if (!src) return `${shortPath(url)}@${offset}`;
  let lo = 0, hi = src.lineStarts.length - 1;
  while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (src.lineStarts[mid] <= offset) lo = mid; else hi = mid - 1; }
  return original(url, lo + 1, offset - src.lineStarts[lo] + 1);
}
const siteToSource = async (s) => { const m = s.match(/^(.*):(\d+):(\d+)$/); return m ? original(m[1], Number(m[2]), Number(m[3])) : s; };

// Onde o nome de cada elemento aparece como texto no código.
const sourceFiles = [];
(function walk(dir) { for (const f of readdirSync(dir)) { const p = join(dir, f); if (statSync(p).isDirectory()) walk(p); else if (/\.(ts|tsx|js|mjs)$/.test(f)) sourceFiles.push([relative('.', p).replace(/\\/g, '/'), readFileSync(p, 'utf8').split('\n')]); } })('src');
const nameSites = new Map();
function whereNamed(element) {
  const names = element.replace(/^\(fora da cena\) /, '').replace(/\s+\[[^\]]*\]$/, '').split(' / ').filter((n) => n && n !== '…' && !/^[A-Z][A-Za-z]+$/.test(n));
  const name = names[names.length - 1];
  if (!name) return '(sem nome: só o tipo)';
  if (!nameSites.has(name)) {
    const found = [], quoted = [`'${name}`, `"${name}`, `\`${name}`];
    for (const [file, lines] of sourceFiles) lines.forEach((l, i) => { if (quoted.some((q) => l.includes(q))) found.push(`${file}:${i + 1}`); });
    nameSites.set(name, found.join(', ') || '(nome não achado como texto no src)');
  }
  return nameSites.get(name);
}

// ------------------------------------------------------------------ um segundo no arquivo
const num = (x) => (typeof x === 'number' ? x.toLocaleString('pt-BR', { maximumFractionDigits: 2 }) : String(x));
const fields = (e, skip = ['elemento']) => Object.entries(e).filter(([k]) => !skip.includes(k)).map(([k, v]) => `${k} ${num(v)}`).join(' · ');
let started = Date.now(), secondNo = 0;
async function writeSecond(r, coverage, heap) {
  secondNo++;
  const L = [];
  const clock = new Date().toLocaleTimeString('pt-BR');
  const cam = r.cameraWas && (r.camera.x !== r.cameraWas.x || r.camera.y !== r.cameraWas.y || r.camera.zoom !== r.cameraWas.zoom)
    ? `câmera ${r.cameraWas.x},${r.cameraWas.y} zoom ${r.cameraWas.zoom} → ${r.camera.x},${r.camera.y} zoom ${r.camera.zoom}`
    : `câmera parada em ${r.camera.x},${r.camera.y} zoom ${r.camera.zoom}`;
  const memDiff = Object.entries(r.memory).map(([k, v]) => `${k} ${num(v)}${r.memoryWas && r.memoryWas[k] !== v ? ` (${v - r.memoryWas[k] > 0 ? '+' : ''}${num(v - r.memoryWas[k])})` : ''}`).join(' · ');
  L.push(`\n${'='.repeat(120)}\n[${clock} · segundo ${secondNo} · +${((Date.now() - started) / 1000).toFixed(0)} s] ${r.frames} quadros em ${num(r.seconds)} s · ${cam}`);
  L.push(`simulação: ${r.sim.pausada ? 'PAUSADA' : `rodando ${r.sim.velocidade}×`} · ${r.sim.veículos} veículos · ${r.sim.pessoas} pessoas · memória: ${memDiff}`);
  L.push(`AÇÕES: ${[...r.notes.map((n) => `ROTEIRO: ${n}`), ...r.actions].join(' | ') || 'nenhuma'}`);
  if (r.state.length) L.push(`ESTADO DO JOGO: ${r.state.join(' | ')}`);
  L.push(`-- CENA MUDOU (${r.sceneChanges.length}) --`);
  for (const c of r.sceneChanges) L.push(`  ${c.mudou.toUpperCase()} ${c.elemento}: ${fields(c, ['elemento', 'mudou'])}  ← ${whereNamed(c.elemento)}`);
  const drawTotal = r.draws.reduce((s, d) => ({ c: s.c + d.chamadas, t: s.t + d['triângulos'] }), { c: 0, t: 0 });
  L.push(`-- DESENHO (${r.draws.length} elementos·passes; total ${num(drawTotal.c / Math.max(1, r.frames))} chamadas e ${num(drawTotal.t / Math.max(1, r.frames))} triângulos por quadro) --`);
  for (const d of r.draws.sort((a, b) => b['triângulos'] - a['triângulos'])) L.push(`  ${d.elemento}: por quadro ${Object.entries(d).filter(([k]) => k !== 'elemento').map(([k, v]) => `${k} ${num(v / Math.max(1, r.frames))}`).join(' · ')}`);
  L.push(`-- ATUALIZA (${r.updates.length}) --`);
  for (const u of r.updates.sort((a, b) => (b['matriz mudou'] ?? 0) + (b['bytes reenviados'] ?? 0) - (a['matriz mudou'] ?? 0) - (a['bytes reenviados'] ?? 0))) L.push(`  ${u.elemento}: ${fields(u)}  ← ${whereNamed(u.elemento)}`);
  L.push(`-- CRIA / REMOVE (${r.created.length}) --`);
  for (const c of r.created) L.push(`  ${c.elemento}: ${fields(c)}  ← ${whereNamed(c.elemento)}`);
  for (const w of r.workersMade) L.push(`  WORKER CRIADO ${w.name} ← ${await siteToSource(w.site)}`);
  for (const [name, title] of [['webgl', 'WEBGL'], ['workers', 'WORKERS'], ['timers', 'TIMERS'], ['eventos', 'EVENTOS'], ['rede', 'REDE'], ['idb', 'INDEXEDDB'], ['storage', 'STORAGE'], ['dom', 'DOM']]) {
    const t = (r.tables[name] ?? []).sort((a, b) => b.n - a.n);
    L.push(`-- ${title} (${t.length}) --`);
    for (const e of t) {
      L.push(`  ${e.chave}: ${num(e.n)}×${e.bytes ? ` · ${num(e.bytes)} bytes` : ''}`);
      for (const [s, n] of e.linhas) L.push(`      ${num(n)}× ← ${await siteToSource(s)}`);
    }
  }
  const calls = [];
  for (const script of coverage) {
    if (!script.url.includes('/src/')) continue;
    for (const fn of script.functions) { const count = fn.ranges[0]?.count ?? 0; if (count > 0) calls.push({ fn: fn.functionName || '(anônima)', url: script.url, offset: fn.ranges[0].startOffset, count }); }
  }
  calls.sort((a, b) => b.count - a.count);
  L.push(`-- CHAMADAS de funções do jogo (${calls.length}) --`);
  const callRows = [];
  for (const c of calls) { const at = await originalAtOffset(c.url, c.offset); callRows.push({ fn: c.fn, at, n: c.count }); L.push(`  ${num(c.count)}× ${c.fn} ← ${at}`); }
  const alloc = new Map();
  (function walk(node, owner) {
    const f = node.callFrame;
    const here = f.url.includes('/src/') ? `${f.url}:${f.lineNumber + 1}:${f.columnNumber + 1}|${f.functionName || '(anônima)'}` : owner;
    const key = here ?? `|${f.functionName || '(nativo)'} ${shortPath(f.url)}`;
    if (node.selfSize) alloc.set(key, (alloc.get(key) ?? 0) + node.selfSize);
    for (const c of node.children) walk(c, here);
  })(heap.head, null);
  const allocRows = [];
  L.push(`-- ALOCA: memória JS por linha do jogo (${alloc.size}) --`);
  for (const [k, bytes] of [...alloc].sort((a, b) => b[1] - a[1])) {
    const [where, fn] = k.split('|');
    const m = where.match(/^(.*):(\d+):(\d+)$/);
    const at = m ? await original(m[1], Number(m[2]), Number(m[3])) : '(fora do src)';
    allocRows.push({ fn, at, bytes });
    L.push(`  ${num(bytes)} bytes ${fn} ← ${at}`);
  }
  appendFileSync(TXT, L.join('\n') + '\n');
  const { inventory, ...rest } = r;
  appendFileSync(JSONL, JSON.stringify({ segundo: secondNo, ...rest, inventory: secondNo === 1 || r.sceneChanges.length ? inventory : undefined, calls: callRows, alloc: allocRows }) + '\n');
}

// ------------------------------------------------------------------ abrir, e gravar até acabar
mkdirSync(OUT, { recursive: true });
writeFileSync(TXT, `SONDA — ${new Date().toLocaleString('pt-BR')} — ${ROTEIRO ? 'roteiro automático' : 'jogo aberto para jogar (grava até a janela fechar)'}\n`);
writeFileSync(JSONL, '');
const { browser, page, fit } = await openCity({ zoom: 1, init: instrument, free: false, headless: ROTEIRO, settle: ROTEIRO && !ABERTURA, city: !ABERTURA });
await page.evaluate(installTracker);
const cdp = await page.context().newCDPSession(page);
await cdp.send('Profiler.enable');
await cdp.send('HeapProfiler.enable');
await cdp.send('Profiler.startPreciseCoverage', { callCount: true, detailed: false });
await cdp.send('HeapProfiler.startSampling', { samplingInterval: 16384, includeObjectsCollectedByMajorGC: true, includeObjectsCollectedByMinorGC: true });
await page.evaluate(() => window.__sonda.start());
await cdp.send('Profiler.takePreciseCoverage');
started = Date.now();

let open = true;
page.on('close', () => { open = false; });
browser.on('disconnected', () => { open = false; });
/** Um segundo gravado: o que a página contou, as chamadas e as alocações do V8 desde o último. */
async function recordSecond() {
  const r = await page.evaluate(() => window.__sonda.flush());
  const coverage = (await cdp.send('Profiler.takePreciseCoverage')).result;
  const heap = (await cdp.send('HeapProfiler.getSamplingProfile')).profile;
  await cdp.send('HeapProfiler.stopSampling');
  await cdp.send('HeapProfiler.startSampling', { samplingInterval: 16384, includeObjectsCollectedByMajorGC: true, includeObjectsCollectedByMinorGC: true });
  await writeSecond(r, coverage, heap);
}
const recorder = (async () => {
  while (open) {
    const t = Date.now();
    try { await recordSecond(); } catch (e) { if (open) appendFileSync(TXT, `\n(segundo não gravado: ${e.message.split('\n')[0]})\n`); }
    await new Promise((res) => setTimeout(res, Math.max(0, 1000 - (Date.now() - t))));
  }
})();

if (ABERTURA) {
  // A ABERTURA: a cidade aberta como o menu a abre, gravada desde antes; cada segundo diz o que apareceu e o que o jogo fazia.
  await page.evaluate((seed) => { window.__sonda.note(`abre a cidade pequena (semente ${seed}), como "Nova cidade" do menu`); window.__roadcraft.smallCity(seed); }, Number(arg('--seed', '7')));
  await page.waitForTimeout(Number(arg('--seconds', '30')) * 1000);
  open = false;
  await recorder;
  await browser.close();
} else if (ROTEIRO) {
  const note = (text) => page.evaluate((t) => window.__sonda.note(t), text);
  for (const view of VIEWS) {
    await note(`câmera para a vista ${view.name} (zoom ${view.zoom}× a cidade inteira)`);
    await lookAt(page, fit, view.zoom);
    await note(`${view.name}: PARADO (relógio parado, câmera parada) por ${SECONDS} s`);
    await page.evaluate(() => window.__roadcraft.measure(true));
    await page.waitForTimeout(SECONDS * 1000);
    await note(`${view.name}: JOGANDO (simulação rodando, câmera parada) por ${SECONDS} s`);
    await page.evaluate(() => window.__roadcraft.measure(false));
    await page.waitForTimeout(SECONDS * 1000);
    await note(`${view.name}: CÂMERA ANDANDO (relógio parado) por ${SECONDS} s`);
    await page.evaluate(() => window.__roadcraft.measure(true));
    await page.evaluate(async ({ fit, zoom, seconds }) => {
      const r = window.__roadcraft, z = fit.zoom * zoom, span = 600 / zoom, t0 = performance.now();
      while (performance.now() - t0 < seconds * 1000) {
        r.lookAt(fit.x - span / 2 + span * ((performance.now() - t0) / (seconds * 1000)), fit.y, z);
        await new Promise((res) => setTimeout(res, 16));
      }
    }, { fit, zoom: view.zoom, seconds: SECONDS });
  }
  await page.evaluate(() => window.__roadcraft.measure(false));
  await page.waitForTimeout(1200);
  open = false;
  await recorder;
  await browser.close();
} else {
  console.log(`Gravando em ${TXT} — jogue na janela do Chrome; feche a janela para parar.`);
  await recorder;
  await browser.close().catch(() => {});
}
console.log(`Registro: ${TXT} (${secondNo} segundos) e ${JSONL}`);
