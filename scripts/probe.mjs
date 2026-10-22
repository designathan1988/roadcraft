// THE PROBE: a recorder. While the game runs, it writes every second, live, to a file: what was done in that second (clicks,
// drags, wheel, keys, tool and game state switched, where the camera went) and everything the game did - per element and per line
// of code, counted (never timed: a count is the same on any machine). Nothing is judged - no threshold, no cut.
//
// Each second carries:
//  ACTIONS        - input events (with their target), drags (how many px), game state changes (`__state`), the camera (from where to where);
//  SCENE CHANGED  - elements that appeared or vanished, and each number of an element that changed (from -> to): objects, meshes, instances,
//                   triangles, vertices, geometries, geometry bytes, textures, texture bytes, how many cast shadows;
//  DRAW           - each element and pass (scene, shadow, orthographic): calls, triangles, vertices, instances;
//  UPDATES        - each element: matrix changed, visibility toggled, instance count and draw range changed, attributes/index/textures
//                   re-sent (bytes), materials changed;
//  CREATE         - each element: objects, geometries, materials and textures born and gone;
//  WEBGL          - each WebGL call: how many, bytes; those that create, delete, upload, compile or read from the driver, with the code line;
//  CALLS          - each game function and how many times it was called (V8's exact count);
//  ALLOC          - each game line and the bytes of JS memory it allocated (V8 sampling);
//  WORKERS        - workers created; messages to and from each worker/port, bytes, with the line;
//  TIMERS, EVENTS, NETWORK, INDEXEDDB, STORAGE - per call and line; DOM - mutations per part of the interface;
//  MEMORY         - JS heap, the renderer's geometries, textures and programs, and how much they changed.
// It does not carry the work inside the workers (only the messages with the page).
//
// Usage (with `npm run dev` running):
//   node scripts/probe.mjs              opens the game in a Playwright Chrome, windowed, to play; records until the window closes
//   node scripts/probe.mjs --plan       headless: the city still, playing and the camera moving in three views, recorded the same way
//   node scripts/probe.mjs --opening    headless: the city opened as the menu opens it, recorded from before (`--seconds`, default 30)
//   [--seed 7] [--seconds 5 (per plan scenario)] [--views city:1,district:4,street:14]
// Files (written every second): test-results/probe/log.txt (readable) and test-results/probe/log.jsonl (one second per line).
import { appendFileSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { SourceMapConsumer } from 'source-map-js';
import { arg, lookAt, openCity } from './lib/measureCity.mjs';

const OPENING = process.argv.includes('--opening');
const PLAN = process.argv.includes('--plan') || OPENING;
const SECONDS = Number(arg('--seconds', '5'));
const VIEWS = arg('--views', 'city:1,district:4,street:14').split(',').map((v) => { const [name, zoom] = v.split(':'); return { name, zoom: Number(zoom) }; });
const BASE = arg('--base', 'http://127.0.0.1:5300/');
const OUT = 'test-results/probe';
const TXT = join(OUT, 'log.txt'), JSONL = join(OUT, 'log.jsonl');

// ------------------------------------------------------------------ instrumentation, before the game's code
function instrument() {
  const S = window.__recorder = { on: false, tables: {}, actions: [], notes: [] };
  const table = (name) => (S.tables[name] ??= new Map());
  const STACK = /\(?((?:https?:)?\/\/[^\s()]+):(\d+):(\d+)\)?\s*$/;
  /** The line of the game's code that called (the first of /src/ in the stack), or the first one outside it. */
  const site = () => {
    const lines = new Error().stack.split('\n');
    let first = null;
    for (let i = 3; i < lines.length; i++) {
      const m = lines[i].match(STACK);
      if (!m) continue;
      if (m[1].includes('/src/')) return `${m[1]}:${m[2]}:${m[3]}`;
      first ??= `${m[1]}:${m[2]}:${m[3]}`;
    }
    return first ?? '(no stack)';
  };
  /** Counts `key` in table `name`, with bytes; `where`: and the line that called. */
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

  // WebGL: every call counted; those that create, delete, upload, compile or read from the driver, with the line.
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

  // Workers and ports.
  const workerName = new WeakMap(), portsOf = new WeakMap();
  const OrigWorker = window.Worker;
  let serial = 0;
  S.workersMade = [];
  window.Worker = function (url, options) {
    const w = new OrigWorker(url, options);
    const name = `${options?.name ?? String(url).replace(/^.*\//, '').replace(/\?.*$/, '')}#${++serial}`;
    workerName.set(w, name);
    S.workersMade.push({ name, url: String(url), site: site(), fresh: true });
    // The job pool's services (`jobs/jobScope.ts`): ToJob { port, service }, FromJob { port }: each answer under its port's service.
    const ports = new Map();
    portsOf.set(w, ports);
    w.addEventListener('message', (e) => tally('workers', `received from ${name}${e.data?.port !== undefined && ports.has(e.data.port) ? ` [${ports.get(e.data.port)}]` : ''}`, sizeOf(e.data), false));
    return w;
  };
  window.Worker.prototype = OrigWorker.prototype;
  const wpost = OrigWorker.prototype.postMessage;
  OrigWorker.prototype.postMessage = function (data, transfer) {
    const service = data?.service ?? data?.adopt;
    if (data?.service !== undefined && data?.port !== undefined) portsOf.get(this)?.set(data.port, data.service);
    tally('workers', `sent to ${workerName.get(this) ?? 'worker'}${service ? ` [${service}]` : ''}`, sizeOf(data));
    return wpost.call(this, data, transfer);
  };
  const ppost = MessagePort.prototype.postMessage;
  MessagePort.prototype.postMessage = function (data, transfer) { tally('workers', 'sent through a port', sizeOf(data)); return ppost.call(this, data, transfer); };
  for (const Proto of [MessagePort.prototype, OrigWorker.prototype]) {
    const d = Object.getOwnPropertyDescriptor(Proto, 'onmessage') ?? Object.getOwnPropertyDescriptor(Object.getPrototypeOf(Proto), 'onmessage');
    if (!d?.set) continue;
    const label = Proto === MessagePort.prototype ? 'received through a port' : 'received (onmessage)';
    Object.defineProperty(Proto, 'onmessage', { configurable: true, get: d.get, set(fn) { d.set.call(this, typeof fn === 'function' ? function (e) { tally('workers', label, sizeOf(e.data), false); return fn.call(this, e); } : fn); } });
  }

  // The player's actions (capture phase, before the game): recorded with their target; drags summed.
  const describe = (node) => {
    let el = node?.nodeType === 1 ? node : node?.parentElement;
    const path = [];
    while (el && path.length < 3) {
      const label = el.getAttribute?.('aria-label') || el.getAttribute?.('title') || '';
      path.unshift(el.id ? `#${el.id}` : `${el.tagName.toLowerCase()}${el.classList?.[0] ? '.' + el.classList[0] : ''}${label ? `[${label.slice(0, 40)}]` : ''}`);
      if (el.id) break;
      el = el.parentElement;
    }
    return path.join(' > ') || '(document)';
  };
  const drag = { moves: 0, px: 0, buttons: 0, target: '' };
  const act = (text) => { if (S.on) S.actions.push(text); };
  const capture = { capture: true, passive: true };
  EventTarget.prototype.addEventListener.call(window, 'pointerdown', (e) => act(`presses button ${e.button} on ${describe(e.target)} (${e.clientX}, ${e.clientY})`), capture);
  EventTarget.prototype.addEventListener.call(window, 'pointerup', (e) => act(`releases button ${e.button} on ${describe(e.target)} (${e.clientX}, ${e.clientY})`), capture);
  EventTarget.prototype.addEventListener.call(window, 'click', (e) => act(`click on ${describe(e.target)}`), capture);
  EventTarget.prototype.addEventListener.call(window, 'dblclick', (e) => act(`double click on ${describe(e.target)}`), capture);
  EventTarget.prototype.addEventListener.call(window, 'wheel', (e) => act(`wheel ${e.deltaY > 0 ? 'back' : 'forward'} (${Math.round(e.deltaY)}) on ${describe(e.target)}`), capture);
  EventTarget.prototype.addEventListener.call(window, 'keydown', (e) => act(`key ${[e.ctrlKey && 'Ctrl', e.shiftKey && 'Shift', e.altKey && 'Alt', e.key].filter(Boolean).join('+')}${e.repeat ? ' (repeating)' : ''} on ${describe(e.target)}`), capture);
  EventTarget.prototype.addEventListener.call(window, 'pointermove', (e) => {
    if (!S.on || !e.buttons) return;
    drag.moves++; drag.px += Math.hypot(e.movementX, e.movementY); drag.buttons = e.buttons; drag.target = describe(e.target);
  }, capture);
  S.takeDrag = () => { const d = drag.moves ? `drags (buttons ${drag.buttons}) ${Math.round(drag.px)} px in ${drag.moves} moves over ${drag.target}` : null; drag.moves = 0; drag.px = 0; return d; };

  // Timers, events, network, IndexedDB, storage.
  for (const name of ['setTimeout', 'setInterval', 'requestAnimationFrame', 'requestIdleCallback', 'queueMicrotask']) {
    const fn = window[name];
    if (typeof fn === 'function') window[name] = function (...args) { tally('timers', name); return fn.apply(this, args); };
  }
  const add = EventTarget.prototype.addEventListener, remove = EventTarget.prototype.removeEventListener;
  EventTarget.prototype.addEventListener = function (type, fn, o) { tally('events', `add ${type}`); return add.call(this, type, fn, o); };
  EventTarget.prototype.removeEventListener = function (type, fn, o) { tally('events', `remove ${type}`); return remove.call(this, type, fn, o); };
  const fetch0 = window.fetch;
  window.fetch = function (input, init) { tally('network', `fetch ${String(input?.url ?? input).replace(/\?.*$/, '')}`); return fetch0.call(this, input, init); };
  const xopen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (method, url, ...rest) { tally('network', `xhr ${method} ${String(url).replace(/\?.*$/, '')}`); return xopen.call(this, method, url, ...rest); };
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

// ------------------------------------------------------------------ inside the page: the scene tracker and each second's close
function installTracker() {
  const S = window.__recorder, r = window.__roadcraft, handle = r.scene(), scene = handle.scene, gl = handle.gl;
  const keyOf = (o) => {
    const parts = [];
    for (let x = o; x && !x.isScene; x = x.parent) parts.unshift((x.name || '').replace(/[-_:@#\s]*\d[\w.,:-]*$/, '') || (x === o ? x.type : ''));
    const outside = o.parent || o.isScene ? '' : '(outside the scene) ';
    const named = parts.filter(Boolean);
    const short = named.length > 3 ? [named[0], '…', ...named.slice(-2)] : named;
    return outside + (short.join(' / ') || o.type);
  };
  const bump = (map, key, field, n = 1) => { const e = map.get(key) ?? {}; e[field] = (e[field] ?? 0) + n; map.set(key, e); };
  // A buffer already handed to the GPU may have dropped its array (`mesh/gpuOnly.ts`) and a texture its texels (`surfaceTextures.ts`): the bytes come from the count.
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

  // Draws per element and pass.
  let draws = new Map();
  const rbd = gl.renderBufferDirect.bind(gl);
  gl.renderBufferDirect = function (camera, sceneArg, geometry, material, object, group) {
    if (S.on) {
      const pass = sceneArg === null ? 'shadow' : camera?.isOrthographicCamera ? 'orthographic' : 'scene';
      const index = geometry.index, pos = geometry.attributes.position;
      let count = index ? index.count : (pos ? pos.count : 0);
      const dr = geometry.drawRange;
      count = Math.max(0, Math.min(count, dr.count) - (dr.start || 0));
      if (group) count = Math.min(count, group.count);
      const inst = object.isInstancedMesh ? object.count : (geometry.isInstancedBufferGeometry ? geometry.instanceCount : 1);
      const k = `${keyOf(object)}  [${pass}]`;
      bump(draws, k, 'calls'); bump(draws, k, 'triangles', object.isMesh ? (count / 3) * inst : 0); bump(draws, k, 'vertices', count * inst); bump(draws, k, 'instances', inst);
    }
    return rbd(camera, sceneArg, geometry, material, object, group);
  };

  /** Each element of the scene now. */
  const inventory = () => {
    const inv = new Map(), geoms = new Set(), texs = new Set();
    scene.traverse((o) => {
      const k = keyOf(o);
      bump(inv, k, 'objects');
      if (!o.geometry) return;
      const g = o.geometry, pos = g.attributes.position, idx = g.index, inst = o.isInstancedMesh ? o.count : 1;
      let shown = true;
      for (let x = o; x; x = x.parent) if (!x.visible) { shown = false; break; }
      bump(inv, k, o.isInstancedMesh ? 'instanced meshes' : o.isMesh ? 'meshes' : o.isLine ? 'lines' : o.isPoints ? 'points' : 'other drawables');
      if (shown) bump(inv, k, 'visible');
      bump(inv, k, 'instances', inst);
      if (o.isMesh) bump(inv, k, 'triangles', ((idx ? idx.count : pos?.count ?? 0) / 3) * inst);
      bump(inv, k, 'vertices', (pos?.count ?? 0) * inst);
      if (o.castShadow) bump(inv, k, 'cast shadow');
      if (!geoms.has(g)) {
        geoms.add(g);
        bump(inv, k, 'geometries');
        let b = idx ? attrBytes(idx) : 0;
        const seen = new Set();
        for (const name in g.attributes) { const a = g.attributes[name], key = a.isInterleavedBufferAttribute ? a.data : a; if (!seen.has(key)) { seen.add(key); b += attrBytes(a); } }
        if (o.isInstancedMesh) { b += attrBytes(o.instanceMatrix); if (o.instanceColor) b += attrBytes(o.instanceColor); }
        bump(inv, k, 'geometry bytes', b);
      }
      for (const m of [].concat(o.material ?? [])) {
        for (const t of texturesOf(m)) if (!texs.has(t)) { texs.add(t); bump(inv, k, 'textures'); bump(inv, k, 'texture bytes', texBytes(t)); }
        const e = inv.get(k); (e.materials ??= new Set()).add(`${m.type}${m.name ? ' ' + m.name : ''}`);
      }
    });
    return inv;
  };

  // What changes and what is born, every frame.
  let updates = new Map(), created = new Map(), frames = 0;
  let seen = null;
  const state = new Map(), versions = new WeakMap();
  const snapshot = (first) => {
    const now = { objects: new Map(), geometries: new Map(), materials: new Map(), textures: new Map() };
    scene.traverse((o) => {
      const k = keyOf(o);
      now.objects.set(o.uuid, k);
      const s = state.get(o.uuid), e = o.matrixWorld.elements, g = o.geometry;
      if (!s) state.set(o.uuid, { m: Float64Array.from(e), v: o.visible, c: o.count, ds: g?.drawRange.start, dc: g?.drawRange.count });
      else if (!first) {
        let moved = false;
        for (let i = 0; i < 16; i++) if (s.m[i] !== e[i]) { moved = true; s.m[i] = e[i]; }
        if (moved) bump(updates, k, 'matrix changed');
        if (s.v !== o.visible) { bump(updates, k, 'visibility toggled'); s.v = o.visible; }
        if (o.isInstancedMesh && s.c !== o.count) { bump(updates, k, 'instance count changed'); s.c = o.count; }
        if (g && (s.ds !== g.drawRange.start || s.dc !== g.drawRange.count)) { bump(updates, k, 'draw range changed'); s.ds = g.drawRange.start; s.dc = g.drawRange.count; }
      }
      if (g) {
        now.geometries.set(g.uuid, k);
        const list = Object.entries(g.attributes);
        if (g.index) list.push(['index', g.index]);
        if (o.isInstancedMesh) { list.push(['instanceMatrix', o.instanceMatrix]); if (o.instanceColor) list.push(['instanceColor', o.instanceColor]); }
        for (const [name, a] of list) {
          const v = attrVersion(a), was = versions.get(a);
          if (!first && was !== undefined && was !== v) { bump(updates, k, `${name} re-sent`); bump(updates, k, 'bytes re-sent', attrBytes(a)); }
          versions.set(a, v);
        }
      }
      for (const m of [].concat(o.material ?? [])) {
        now.materials.set(m.uuid, k);
        const was = versions.get(m);
        if (!first && was !== undefined && was !== m.version) bump(updates, k, 'material changed (needsUpdate)');
        versions.set(m, m.version);
        for (const t of texturesOf(m)) {
          now.textures.set(t.uuid, k);
          const tw = versions.get(t);
          if (!first && tw !== undefined && tw !== t.version) { bump(updates, k, 'texture re-sent'); bump(updates, k, 'bytes re-sent', texBytes(t)); }
          versions.set(t, t.version);
        }
      }
    });
    if (seen && !first) {
      for (const kind of Object.keys(now)) {
        for (const [uuid, k] of now[kind]) if (!seen[kind].has(uuid)) bump(created, k, `${kind} created`);
        for (const [uuid, k] of seen[kind]) if (!now[kind].has(uuid)) { bump(created, k, `${kind} removed`); if (kind === 'objects') state.delete(uuid); }
      }
    }
    seen = now;
  };
  const tick = () => { if (S.on) { frames++; snapshot(false); } requestAnimationFrame(tick); };

  const memory = () => ({ 'heap MB': Math.round(performance.memory.usedJSHeapSize / 1e6), geometries: gl.info.memory.geometries, textures: gl.info.memory.textures, programs: gl.info.programs?.length ?? 0 });
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
  /** The second that passed: everything counted in it, and the counters zeroed. */
  S.flush = () => {
    const seconds = (performance.now() - t0) / 1000;
    t0 = performance.now();
    const inv = inventory();
    const sceneChanges = [];
    for (const [k, e] of inv) {
      const was = lastInventory.get(k);
      if (!was) { sceneChanges.push({ element: k, change: 'appeared', ...Object.fromEntries(Object.entries(e).filter(([f]) => f !== 'materials')) }); continue; }
      const diff = {};
      for (const f of new Set([...Object.keys(e), ...Object.keys(was)])) if (f !== 'materials' && (e[f] ?? 0) !== (was[f] ?? 0)) diff[f] = `${was[f] ?? 0} → ${e[f] ?? 0}`;
      if (Object.keys(diff).length) sceneChanges.push({ element: k, change: 'changed', ...diff });
    }
    for (const [k] of lastInventory) if (!inv.has(k)) sceneChanges.push({ element: k, change: 'vanished' });
    lastInventory = inv;
    const cam = camera(), camWas = lastCamera;
    lastCamera = cam;
    const mem = memory(), memWas = lastMemory;
    lastMemory = mem;
    const out = (m) => [...m].map(([k, e]) => ({ element: k, ...e }));
    const tables = {};
    for (const [name, t] of Object.entries(S.tables)) tables[name] = [...t].map(([key, e]) => ({ key, n: e.n, bytes: e.bytes, sites: [...e.sites].sort((a, b) => b[1] - a[1]) }));
    const drag = S.takeDrag();
    const result = {
      seconds, frames, camera: cam, cameraWas: camWas, memory: mem, memoryWas: memWas,
      sim: { paused: r.sim.clock.paused, speed: r.sim.clock.speed, vehicles: r.sim.vehicles.size, people: r.sim.pedViews.length },
      actions: [...S.actions, ...(drag ? [drag] : [])], state: stateChanges(), notes: S.notes.splice(0),
      sceneChanges, draws: out(draws), updates: out(updates), created: out(created), tables,
      workersMade: S.workersMade.slice(workersSeen),
      inventory: [...inv].map(([k, e]) => ({ element: k, ...e, materials: [...(e.materials ?? [])] })),
    };
    workersSeen = S.workersMade.length;
    S.actions = []; S.tables = {}; draws = new Map(); updates = new Map(); created = new Map(); frames = 0;
    return result;
  };
}

// ------------------------------------------------------------------ served lines -> source lines
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

// Where each element's name appears as text in the code.
const sourceFiles = [];
(function walk(dir) { for (const f of readdirSync(dir)) { const p = join(dir, f); if (statSync(p).isDirectory()) walk(p); else if (/\.(ts|tsx|js|mjs)$/.test(f)) sourceFiles.push([relative('.', p).replace(/\\/g, '/'), readFileSync(p, 'utf8').split('\n')]); } })('src');
const nameSites = new Map();
function whereNamed(element) {
  const names = element.replace(/^\(outside the scene\) /, '').replace(/\s+\[[^\]]*\]$/, '').split(' / ').filter((n) => n && n !== '…' && !/^[A-Z][A-Za-z]+$/.test(n));
  const name = names[names.length - 1];
  if (!name) return '(no name: the type alone)';
  if (!nameSites.has(name)) {
    const found = [], quoted = [`'${name}`, `"${name}`, `\`${name}`];
    for (const [file, lines] of sourceFiles) lines.forEach((l, i) => { if (quoted.some((q) => l.includes(q))) found.push(`${file}:${i + 1}`); });
    nameSites.set(name, found.join(', ') || '(name not found as text in src)');
  }
  return nameSites.get(name);
}

// ------------------------------------------------------------------ one second in the file
const num = (x) => (typeof x === 'number' ? x.toLocaleString('en-US', { maximumFractionDigits: 2 }) : String(x));
const fields = (e, skip = ['element']) => Object.entries(e).filter(([k]) => !skip.includes(k)).map(([k, v]) => `${k} ${num(v)}`).join(' · ');
let started = Date.now(), secondNo = 0;
async function writeSecond(r, coverage, heap) {
  secondNo++;
  const L = [];
  const clock = new Date().toLocaleTimeString('en-GB');
  const cam = r.cameraWas && (r.camera.x !== r.cameraWas.x || r.camera.y !== r.cameraWas.y || r.camera.zoom !== r.cameraWas.zoom)
    ? `camera ${r.cameraWas.x},${r.cameraWas.y} zoom ${r.cameraWas.zoom} → ${r.camera.x},${r.camera.y} zoom ${r.camera.zoom}`
    : `camera still at ${r.camera.x},${r.camera.y} zoom ${r.camera.zoom}`;
  const memDiff = Object.entries(r.memory).map(([k, v]) => `${k} ${num(v)}${r.memoryWas && r.memoryWas[k] !== v ? ` (${v - r.memoryWas[k] > 0 ? '+' : ''}${num(v - r.memoryWas[k])})` : ''}`).join(' · ');
  L.push(`\n${'='.repeat(120)}\n[${clock} · second ${secondNo} · +${((Date.now() - started) / 1000).toFixed(0)} s] ${r.frames} frames in ${num(r.seconds)} s · ${cam}`);
  L.push(`simulation: ${r.sim.paused ? 'PAUSED' : `running ${r.sim.speed}×`} · ${r.sim.vehicles} vehicles · ${r.sim.people} people · memory: ${memDiff}`);
  L.push(`ACTIONS: ${[...r.notes.map((n) => `PLAN: ${n}`), ...r.actions].join(' | ') || 'none'}`);
  if (r.state.length) L.push(`GAME STATE: ${r.state.join(' | ')}`);
  L.push(`-- SCENE CHANGED (${r.sceneChanges.length}) --`);
  for (const c of r.sceneChanges) L.push(`  ${c.change.toUpperCase()} ${c.element}: ${fields(c, ['element', 'change'])}  ← ${whereNamed(c.element)}`);
  const drawTotal = r.draws.reduce((s, d) => ({ c: s.c + d.calls, t: s.t + d.triangles }), { c: 0, t: 0 });
  L.push(`-- DRAW (${r.draws.length} elements·passes; total ${num(drawTotal.c / Math.max(1, r.frames))} calls and ${num(drawTotal.t / Math.max(1, r.frames))} triangles per frame) --`);
  for (const d of r.draws.sort((a, b) => b.triangles - a.triangles)) L.push(`  ${d.element}: per frame ${Object.entries(d).filter(([k]) => k !== 'element').map(([k, v]) => `${k} ${num(v / Math.max(1, r.frames))}`).join(' · ')}`);
  L.push(`-- UPDATES (${r.updates.length}) --`);
  for (const u of r.updates.sort((a, b) => (b['matrix changed'] ?? 0) + (b['bytes re-sent'] ?? 0) - (a['matrix changed'] ?? 0) - (a['bytes re-sent'] ?? 0))) L.push(`  ${u.element}: ${fields(u)}  ← ${whereNamed(u.element)}`);
  L.push(`-- CREATE / REMOVE (${r.created.length}) --`);
  for (const c of r.created) L.push(`  ${c.element}: ${fields(c)}  ← ${whereNamed(c.element)}`);
  for (const w of r.workersMade) L.push(`  WORKER CREATED ${w.name} ← ${await siteToSource(w.site)}`);
  for (const [name, title] of [['webgl', 'WEBGL'], ['workers', 'WORKERS'], ['timers', 'TIMERS'], ['events', 'EVENTS'], ['network', 'NETWORK'], ['idb', 'INDEXEDDB'], ['storage', 'STORAGE'], ['dom', 'DOM']]) {
    const t = (r.tables[name] ?? []).sort((a, b) => b.n - a.n);
    L.push(`-- ${title} (${t.length}) --`);
    for (const e of t) {
      L.push(`  ${e.key}: ${num(e.n)}×${e.bytes ? ` · ${num(e.bytes)} bytes` : ''}`);
      for (const [s, n] of e.sites) L.push(`      ${num(n)}× ← ${await siteToSource(s)}`);
    }
  }
  const calls = [];
  for (const script of coverage) {
    if (!script.url.includes('/src/')) continue;
    for (const fn of script.functions) { const count = fn.ranges[0]?.count ?? 0; if (count > 0) calls.push({ fn: fn.functionName || '(anonymous)', url: script.url, offset: fn.ranges[0].startOffset, count }); }
  }
  calls.sort((a, b) => b.count - a.count);
  L.push(`-- CALLS of game functions (${calls.length}) --`);
  const callRows = [];
  for (const c of calls) { const at = await originalAtOffset(c.url, c.offset); callRows.push({ fn: c.fn, at, n: c.count }); L.push(`  ${num(c.count)}× ${c.fn} ← ${at}`); }
  const alloc = new Map();
  (function walk(node, owner) {
    const f = node.callFrame;
    const here = f.url.includes('/src/') ? `${f.url}:${f.lineNumber + 1}:${f.columnNumber + 1}|${f.functionName || '(anonymous)'}` : owner;
    const key = here ?? `|${f.functionName || '(native)'} ${shortPath(f.url)}`;
    if (node.selfSize) alloc.set(key, (alloc.get(key) ?? 0) + node.selfSize);
    for (const c of node.children) walk(c, here);
  })(heap.head, null);
  const allocRows = [];
  L.push(`-- ALLOC: JS memory per game line (${alloc.size}) --`);
  for (const [k, bytes] of [...alloc].sort((a, b) => b[1] - a[1])) {
    const [where, fn] = k.split('|');
    const m = where.match(/^(.*):(\d+):(\d+)$/);
    const at = m ? await original(m[1], Number(m[2]), Number(m[3])) : '(outside src)';
    allocRows.push({ fn, at, bytes });
    L.push(`  ${num(bytes)} bytes ${fn} ← ${at}`);
  }
  appendFileSync(TXT, L.join('\n') + '\n');
  const { inventory, ...rest } = r;
  appendFileSync(JSONL, JSON.stringify({ second: secondNo, ...rest, inventory: secondNo === 1 || r.sceneChanges.length ? inventory : undefined, calls: callRows, alloc: allocRows }) + '\n');
}

// ------------------------------------------------------------------ open, and record until it ends
mkdirSync(OUT, { recursive: true });
writeFileSync(TXT, `PROBE — ${new Date().toLocaleString('en-GB')} — ${PLAN ? 'automatic plan' : 'game open to play (records until the window closes)'}\n`);
writeFileSync(JSONL, '');
const { browser, page, fit } = await openCity({ zoom: 1, init: instrument, free: false, headless: PLAN, settle: PLAN && !OPENING, city: !OPENING });
await page.evaluate(installTracker);
const cdp = await page.context().newCDPSession(page);
await cdp.send('Profiler.enable');
await cdp.send('HeapProfiler.enable');
await cdp.send('Profiler.startPreciseCoverage', { callCount: true, detailed: false });
await cdp.send('HeapProfiler.startSampling', { samplingInterval: 16384, includeObjectsCollectedByMajorGC: true, includeObjectsCollectedByMinorGC: true });
await page.evaluate(() => window.__recorder.start());
await cdp.send('Profiler.takePreciseCoverage');
started = Date.now();

let open = true;
page.on('close', () => { open = false; });
browser.on('disconnected', () => { open = false; });
/** One second recorded: what the page counted, and V8's calls and allocations since the last one. */
async function recordSecond() {
  const r = await page.evaluate(() => window.__recorder.flush());
  const coverage = (await cdp.send('Profiler.takePreciseCoverage')).result;
  const heap = (await cdp.send('HeapProfiler.getSamplingProfile')).profile;
  await cdp.send('HeapProfiler.stopSampling');
  await cdp.send('HeapProfiler.startSampling', { samplingInterval: 16384, includeObjectsCollectedByMajorGC: true, includeObjectsCollectedByMinorGC: true });
  await writeSecond(r, coverage, heap);
}
const recorder = (async () => {
  while (open) {
    const t = Date.now();
    try { await recordSecond(); } catch (e) { if (open) appendFileSync(TXT, `\n(second not recorded: ${e.message.split('\n')[0]})\n`); }
    await new Promise((res) => setTimeout(res, Math.max(0, 1000 - (Date.now() - t))));
  }
})();

if (OPENING) {
  // THE OPENING: the city opened as the menu opens it, recorded from before; each second says what appeared and what the game was doing.
  await page.evaluate((seed) => { window.__recorder.note(`opens the small city (seed ${seed}), as the menu's "New city" does`); window.__roadcraft.smallCity(seed); }, Number(arg('--seed', '7')));
  await page.waitForTimeout(Number(arg('--seconds', '30')) * 1000);
  open = false;
  await recorder;
  await browser.close();
} else if (PLAN) {
  const note = (text) => page.evaluate((t) => window.__recorder.note(t), text);
  for (const view of VIEWS) {
    await note(`camera to the ${view.name} view (zoom ${view.zoom}× the whole city)`);
    await lookAt(page, fit, view.zoom);
    await note(`${view.name}: STILL (clock stopped, camera still) for ${SECONDS} s`);
    await page.evaluate(() => window.__roadcraft.measure(true));
    await page.waitForTimeout(SECONDS * 1000);
    await note(`${view.name}: PLAYING (simulation running, camera still) for ${SECONDS} s`);
    await page.evaluate(() => window.__roadcraft.measure(false));
    await page.waitForTimeout(SECONDS * 1000);
    await note(`${view.name}: CAMERA MOVING (clock stopped) for ${SECONDS} s`);
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
  console.log(`Recording to ${TXT} — play in the Chrome window; close the window to stop.`);
  await recorder;
  await browser.close().catch(() => {});
}
console.log(`Log: ${TXT} (${secondNo} seconds) and ${JSONL}`);
