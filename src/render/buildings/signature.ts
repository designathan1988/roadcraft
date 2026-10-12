import {
  BoxGeometry,
  BufferAttribute,
  BufferGeometry as Geometry,
  PlaneGeometry,
  SphereGeometry,
  type BufferGeometry,
  CanvasTexture,
  ConeGeometry,
  CylinderGeometry,
  DoubleSide,
  Group,
  IcosahedronGeometry,
  type Material,
  Mesh,
  MeshStandardMaterial,
  RepeatWrapping,
  SRGBColorSpace,
} from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

import { signatureKind } from '@world/buildings/towerKit';
import { LANDMARKS } from './landmarks';
import type { Building } from '@world/buildings/types';
import { m } from '@world/units';

/**
 * Signature buildings: a building of the tower kit drawn with parts of its
 * own - its own windows, balconies, railings, cladding, planters, roof plant -
 * modelled from the reference the player gave, instead of the shared facade
 * kit every other building is drawn with (`kit.ts`, `buildingMesh.ts`).
 *
 * The building's blocks stay in its record (picking, collisions, its lot);
 * `buildingMesh.ts` leaves its closed blocks out and this module draws the
 * body, sized from those blocks, so resizing the blocks resizes the drawing.
 * Each material's parts are merged into one mesh: a building is a handful of
 * draws. Materials and textures are made once (AGENTS.md).
 *
 * Metres in the building's frame: x along the front, y back from it, z up
 * from the floor; three's frame is (x, z, -y), as everywhere in this layer.
 */

/** A material's name: the shared ones of `makeMaterials`, or a facade made by `facade`. */
type Mat = string;

let materials: Record<Mat, Material> | null = null;
/** Facade materials, by style and storey rhythm, made once each. */
const facades = new Map<string, Material>();

type FacadeKind = 'curtainBlue' | 'curtainDark' | 'curtainGreen' | 'punchedBeige' | 'punchedCream' | 'gridDark' | 'brick' | 'stoneGrid'
  | 'archTerracotta' | 'ribbonWhite' | 'squareConcrete' | 'navyGrid' | 'copperFins' | 'ribbonBlack' | 'punchedPink' | 'curtainTeal'
  | 'archBrick' | 'archStone' | 'decoStripes' | 'loftBrick' | 'tallStone' | 'schoolBrick' | 'gothicStone' | 'officeWhite';

/**
 * A facade drawn as a picture of its bays - panes and mullions, spandrels,
 * punched windows in a wall - tiling one bay across and one storey up, so
 * floor lines meet the slabs: `base` is the height (m) the storeys start at.
 */
function facade(kind: FacadeKind, bay: number, storey: number, base: number): Mat {
  const key = `${kind}|${bay}|${storey}|${base}`;
  if (facades.has(key)) return key;
  const t = canvasTexture(256, (g, s) => {
    const glass = (top: string, bottom: string, x: number, y: number, w: number, h: number): void => {
      const grad = g.createLinearGradient(0, y, 0, y + h);
      grad.addColorStop(0, top); grad.addColorStop(1, bottom);
      g.fillStyle = grad; g.fillRect(x, y, w, h);
    };
    const brickWall = (base: string): void => {
      g.fillStyle = base; g.fillRect(0, 0, s, s);
      for (let y = 0; y < s; y += 7) {
        g.fillStyle = 'rgba(70,30,20,.35)'; g.fillRect(0, y, s, 1);
        for (let x = (y / 7) % 2 ? 0 : 9; x < s; x += 18) g.fillRect(x, y, 1, 7);
        g.fillStyle = `rgba(${150 + Math.random() * 40},${60 + Math.random() * 20},40,.15)`; g.fillRect(Math.random() * s, y + 1, 30, 5);
      }
    };
    const archWindow = (x: number, y: number, w: number, h: number, frame: string, pane: string, mull: string): void => {
      g.fillStyle = frame; g.beginPath(); g.arc(x + w / 2, y + w / 2, w / 2 + 7, Math.PI, 0); g.lineTo(x + w + 7, y + h + 6); g.lineTo(x - 7, y + h + 6); g.fill();
      g.fillStyle = pane; g.beginPath(); g.arc(x + w / 2, y + w / 2, w / 2, Math.PI, 0); g.lineTo(x + w, y + h); g.lineTo(x, y + h); g.fill();
      g.fillStyle = mull; g.fillRect(x + w / 2 - 2, y, 4, h); g.fillRect(x, y + h * 0.55, w, 3);
      g.fillStyle = frame; g.fillRect(x - 10, y + h + 4, w + 20, 9);
    };
    if (kind === 'archBrick' || kind === 'archStone') {
      if (kind === 'archBrick') brickWall('#a5543a'); else { g.fillStyle = '#e4ded2'; g.fillRect(0, 0, s, s); g.fillStyle = 'rgba(150,140,125,.35)'; for (let y = 0; y < s; y += 32) g.fillRect(0, y, s, 2); }
      archWindow(s * 0.3, s * 0.2, s * 0.4, s * 0.58, kind === 'archBrick' ? '#ddd3bf' : '#cfc6b4', '#3c4650', '#e9e2d0');
      g.fillStyle = 'rgba(255,214,150,.25)'; g.fillRect(s * 0.32, s * 0.45, s * 0.36, s * 0.3);
    } else if (kind === 'decoStripes') {
      g.fillStyle = '#d6c7aa'; g.fillRect(0, 0, s, s);
      g.fillStyle = 'rgba(120,105,80,.3)'; for (let y = 0; y < s; y += 40) g.fillRect(0, y, s, 2);
      glass('#4a5866', '#1f2a33', s * 0.3, 0, s * 0.15, s); glass('#4a5866', '#1f2a33', s * 0.55, 0, s * 0.15, s);
      g.fillStyle = '#b8954a'; g.fillRect(s * 0.47, 0, s * 0.06, s);
      g.fillStyle = '#c5a35a'; g.fillRect(s * 0.3, s * 0.88, s * 0.4, 6);
    } else if (kind === 'loftBrick') {
      brickWall('#9a4632');
      g.fillStyle = '#1e2023'; g.fillRect(s * 0.12, s * 0.1, s * 0.76, s * 0.75);
      glass('#a99a7f', '#4b4237', s * 0.15, s * 0.13, s * 0.7, s * 0.69);
      g.fillStyle = '#1e2023';
      for (let k = 1; k < 4; k++) g.fillRect(s * 0.15 + (k * s * 0.7) / 4 - 2, s * 0.13, 4, s * 0.69);
      for (let k = 1; k < 4; k++) g.fillRect(s * 0.15, s * 0.13 + (k * s * 0.69) / 4 - 2, s * 0.7, 4);
    } else if (kind === 'tallStone' || kind === 'gothicStone') {
      g.fillStyle = kind === 'tallStone' ? '#d9d3c6' : '#d8ccb3'; g.fillRect(0, 0, s, s);
      g.strokeStyle = 'rgba(140,130,115,.4)'; g.lineWidth = 2;
      for (let y = 0; y < s; y += 26) { g.beginPath(); g.moveTo(0, y); g.lineTo(s, y); g.stroke(); for (let x = (y / 26) % 2 ? 0 : 32; x < s; x += 64) { g.beginPath(); g.moveTo(x, y); g.lineTo(x, y + 26); g.stroke(); } }
      if (kind === 'tallStone') {
        g.fillStyle = '#8c7a4a'; g.fillRect(s * 0.32, s * 0.06, s * 0.36, s * 0.88);
        glass('#3f4a52', '#1d2328', s * 0.34, s * 0.08, s * 0.32, s * 0.84);
        g.fillStyle = '#8c7a4a'; g.fillRect(s * 0.49, s * 0.08, 5, s * 0.84); g.fillRect(s * 0.34, s * 0.5, s * 0.32, 4);
      } else {
        g.fillStyle = '#bba98a'; g.beginPath(); g.moveTo(s * 0.38, s * 0.3); g.quadraticCurveTo(s * 0.5, s * 0.05, s * 0.62, s * 0.3); g.lineTo(s * 0.62, s * 0.8); g.lineTo(s * 0.38, s * 0.8); g.fill();
        const gr = g.createLinearGradient(0, s * 0.15, 0, s * 0.78); gr.addColorStop(0, '#7a3b52'); gr.addColorStop(0.5, '#2f5a8a'); gr.addColorStop(1, '#c49a3a');
        g.fillStyle = gr; g.beginPath(); g.moveTo(s * 0.41, s * 0.31); g.quadraticCurveTo(s * 0.5, s * 0.1, s * 0.59, s * 0.31); g.lineTo(s * 0.59, s * 0.77); g.lineTo(s * 0.41, s * 0.77); g.fill();
      }
    } else if (kind === 'schoolBrick') {
      brickWall('#a14d36');
      g.fillStyle = '#efe9dc'; g.fillRect(s * 0.1, s * 0.16, s * 0.8, s * 0.62);
      glass('#7d9fb2', '#3a5161', s * 0.13, s * 0.19, s * 0.74, s * 0.56);
      g.fillStyle = '#efe9dc'; for (let k = 1; k < 3; k++) g.fillRect(s * 0.13 + (k * s * 0.74) / 3 - 3, s * 0.19, 6, s * 0.56); g.fillRect(s * 0.13, s * 0.45, s * 0.74, 5);
      g.fillStyle = '#e4dccb'; g.fillRect(0, s * 0.92, s, 8);
    } else if (kind === 'officeWhite') {
      g.fillStyle = '#eef0f1'; g.fillRect(0, 0, s, s);
      g.fillStyle = 'rgba(180,186,190,.6)'; g.fillRect(0, s * 0.5, s, 2); g.fillRect(s * 0.5, 0, 2, s);
      glass('#8fb4cd', '#3f6680', s * 0.08, s * 0.22, s * 0.84, s * 0.48);
      g.fillStyle = '#d2d7da'; for (let k = 1; k < 4; k++) g.fillRect(s * 0.08 + (k * s * 0.84) / 4 - 2, s * 0.22, 4, s * 0.48);
    } else if (kind === 'archTerracotta') {
      // Terracotta wall, a tall window with a round head, a white sill.
      g.fillStyle = '#b8653f'; g.fillRect(0, 0, s, s);
      const x = s * 0.28, w = s * 0.44, y = s * 0.3, h = s * 0.5;
      g.fillStyle = '#f1e6d6'; g.beginPath(); g.arc(s / 2, y, w / 2 + 6, Math.PI, 0); g.lineTo(x + w + 6, y + h + 4); g.lineTo(x - 6, y + h + 4); g.fill();
      g.fillStyle = '#34424d'; g.beginPath(); g.arc(s / 2, y, w / 2, Math.PI, 0); g.lineTo(x + w, y + h); g.lineTo(x, y + h); g.fill();
      g.fillStyle = '#f1e6d6'; g.fillRect(s / 2 - 2, y - w / 2, 4, h + w / 2); g.fillRect(x - 10, y + h + 4, w + 20, 8);
    } else if (kind === 'ribbonWhite' || kind === 'ribbonBlack') {
      // A band of glass the width of the bay, solid parapet below and above.
      const white = kind === 'ribbonWhite';
      g.fillStyle = white ? '#f3f2ee' : '#1d1f22'; g.fillRect(0, 0, s, s);
      glass(white ? '#7fa2b8' : '#a9c2cf', white ? '#3f5a6b' : '#6d8796', 0, s * 0.18, s, s * 0.52);
      g.fillStyle = white ? '#d9dadc' : '#444'; g.fillRect(0, s * 0.18, s, 3); g.fillRect(0, s * 0.7 - 3, s, 3);
      for (let k = 0; k < 4; k++) g.fillRect(k * s / 4, s * 0.18, 3, s * 0.52);
    } else if (kind === 'squareConcrete') {
      g.fillStyle = '#b9b6ae'; g.fillRect(0, 0, s, s);
      for (let i = 0; i < 300; i++) { g.fillStyle = 'rgba(120,118,112,.25)'; g.fillRect(Math.random() * s, Math.random() * s, 2, 2); }
      g.fillStyle = '#e07b2c'; g.fillRect(s * 0.18, s * 0.18, s * 0.64, s * 0.6);
      glass('#5e7d8f', '#2c3b45', s * 0.22, s * 0.22, s * 0.56, s * 0.52);
    } else if (kind === 'navyGrid') {
      g.fillStyle = '#1f2f4a'; g.fillRect(0, 0, s, s);
      glass('#6f8fb3', '#2d405c', s * 0.08, s * 0.1, s * 0.84, s * 0.68);
      g.fillStyle = '#c9a54a'; g.fillRect(0, s * 0.85, s, 4);
    } else if (kind === 'copperFins') {
      glass('#7e9aa6', '#3e525b', 0, 0, s, s);
      for (let k = 0; k < 4; k++) { g.fillStyle = '#b06d3c'; g.fillRect(k * s / 4, 0, s / 12, s); g.fillStyle = '#d18b55'; g.fillRect(k * s / 4, 0, 4, s); }
      g.fillStyle = '#5b3a24'; g.fillRect(0, s * 0.85, s, s * 0.15);
    } else if (kind === 'punchedPink') {
      g.fillStyle = '#e3a9a8'; g.fillRect(0, 0, s, s);
      const x = s * 0.25, y = s * 0.22, w = s * 0.5, h = s * 0.55;
      g.fillStyle = '#ffffff'; g.fillRect(x - 6, y - 6, w + 12, h + 12);
      glass('#7f9fae', '#384a55', x, y, w, h);
      g.fillStyle = '#ffffff'; g.fillRect(x + w / 2 - 2, y, 4, h); g.fillRect(x, y + h * 0.35, w, 3);
    } else if (kind === 'curtainBlue' || kind === 'curtainDark' || kind === 'curtainGreen' || kind === 'curtainTeal') {
      const [a, b, mull, spand] = kind === 'curtainBlue' ? ['#9fc0d6', '#5f8099', '#d5dadd', '#6c7f8c']
        : kind === 'curtainDark' ? ['#4b5a66', '#222b33', '#5a6168', '#1b2127']
        : kind === 'curtainTeal' ? ['#7fc2c4', '#2f6f73', '#e8efee', '#2b5557'] : ['#8fb3ae', '#557a76', '#cfd6d3', '#5d736f'];
      glass(a, b, 0, 0, s, s);
      g.fillStyle = spand; g.fillRect(0, s * 0.82, s, s * 0.18);
      g.fillStyle = mull; g.fillRect(0, s * 0.8, s, 6); g.fillRect(0, s - 4, s, 4); g.fillRect(0, 0, 5, s); g.fillRect(s / 2 - 2, 0, 4, s * 0.8);
      g.fillStyle = 'rgba(255,255,255,.08)'; g.fillRect(s * 0.1, 0, s * 0.15, s * 0.8);
    } else {
      const wall = kind === 'punchedBeige' ? '#d9c39a' : kind === 'punchedCream' ? '#e9e2d4' : kind === 'gridDark' ? '#3a3f45'
        : kind === 'brick' ? '#9a4a35' : '#d8d4cc';
      g.fillStyle = wall; g.fillRect(0, 0, s, s);
      if (kind === 'brick') {
        g.strokeStyle = 'rgba(60,25,15,.45)'; g.lineWidth = 1;
        for (let y = 0; y < s; y += 8) { g.beginPath(); g.moveTo(0, y); g.lineTo(s, y); g.stroke(); }
      }
      const wide = kind === 'gridDark' || kind === 'stoneGrid' ? 0.78 : kind === 'brick' ? 0.6 : 0.46;
      const x = s * (1 - wide) / 2, y = s * 0.2, w = s * wide, h = s * 0.58;
      g.fillStyle = kind === 'gridDark' ? '#c9ced2' : '#2b2e31'; g.fillRect(x - 5, y - 5, w + 10, h + 10);
      glass(kind === 'gridDark' ? '#6d8496' : '#7d97a8', '#34434f', x, y, w, h);
      g.fillStyle = kind === 'gridDark' ? '#c9ced2' : '#2b2e31'; g.fillRect(x + w / 2 - 2, y, 4, h);
      if (kind === 'punchedBeige' || kind === 'punchedCream') { g.fillStyle = 'rgba(255,255,255,.5)'; g.fillRect(x - 8, y + h + 5, w + 16, 6); }
    }
  }, 1 / bay, 1 / storey);
  t.offset.y = -base / storey;
  const glassy = kind.startsWith('curtain') || kind === 'copperFins';
  facades.set(key, new MeshStandardMaterial({ map: t, roughness: glassy ? 0.15 : 0.85, metalness: glassy ? 0.45 : 0 }));
  return key;
}

function canvasTexture(size: number, paint: (g: CanvasRenderingContext2D, s: number) => void, repeatX = 1, repeatY = 1): CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  paint(canvas.getContext('2d')!, size);
  const t = new CanvasTexture(canvas);
  t.wrapS = t.wrapT = RepeatWrapping;
  t.repeat.set(repeatX, repeatY);
  t.colorSpace = SRGBColorSpace;
  t.anisotropy = 8;
  return t;
}

function makeMaterials(): Record<Mat, Material> {
  // Stone base: large grey slabs, thin joints (a 1.2 m x 0.6 m course).
  const stone = canvasTexture(256, (g, s) => {
    g.fillStyle = '#77736e'; g.fillRect(0, 0, s, s);
    for (let i = 0; i < 400; i++) { g.fillStyle = `rgba(${90 + Math.random() * 40},${88 + Math.random() * 36},${84 + Math.random() * 30},.35)`; g.fillRect(Math.random() * s, Math.random() * s, 3, 3); }
    g.strokeStyle = '#4f4c49'; g.lineWidth = 3;
    for (let r = 0; r < 4; r++) {
      g.beginPath(); g.moveTo(0, r * s / 4); g.lineTo(s, r * s / 4); g.stroke();
      const off = r % 2 ? s / 4 : 0;
      for (let c = 0; c < 3; c++) { g.beginPath(); g.moveTo(off + c * s / 2, r * s / 4); g.lineTo(off + c * s / 2, (r + 1) * s / 4); g.stroke(); }
    }
  }, 1 / 2.4, 1 / 2.4);
  // Render: warm light grey, a faint trowel texture.
  const render = canvasTexture(128, (g, s) => {
    g.fillStyle = '#d9d4cb'; g.fillRect(0, 0, s, s);
    for (let i = 0; i < 900; i++) { const v = 200 + Math.random() * 30; g.fillStyle = `rgba(${v},${v - 4},${v - 10},.25)`; g.fillRect(Math.random() * s, Math.random() * s, 2, 2); }
  }, 1 / 3, 1 / 3);
  // Timber cladding: horizontal boards of a brown-orange wood, 0.15 m each.
  const wood = canvasTexture(256, (g, s) => {
    for (let r = 0; r < 16; r++) {
      const v = Math.random() * 18;
      g.fillStyle = `rgb(${150 + v},${86 + v * 0.6},${52 + v * 0.4})`;
      g.fillRect(0, r * s / 16, s, s / 16);
      g.fillStyle = 'rgba(60,30,15,.55)'; g.fillRect(0, r * s / 16, s, 2);
      for (let k = 0; k < 6; k++) { g.fillStyle = 'rgba(90,45,20,.18)'; g.fillRect(Math.random() * s, r * s / 16 + 3 + Math.random() * 8, 30 + Math.random() * 60, 1); }
    }
  }, 1 / 2.4, 1 / 2.4);
  // Vertical timber slats with dark gaps.
  const slats = canvasTexture(128, (g, s) => {
    g.fillStyle = '#2a1a10'; g.fillRect(0, 0, s, s);
    for (let c = 0; c < 8; c++) {
      const v = Math.random() * 16;
      g.fillStyle = `rgb(${140 + v},${82 + v * 0.6},${48 + v * 0.4})`;
      g.fillRect(c * s / 8 + 2, 0, s / 8 - 5, s);
    }
  }, 1 / 0.8, 1);
  // Railing: black frame, top and bottom rails, thin bars 0.11 m apart (alpha).
  const railing = canvasTexture(128, (g, s) => {
    g.clearRect(0, 0, s, s);
    g.fillStyle = '#ffffff';
    g.fillRect(0, 0, s, 9); g.fillRect(0, s - 7, s, 7); g.fillRect(0, s * 0.16, s, 3);
    for (let c = 0; c < 9; c++) g.fillRect(c * s / 9, 0, 3, s);
  }, 1, 1 / 1.05);
  const std = (p: ConstructorParameters<typeof MeshStandardMaterial>[0]): MeshStandardMaterial => new MeshStandardMaterial(p);
  // Surfaces that read as stone, concrete, roofing, tiles: never flat colour (flat light planes blow out to white).
  const ashlar = (base: string, joint: string): CanvasTexture => canvasTexture(256, (g, s) => {
    g.fillStyle = base; g.fillRect(0, 0, s, s);
    for (let i = 0; i < 700; i++) { g.fillStyle = `rgba(${90 + Math.random() * 80},${85 + Math.random() * 75},${75 + Math.random() * 70},.12)`; g.fillRect(Math.random() * s, Math.random() * s, 3, 3); }
    g.strokeStyle = joint; g.lineWidth = 2;
    for (let r = 0; r < 8; r++) { g.beginPath(); g.moveTo(0, (r * s) / 8); g.lineTo(s, (r * s) / 8); g.stroke(); for (let c = 0; c < 4; c++) { const x = (c + (r % 2) * 0.5) * (s / 4); g.beginPath(); g.moveTo(x, (r * s) / 8); g.lineTo(x, ((r + 1) * s) / 8); g.stroke(); } }
  }, 1 / 2.4, 1 / 2.4);
  const speckle = (base: string, dot: number, lines = 0): CanvasTexture => canvasTexture(256, (g, s) => {
    g.fillStyle = base; g.fillRect(0, 0, s, s);
    for (let i = 0; i < 2500; i++) { const v = Math.random() > 0.5 ? 255 : 0; g.fillStyle = `rgba(${v},${v},${v},${dot})`; g.fillRect(Math.random() * s, Math.random() * s, 2, 2); }
    g.fillStyle = 'rgba(0,0,0,.18)'; for (let k = 1; k <= lines; k++) { g.fillRect(0, (k * s) / (lines + 1), s, 2); g.fillRect((k * s) / (lines + 1), 0, 2, s); }
  }, 1 / 4, 1 / 4);
  // Rusticated stone: 0.6 m courses with deep shadowed joints, long blocks.
  const rusticated = (base: string, joint: string): CanvasTexture => canvasTexture(256, (g, s) => {
    g.fillStyle = base; g.fillRect(0, 0, s, s);
    for (let i = 0; i < 600; i++) { g.fillStyle = `rgba(${120 + Math.random() * 60},${110 + Math.random() * 50},${90 + Math.random() * 40},.12)`; g.fillRect(Math.random() * s, Math.random() * s, 3, 3); }
    for (let r = 0; r < 4; r++) {
      const y = (r * s) / 4;
      g.fillStyle = joint; g.fillRect(0, y, s, 7);
      g.fillStyle = 'rgba(255,255,255,.25)'; g.fillRect(0, y + 7, s, 2);
      for (let c = 0; c < 2; c++) { g.fillStyle = joint; g.fillRect((c + (r % 2) * 0.5) * (s / 2), y, 5, s / 4); }
    }
  }, 1 / 2.4, 1 / 2.4);
  // An Art Deco gilded panel: a stepped sunburst and zigzags.
  const decoPanel = (base: string, gold: string): CanvasTexture => canvasTexture(128, (g, s) => {
    g.fillStyle = base; g.fillRect(0, 0, s, s);
    g.strokeStyle = gold; g.lineWidth = 4;
    for (let k = 0; k < 4; k++) g.strokeRect(8 + k * 10, 8 + k * 10, s - 16 - k * 20, s - 16 - k * 20);
    g.fillStyle = gold;
    for (let k = 0; k < 7; k++) { g.beginPath(); g.moveTo(s / 2, s * 0.62); g.lineTo(s * (0.2 + k * 0.1), s * 0.25); g.lineTo(s * (0.24 + k * 0.1), s * 0.25); g.fill(); }
  }, 1 / 1.6, 1 / 1.1);
  // A standing-seam copper roof: vertical seams 0.5 m apart.
  const seams = (base: string, seam: string): CanvasTexture => canvasTexture(64, (g, s) => {
    g.fillStyle = base; g.fillRect(0, 0, s, s);
    g.fillStyle = seam; for (let k = 0; k < 4; k++) g.fillRect((k * s) / 4, 0, 3, s);
    g.fillStyle = 'rgba(255,255,255,.08)'; for (let k = 0; k < 4; k++) g.fillRect((k * s) / 4 + 3, 0, 2, s);
  }, 1 / 2, 1 / 2);
  // Art Deco spandrel: gilded chevrons on dark bronze.
  const chevrons = (base: string, gold: string): CanvasTexture => canvasTexture(128, (g, s) => {
    g.fillStyle = base; g.fillRect(0, 0, s, s);
    g.strokeStyle = gold; g.lineWidth = 5;
    for (let k = 0; k < 3; k++) { const y = s * (0.25 + k * 0.25); g.beginPath(); g.moveTo(0, y + s * 0.12); g.lineTo(s / 2, y - s * 0.08); g.lineTo(s, y + s * 0.12); g.stroke(); }
    g.fillStyle = gold; g.fillRect(0, 0, s, 5); g.fillRect(0, s - 5, s, 5);
  }, 1 / 1.5, 1 / 1);
  const courses = (base: string, line: string, rows: number): CanvasTexture => canvasTexture(128, (g, s) => {
    g.fillStyle = base; g.fillRect(0, 0, s, s);
    for (let r = 0; r < rows; r++) { g.fillStyle = line; g.fillRect(0, (r * s) / rows, s, 2); for (let c = 0; c < 6; c++) g.fillRect((c + (r % 2) * 0.5) * (s / 6), (r * s) / rows, 1, s / rows); g.fillStyle = `rgba(0,0,0,${Math.random() * 0.08})`; g.fillRect(0, (r * s) / rows + 2, s, s / rows - 2); }
  }, 1 / 1.5, 1 / 1.5);
  return {
    stone: std({ map: stone, roughness: 0.85 }),
    render: std({ map: render, roughness: 0.92 }),
    trim: std({ color: 0xe6dfd3, roughness: 0.85 }),
    wood: std({ map: wood, roughness: 0.7 }),
    slats: std({ map: slats, roughness: 0.75 }),
    slab: std({ color: 0xece8e0, roughness: 0.8 }),
    frame: std({ color: 0x26282b, roughness: 0.45, metalness: 0.5 }),
    // Daylight glass: dark, reflective, a faint warmth from the rooms behind.
    glass: std({ color: 0x3a4550, emissive: 0x6b5236, emissiveIntensity: 0.25, roughness: 0.08, metalness: 0.7 }),
    railing: std({ color: 0x1c1d1f, alphaMap: railing, alphaTest: 0.5, transparent: false, side: DoubleSide, roughness: 0.5, metalness: 0.4 }),
    pot: std({ color: 0x4a4d51, roughness: 0.75 }),
    leaf: std({ color: 0x4d7a32, roughness: 0.9, flatShading: true }),
    leafDark: std({ color: 0x35612a, roughness: 0.9, flatShading: true }),
    metal: std({ color: 0x3b3e42, roughness: 0.45, metalness: 0.6 }),
    plant: std({ color: 0xa9a59e, roughness: 0.7 }),
    sconce: std({ color: 0xfff1d8, emissive: 0xffd49a, emissiveIntensity: 1.2 }),
    orange: std({ color: 0xe07b2c, roughness: 0.6 }),
    woodDark: std({ color: 0x5a3b24, roughness: 0.8 }),
    door: std({ map: wood, color: 0x8a5a36, roughness: 0.6 }),
    slate: std({ map: courses('#454c56', '#2c3138', 8), roughness: 0.7 }),
    roofing: std({ map: speckle('#6b6d70', 0.1, 3), roughness: 0.95 }),
    patina: std({ color: 0x6f9a8a, roughness: 0.5, metalness: 0.4 }),
    redPaint: std({ color: 0xb3262a, roughness: 0.55 }),
    brickRed: std({ color: 0xa04a34, roughness: 0.9 }),
    ivory: std({ map: ashlar('#d3cbbb', 'rgba(120,108,90,.45)'), roughness: 0.8 }),
    asphalt: std({ color: 0x3c3f43, roughness: 0.95 }),
    concreteLight: std({ map: speckle('#a9a6a0', 0.08, 1), roughness: 0.9 }),
    gravel: std({ map: speckle('#a3967f', 0.16), roughness: 1 }),
    lawn: std({ map: speckle('#4f7c33', 0.12), roughness: 1 }),
    blackSteel: std({ color: 0x1f2124, roughness: 0.5, metalness: 0.5 }),
    blueSteel: std({ color: 0x2f5fa8, roughness: 0.5, metalness: 0.3 }),
    yellowPaint: std({ color: 0xe8c22a, roughness: 0.6 }),
    gold: std({ color: 0xc9a54a, roughness: 0.35, metalness: 0.8 }),
    copper: std({ color: 0xb06d3c, roughness: 0.35, metalness: 0.75 }),
    roofTerracotta: std({ map: courses('#a6503a', '#6e2f22', 10), roughness: 0.8 }),
    glassRail: std({ color: 0xcfe3ec, transparent: true, opacity: 0.38, roughness: 0.05, metalness: 0.2, depthWrite: false }),
    white: std({ map: speckle('#dddcd6', 0.05, 1), roughness: 0.8 }),
    stoneLight: std({ map: ashlar('#c4bdaf', 'rgba(110,100,85,.5)'), roughness: 0.8 }),
    beige: std({ color: 0xd9c49c, roughness: 0.85 }),
    brickPier: std({ color: 0x8f4433, roughness: 0.9 }),
    darkPanel: std({ color: 0x2f3439, roughness: 0.6, metalness: 0.3 }),
    lightGrid: std({ color: 0xc4c9cd, roughness: 0.6 }),
    podiumGlass: std({ color: 0x40505c, emissive: 0x5a4630, emissiveIntensity: 0.3, roughness: 0.08, metalness: 0.7 }),
    // The landmarks' (`landmarks.ts`): warm limestone, rusticated courses, a copper roof gone green.
    limestone: std({ map: ashlar('#cbbb9c', 'rgba(110,92,64,.35)'), roughness: 0.82 }),
    rustic: std({ map: rusticated('#c8b898', 'rgba(70,58,40,.75)'), roughness: 0.85 }),
    copperRoof: std({ map: seams('#4a645a', '#2c3d36'), roughness: 0.65, metalness: 0.1 }),
    awning: std({ color: 0x2c5a44, roughness: 0.8, side: DoubleSide }),
    decoStone: std({ map: ashlar('#d8c6a0', 'rgba(120,100,70,.3)'), roughness: 0.78 }),
    decoSpandrel: std({ map: chevrons('#5a4527', '#d8b157'), roughness: 0.4, metalness: 0.6 }),
    glassDeco: std({ color: 0x33403f, emissive: 0x6b5236, emissiveIntensity: 0.32, roughness: 0.08, metalness: 0.7 }),
    glassBlue: std({ color: 0x4a6f93, emissive: 0x4a4a3a, emissiveIntensity: 0.18, roughness: 0.05, metalness: 0.75 }),
    lightStrip: std({ color: 0xfff0d2, emissive: 0xffd49a, emissiveIntensity: 1.3 }),
    terracotta: std({ map: courses('#b0603a', '#7d3c22', 14), roughness: 0.75 }),
    alu: std({ color: 0xb9c0c6, roughness: 0.35, metalness: 0.6 }),
    // The landmarks' glass: glass, reflecting the sky and the street (the scene's environment), no picture behind it.
    glassLit: std({ color: 0x8a9cab, roughness: 0.06, metalness: 0.75 }),
    glassBlueLit: std({ color: 0x5b8cc0, roughness: 0.05, metalness: 0.7 }),
    frameWhite: std({ color: 0xeee7da, roughness: 0.55 }),
    frameBronze: std({ color: 0x5a4632, roughness: 0.4, metalness: 0.5 }),
    soil: std({ color: 0x4a3a2a, roughness: 1 }),
    decoGold: std({ map: decoPanel('#2a2420', '#d7ad55'), roughness: 0.35, metalness: 0.6 }),
    paving: std({ map: courses('#cfc6b4', 'rgba(120,108,90,.55)', 5), roughness: 0.9 }),
  };
}

/** Collects parts by material, in metres of the building's frame. */
class Parts {
  readonly byMat = new Map<Mat, BufferGeometry[]>();
  /** Draws mirrored front to back about y = mirror / 2 (the back face), or null. */
  mirror: number | null = null;
  Y(y: number): number { return this.mirror === null ? y : this.mirror - y; }

  /** Adds a ready geometry (a cone, a spire) in metres of three's frame. */
  pushRaw(mat: Mat, g: BufferGeometry): void { this.push(mat, g); }

  private push(mat: Mat, g: BufferGeometry): void {
    const geo = g.index ? g.toNonIndexed() : g;
    const list = this.byMat.get(mat);
    if (list) list.push(geo);
    else this.byMat.set(mat, [geo]);
  }

  /** A box from (x0, y0, z0) to (x1, y1, z1), UVs in metres so textures tile at their real size. */
  box(mat: Mat, x0: number, x1: number, y0: number, y1: number, z0: number, z1: number): void {
    const w = Math.abs(x1 - x0), d = Math.abs(y1 - y0), h = Math.abs(z1 - z0);
    if (w < 1e-3 || d < 1e-3 || h < 1e-3) return;
    // A facade block's top is a roof, not more facade: a membrane cap over it.
    if (mat.includes('|') && !mat.startsWith('decal|')) {
      this.box('roofing', Math.min(x0, x1), Math.max(x0, x1), Math.min(y0, y1), Math.max(y0, y1), Math.max(z0, z1), Math.max(z0, z1) + 0.05);
    }
    const g = new BoxGeometry(w, h, d);
    g.translate((x0 + x1) / 2, (z0 + z1) / 2, -this.Y((y0 + y1) / 2));
    const pos = g.attributes['position']!, nor = g.attributes['normal']!, uv = g.attributes['uv']!;
    for (let i = 0; i < pos.count; i++) {
      const nx = Math.abs(nor.getX(i)), ny = Math.abs(nor.getY(i));
      const px = pos.getX(i), py = pos.getY(i), pz = pos.getZ(i);
      if (ny > 0.5) uv.setXY(i, px, pz);
      else if (nx > 0.5) uv.setXY(i, pz, py);
      else uv.setXY(i, px, py);
    }
    this.push(mat, g);
  }

  /** A railing panel along x (or y) at height z: an alpha-cut screen of bars. */
  rail(x0: number, x1: number, y0: number, y1: number, z: number, h = 1.05): void {
    const g = new BoxGeometry(Math.max(0.02, Math.abs(x1 - x0)), h, Math.max(0.02, Math.abs(y1 - y0)));
    g.translate((x0 + x1) / 2, z + h / 2, -this.Y((y0 + y1) / 2));
    const pos = g.attributes['position']!, uv = g.attributes['uv']!, nor = g.attributes['normal']!;
    for (let i = 0; i < pos.count; i++) {
      const along = Math.abs(nor.getX(i)) > 0.5 ? -pos.getZ(i) : pos.getX(i);
      uv.setXY(i, along, pos.getY(i) - z);
    }
    this.push('railing', g);
  }

  /** A pot with a bushy plant. */
  plant(x: number, y: number, z: number, size = 1): void {
    const s = size;
    this.box('pot', x - 0.28 * s, x + 0.28 * s, y - 0.28 * s, y + 0.28 * s, z, z + 0.55 * s);
    const leaf = new IcosahedronGeometry(0.42 * s, 1);
    leaf.scale(1, 1.15, 1);
    leaf.translate(x, z + 0.55 * s + 0.38 * s, -this.Y(y));
    this.push('leaf', leaf);
    const top = new IcosahedronGeometry(0.28 * s, 0);
    top.translate(x + 0.12 * s, z + 0.55 * s + 0.78 * s, -this.Y(y) + 0.05);
    this.push('leafDark', top);
  }

  /** A clipped conical shrub (a cypress in a pot), as either side of the door. */
  cone(x: number, y: number, z: number): void {
    this.box('pot', x - 0.3, x + 0.3, y - 0.3, y + 0.3, z, z + 0.6);
    const c = new ConeGeometry(0.38, 1.6, 7);
    c.translate(x, z + 0.6 + 0.8, -this.Y(y));
    this.push('leafDark', c);
  }

  /** A shrub on the ground. */
  bush(x: number, y: number, z: number, r: number, dark = false): void {
    const g = new IcosahedronGeometry(r, 1);
    g.scale(1.2, 0.85, 1.2);
    g.translate(x, z + r * 0.7, -this.Y(y));
    this.push(dark ? 'leafDark' : 'leaf', g);
  }

  /** An upright elliptic prism (a rounded tower, a slab edge round it), UVs in metres round and up. */
  ellipse(mat: Mat, cx: number, cy: number, rx: number, ry: number, z0: number, z1: number, seg = 24): void {
    const g = new CylinderGeometry(1, 1, z1 - z0, seg, 1, false);
    g.scale(rx, 1, ry);
    g.translate(cx, (z0 + z1) / 2, -this.Y(cy));
    const pos = g.attributes['position']!, uv = g.attributes['uv']!;
    const r = (rx + ry) / 2;
    for (let i = 0; i < pos.count; i++) {
      const a = Math.atan2(-(pos.getZ(i) + this.Y(cy)), pos.getX(i) - cx);
      uv.setXY(i, (a + Math.PI) * r, pos.getY(i));
    }
    this.push(mat, g);
  }

  /** A regular prism of `seg` sides (3 a triangle, 4 a square, 6, 8...), turned `rot` radians, UVs in metres. */
  prism(mat: Mat, cx: number, cy: number, r: number, z0: number, z1: number, seg: number, rot = 0): void {
    const g = new CylinderGeometry(r, r, z1 - z0, seg, 1, false, rot, Math.PI * 2).toNonIndexed();
    g.translate(cx, (z0 + z1) / 2, -this.Y(cy));
    const pos = g.attributes['position']!, uv = g.attributes['uv']!;
    // Flat faces: u runs along each face in metres, so a facade tiles on it as on a wall.
    const side = 2 * r * Math.sin(Math.PI / seg);
    for (let i = 0; i < pos.count; i++) {
      const a = Math.atan2(pos.getX(i) - cx, pos.getZ(i) + this.Y(cy)) - rot;
      const f = (((a / (Math.PI * 2)) * seg) % seg + seg) % seg;
      uv.setXY(i, f * side, pos.getY(i));
    }
    g.computeVertexNormals();
    this.push(mat, g);
  }

  /**
   * A triangular prism: a gable roof (`along` 'y': the ridge runs back from
   * the front, the gable end faces the street) or a pediment ('x').
   */
  gable(mat: Mat, x0: number, x1: number, y0: number, y1: number, z: number, h: number, along: 'x' | 'y' = 'y'): void {
    const Yf = (y: number): number => -this.Y(y);
    const P = along === 'y'
      ? [[x0, z, y0], [x1, z, y0], [(x0 + x1) / 2, z + h, y0], [x0, z, y1], [x1, z, y1], [(x0 + x1) / 2, z + h, y1]]
      : [[x0, z, y0], [x0, z, y1], [x0, z + h, (y0 + y1) / 2], [x1, z, y0], [x1, z, y1], [x1, z + h, (y0 + y1) / 2]];
    const v = P.map(([a, b, c]) => [a!, b!, Yf(c!)]);
    const tri = [[0, 1, 2], [5, 4, 3], [0, 2, 5], [0, 5, 3], [1, 4, 5], [1, 5, 2], [0, 3, 4], [0, 4, 1]];
    const pos: number[] = [], uv: number[] = [];
    for (const t of tri) for (const i of t) { const p = v[i]!; pos.push(p[0]!, p[1]!, p[2]!); uv.push(p[0]! + p[2]!, p[1]!); }
    const g = new Geometry();
    g.setAttribute('position', new BufferAttribute(new Float32Array(pos), 3));
    g.setAttribute('uv', new BufferAttribute(new Float32Array(uv), 2));
    g.computeVertexNormals();
    // Faces wound either way: draw both sides rather than trust the order.
    const back = g.clone();
    const idx = back.attributes['position']!;
    for (let i = 0; i < idx.count; i += 3) {
      for (const a of ['position', 'uv'] as const) {
        const at = back.attributes[a]!;
        const n = at.itemSize;
        for (let c = 0; c < n; c++) { const t = at.array[(i + 1) * n + c]!; (at.array as Float32Array)[(i + 1) * n + c] = at.array[(i + 2) * n + c]!; (at.array as Float32Array)[(i + 2) * n + c] = t; }
      }
    }
    back.computeVertexNormals();
    this.push(mat, g);
    this.push(mat, back);
  }

  /** A hipped roof (a frustum on a rectangle, `top` its ridge fraction; 0 a pyramid). */
  hip(mat: Mat, x0: number, x1: number, y0: number, y1: number, z: number, h: number, top = 0.35): void {
    const g = new CylinderGeometry(Math.SQRT2 * top, Math.SQRT2, h, 4, 1, false, Math.PI / 4).toNonIndexed();
    g.scale((x1 - x0) / 2, 1, (y1 - y0) / 2);
    g.translate((x0 + x1) / 2, z + h / 2, -this.Y((y0 + y1) / 2));
    g.computeVertexNormals();
    this.push(mat, g);
  }

  /** A dome (half a sphere, `squash` its height over its radius). */
  dome(mat: Mat, cx: number, cy: number, r: number, z: number, squash = 1): void {
    const g = new SphereGeometry(r, 16, 8, 0, Math.PI * 2, 0, Math.PI / 2);
    g.scale(1, squash, 1);
    g.translate(cx, z, -this.Y(cy));
    this.push(mat, g);
  }

  /** A flight of `n` steps rising back from the front edge `y0` (towards +y). */
  steps(mat: Mat, x0: number, x1: number, y0: number, n: number, tread = 0.35, rise = 0.17, z = 0): void {
    for (let k = 0; k < n; k++) this.box(mat, x0, x1, y0 + k * tread, y0 + n * tread, z + k * rise, z + (k + 1) * rise);
  }

  /** A painted panel - a sign, a clock, a crest - on a face: 'front' looks -y, 'left' -x, 'right' +x. */
  decal(key: string, paint: (g: CanvasRenderingContext2D, w: number, h: number) => void, cx: number, cy: number, w: number, h: number, z0: number,
    face: 'front' | 'left' | 'right' = 'front', glow = false): void {
    const name = `decal|${key}`;
    if (!facades.has(name)) {
      const ratio = w / h;
      const cw = ratio >= 1 ? 512 : Math.round(512 * ratio), ch = ratio >= 1 ? Math.round(512 / ratio) : 512;
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(8, cw); canvas.height = Math.max(8, ch);
      paint(canvas.getContext('2d')!, canvas.width, canvas.height);
      const t = new CanvasTexture(canvas);
      t.colorSpace = SRGBColorSpace;
      t.anisotropy = 8;
      facades.set(name, new MeshStandardMaterial({ map: t, transparent: true, alphaTest: 0.05, roughness: 0.6,
        ...(glow ? { emissive: 0xffffff, emissiveMap: t, emissiveIntensity: 0.35 } : {}) }));
    }
    const g = new PlaneGeometry(w, h);
    if (face === 'left') g.rotateY(-Math.PI / 2);
    if (face === 'right') g.rotateY(Math.PI / 2);
    g.translate(cx, z0 + h / 2, -this.Y(cy));
    this.push(name, g);
  }

  /** A street lamp: a post and a glowing lantern. */
  lamp(x: number, y: number, z = 0, h = 3.2): void {
    this.cylinder('frame', x, y, z, z + h, 0.07);
    this.box('frame', x - 0.2, x + 0.2, y - 0.2, y + 0.2, z + h, z + h + 0.08);
    this.box('sconce', x - 0.15, x + 0.15, y - 0.15, y + 0.15, z + h + 0.08, z + h + 0.55);
    this.box('frame', x - 0.2, x + 0.2, y - 0.2, y + 0.2, z + h + 0.55, z + h + 0.65);
  }

  /** A flagpole with its flag (painted by `paint`). */
  flag(key: string, paint: (g: CanvasRenderingContext2D, w: number, h: number) => void, x: number, y: number, h = 8): void {
    this.cylinder('lightGrid', x, y, 0, h, 0.06);
    this.decal(key, paint, x + 0.85, y, 1.6, 1.1, h - 1.3);
  }

  /** A tree: a trunk and a full crown. */
  tree(x: number, y: number, r = 1.6, h = 5): void {
    this.cylinder('woodDark', x, y, 0, h * 0.45, 0.16);
    this.bush(x, y, h * 0.35, r, false);
    this.bush(x + r * 0.3, y - r * 0.2, h * 0.55, r * 0.7, true);
  }

  /** A cypress standing in the ground. */
  cypress(x: number, y: number, h = 5, z = 0): void {
    const c = new ConeGeometry(h * 0.16, h, 7);
    c.translate(x, z + h / 2, -this.Y(y));
    this.push('leafDark', c);
  }

  cylinder(mat: Mat, x: number, y: number, z0: number, z1: number, r: number): void {
    const g = new CylinderGeometry(r, r, z1 - z0, 10);
    g.translate(x, (z0 + z1) / 2, -this.Y(y));
    this.push(mat, g);
  }

  /** A window or glazed door on a face looking -y, at depth y: a dark frame round warm glass. */
  windowFront(x0: number, x1: number, y: number, z0: number, z1: number, mullions = 1): void {
    const t = 0.07;
    this.box('glass', x0 + t, x1 - t, y - 0.02, y + 0.02, z0 + t, z1 - t);
    this.box('frame', x0, x1, y - 0.06, y, z0, z0 + t);
    this.box('frame', x0, x1, y - 0.06, y, z1 - t, z1);
    this.box('frame', x0, x0 + t, y - 0.06, y, z0, z1);
    this.box('frame', x1 - t, x1, y - 0.06, y, z0, z1);
    for (let k = 1; k <= mullions; k++) {
      const x = x0 + ((x1 - x0) * k) / (mullions + 1);
      this.box('frame', x - 0.03, x + 0.03, y - 0.06, y, z0, z1);
    }
  }

  /** A window on a side face (looking -x or +x) at x. */
  windowSide(x: number, out: 1 | -1, y0: number, y1: number, z0: number, z1: number): void {
    const t = 0.07, o = out * 0.06;
    this.box('glass', x - 0.02, x + 0.02, y0 + t, y1 - t, z0 + t, z1 - t);
    this.box('frame', x, x + o, y0, y1, z0, z0 + t);
    this.box('frame', x, x + o, y0, y1, z1 - t, z1);
    this.box('frame', x, x + o, y0, y0 + t, z0, z1);
    this.box('frame', x, x + o, y1 - t, y1, z0, z1);
    this.box('frame', x, x + o, (y0 + y1) / 2 - 0.03, (y0 + y1) / 2 + 0.03, z0, z1);
  }
}

/** Image 1: balconies on both wings, a timber column with the stairs, a stone base, a roof terrace. */
function balconyMid(p: Parts, W: number, D: number, g: number, s: number, upper: number): void {
  const FB = 1.6; // balcony depth
  const cw = Math.max(3.6, Math.min(5, W * 0.19));
  const cx = W / 2, sx0 = cx - cw / 2, sx1 = cx + cw / 2;
  const top = g + upper * s;
  const wings: [number, number][] = [[0, sx0], [sx1, W]];

  // Ground floor: the stone base, set back under the first balconies.
  p.box('stone', 0, W, 0.6, D - 0.6, 0, g);
  p.box('trim', -0.05, W + 0.05, 0.5, D - 0.5, g - 0.3, g + 0.02);
  // The front, then the back the same (balconies on both long faces).
  for (const mirror of [null, D]) {
  p.mirror = mirror;
  for (const [a, b] of wings) {
    const span = b - a;
    const n = Math.max(1, Math.round(span / 3.2));
    for (let k = 0; k < n; k++) {
      const x0 = a + 0.6 + (k * (span - 1.2)) / n, x1 = a + 0.6 + ((k + 1) * (span - 1.2)) / n - 0.5;
      p.windowFront(x0, x1, 0.6, 0.5, g - 0.6, 1);
    }
    // A long concrete planter of shrubs in front of the windows.
    p.box('plant', a + 0.3, b - 0.3, -1.4, -0.3, 0, 0.6);
    const shrubs = Math.max(2, Math.round((b - a) / 1.3));
    for (let k = 0; k < shrubs; k++) p.bush(a + 0.8 + (k * (b - a - 1.6)) / Math.max(1, shrubs - 1), -0.85, 0.6, 0.45, k % 2 === 1);
  }
  }
  p.mirror = null;
  // The entrance: a timber portal, glass double doors, a steel canopy, cypresses in pots, wall lights.
  p.box('wood', sx0, sx1, 0.2, D - 0.2, 0, g);
  p.windowFront(cx - 1.3, cx + 1.3, 0.2, 0, Math.min(2.8, g - 0.5), 1);
  p.box('metal', cx - 2.2, cx + 2.2, -1.3, 0.2, g - 0.55, g - 0.4);
  p.cone(sx0 - 0.5, -0.6, 0);
  p.cone(sx1 + 0.5, -0.6, 0);
  for (const x of [sx0 + 0.35, sx1 - 0.35]) p.box('sconce', x - 0.08, x + 0.08, 0.1, 0.2, 2.1, 2.45);
  p.box('slab', cx - 2.4, cx + 2.4, -2.2, 0.2, -0.02, 0.12); // the step

  // The floors above.
  for (let k = 0; k < upper; k++) {
    const z = g + k * s;
    for (const [a, b] of wings) p.box('render', a, b, FB, D - FB, z, z + s);
    for (const mirror of [null, D]) {
    p.mirror = mirror;
    for (const [a, b] of wings) {
      const outer = a === 0 ? a : b; // the wing's outer end
      // The slab of the balcony.
      p.box('slab', a, b, 0, FB, z, z + 0.24);
      // Sliding doors, slat panels either side.
      const inner0 = a + (a === 0 ? 0.25 : 0.9), inner1 = b - (a === 0 ? 0.9 : 0.25);
      p.box('slats', a === 0 ? sx0 - 0.85 : sx1 + 0.15, a === 0 ? sx0 - 0.15 : sx1 + 0.85, FB - 0.08, FB, z + 0.24, z + s);
      const doors = Math.max(1, Math.round((inner1 - inner0) / 2.6));
      for (let d = 0; d < doors; d++) {
        const x0 = inner0 + (d * (inner1 - inner0)) / doors + 0.1, x1 = inner0 + ((d + 1) * (inner1 - inner0)) / doors - 0.1;
        p.windowFront(x0, x1, FB, z + 0.3, z + s - 0.35, 1);
      }
      // The railing round the balcony's open sides.
      p.rail(a + 0.02, b - 0.02, 0.02, 0.06, z + 0.24);
      p.rail(outer - 0.02, outer + 0.02, 0.06, FB, z + 0.24);
      // Plants on the balcony: one at each end.
      p.plant(a + 0.5, 0.45, z + 0.24, 0.9);
      p.plant(b - 0.5, 0.45, z + 0.24, 0.9);
      // A wall light by the doors.
      const lx = a === 0 ? inner1 - 0.25 : inner0 + 0.25;
      p.box('sconce', lx - 0.06, lx + 0.06, FB - 0.12, FB, z + 1.9, z + 2.2);
    }
    p.windowFront(cx - cw * 0.3, cx + cw * 0.3, 0.2, z + 0.7, z + s - 0.5, 1);
    }
    p.mirror = null;
    // The side faces: narrow windows and lights.
    for (const [x, out] of [[0, -1], [W, 1]] as const) {
      for (const y of [D * 0.42, D * 0.68]) p.windowSide(x, out, y - 0.45, y + 0.45, z + 0.7, z + s - 0.5);
    }
    // The timber column: a window per floor, beige bands either side.
    p.box('wood', sx0, sx1, 0.2, D - 0.2, z, z + s);
  }
  // Beige piers either side of the column, full height.
  p.box('trim', sx0 - 0.15, sx0, 0, D, g, top);
  p.box('trim', sx1, sx1 + 0.15, 0, D, g, top);
  // The roof: the top slab over the balconies, a parapet, the terrace.
  for (const [a, b] of wings) { p.box('slab', a, b, 0, FB, top, top + 0.3); p.box('slab', a, b, D - FB, D, top, top + 0.3); }
  p.box('plant', 0, W, FB, D - FB, top, top + 0.3);
  // The column's top only where the deck does not cover it (two coplanar tops flicker).
  p.box('wood', sx0, sx1, 0.2, FB, top, top + 0.3);
  p.box('wood', sx0, sx1, D - FB, D - 0.2, top, top + 0.3);
  // The parapet's coping: a rim round the roof, not a lid over it.
  p.box('trim', -0.1, W + 0.1, -0.1, 0.25, top + 0.3, top + 0.45);
  p.box('trim', -0.1, W + 0.1, D - 0.25, D + 0.1, top + 0.3, top + 0.45);
  p.box('trim', -0.1, 0.25, 0.25, D - 0.25, top + 0.3, top + 0.45);
  p.box('trim', W - 0.25, W + 0.1, 0.25, D - 0.25, top + 0.3, top + 0.45);
  p.rail(0.05, W - 0.05, 0.05, 0.09, top + 0.45);
  p.rail(W - 0.09, W - 0.05, 0.05, D - 0.05, top + 0.45);
  p.rail(0.05, 0.09, 0.05, D - 0.05, top + 0.45);
  p.rail(0.05, W - 0.05, D - 0.09, D - 0.05, top + 0.45);
  for (const x of [1.2, W * 0.3, W * 0.7, W - 1.2]) p.plant(x, 0.9, top + 0.45, 1.1);
  // The stair and lift overrun, its door; air conditioners; a vent stack.
  const py0 = D * 0.35, py1 = Math.min(D - 1, py0 + 4.5);
  p.box('trim', cx - 3, cx + 3, py0, py1, top + 0.3, top + 3.4);
  p.box('slab', cx - 3.15, cx + 3.15, py0 - 0.15, py1 + 0.15, top + 3.4, top + 3.6);
  p.windowFront(cx + 0.6, cx + 1.6, py0, top + 0.45, top + 2.6, 0);
  p.box('frame', cx + 0.6, cx + 1.6, py0 - 0.02, py0 + 0.02, top + 0.45, top + 2.6);
  p.cylinder('metal', cx - 1.8, py0 + 1.2, top + 3.6, top + 4.6, 0.18);
  for (const [x, y] of [[W * 0.78, D * 0.55], [W * 0.84, D * 0.55], [W * 0.2, D * 0.62]] as const) {
    p.box('metal', x - 0.55, x + 0.55, y - 0.4, y + 0.4, top + 0.3, top + 1.2);
    p.box('frame', x - 0.4, x + 0.4, y - 0.42, y - 0.4, top + 0.45, top + 1.05);
  }
}

/** How one of the towers of the reference sheets is made. */
interface TowerLook {
  /** The shaft's face: a facade picture, its bay width. */
  readonly face: FacadeKind;
  readonly bay: number;
  readonly podium: Mat;
  readonly round?: boolean;
  /** Projecting piers, every `every` metres, and their material. */
  readonly piers?: { readonly mat: Mat; readonly every: number; readonly w: number };
  /** A slab edge at every floor (`deep` > 0.5: a balcony band with its railing). */
  readonly bands?: { readonly mat: Mat; readonly deep: number; readonly rail?: 'glassRail' | 'railing'; readonly sides?: boolean };
  /** A strip up the middle of the front, standing forward, one storey higher. */
  readonly strip?: { readonly mat: Mat; readonly frac: number };
  /** Balconies in some columns only (classic towers). */
  readonly loggias?: { readonly every: number };
  /** Storeys of the set-back crown; tiers of an art deco top. */
  readonly crown: number;
  readonly tiers?: number;
  /** A cornice band at the crown. */
  readonly cornice?: Mat;
}

const LOOKS: Record<string, TowerLook> = {
  glassOffice: { face: 'curtainBlue', bay: 1.5, podium: 'stoneLight', piers: { mat: 'stoneLight', every: 6, w: 0.9 },
    strip: { mat: 'curtainStrip', frac: 0.24 }, crown: 2, cornice: 'stoneLight' },
  glassBalcony: { face: 'curtainBlue', bay: 1.5, podium: 'stoneLight', bands: { mat: 'white', deep: 1.4, rail: 'glassRail', sides: true },
    strip: { mat: 'stoneLight', frac: 0.14 }, crown: 2 },
  beigeClassic: { face: 'punchedBeige', bay: 1.8, podium: 'stoneLight', loggias: { every: 3 }, crown: 3, tiers: 2, cornice: 'trim' },
  darkGlass: { face: 'curtainDark', bay: 1.5, podium: 'darkPanel', crown: 4, tiers: 2 },
  whiteBalcony: { face: 'curtainBlue', bay: 1.5, podium: 'stoneLight', bands: { mat: 'white', deep: 1.6, rail: 'glassRail', sides: true }, crown: 1 },
  brickFrame: { face: 'curtainBlue', bay: 1.5, podium: 'stone', piers: { mat: 'brickPier', every: 3, w: 0.8 },
    bands: { mat: 'brickPier', deep: 0.35 }, crown: 1, cornice: 'brickPier' },
  roundGlass: { face: 'curtainBlue', bay: 1.5, podium: 'stoneLight', round: true, bands: { mat: 'white', deep: 0.6 }, crown: 1 },
  darkGrid: { face: 'gridDark', bay: 2.4, podium: 'darkPanel', piers: { mat: 'lightGrid', every: 4.8, w: 0.35 }, crown: 2 },
  artDeco: { face: 'punchedBeige', bay: 1.5, podium: 'stoneLight', piers: { mat: 'beige', every: 1.5, w: 0.35 }, crown: 3, tiers: 3, cornice: 'beige' },
};

/** A tower of the reference sheet: podium, shaft, crown and roof, in its own look. */
function towerOf(look: TowerLook) {
  return (p: Parts, W: number, D: number, g: number, s: number, upper: number): void => {
    const zP = g + s; // a two-storey podium
    const top = g + upper * s;
    const crownZ = top - look.crown * s;
    const I = 2;
    const sx0 = I, sx1 = W - I, sy0 = I, sy1 = D - I;
    const sw = sx1 - sx0, sd = sy1 - sy0;
    const face = facade(look.face, look.bay, s, zP);

    // The podium: its material, tall glazing between columns on every face, the entrance.
    p.box(look.podium, 0, W, 0, D, 0, zP);
    const cols = Math.max(2, Math.round(W / 4));
    for (const mirror of [null, D]) {
      p.mirror = mirror;
      for (let k = 0; k < cols; k++) {
        const x0 = (k * W) / cols + 0.35, x1 = ((k + 1) * W) / cols - 0.35;
        p.box('podiumGlass', x0, x1, -0.04, 0.02, 0.15, zP - 0.7);
        p.box('frame', x0, x1, -0.07, -0.02, g - 0.1, g + 0.05);
      }
      for (let k = 0; k <= cols; k++) { const x = (k * W) / cols; p.box(look.podium, x - 0.35, x + 0.35, -0.3, 0.2, 0, zP - 0.45); }
    }
    p.mirror = null;
    for (const [x, out] of [[0, -1], [W, 1]] as const) {
      const n = Math.max(2, Math.round(D / 4));
      for (let k = 0; k < n; k++) {
        const y0 = (k * D) / n + 0.35, y1 = ((k + 1) * D) / n - 0.35;
        p.box('podiumGlass', x + (out < 0 ? -0.02 : -0.02), x + 0.04 * out + (out < 0 ? 0 : 0.02), y0, y1, 0.15, zP - 0.7);
      }
    }
    p.box('trim', -0.2, W + 0.2, -0.2, D + 0.2, zP - 0.45, zP + 0.06); // stands above the podium's roof: no two tops at one height
    p.box('metal', W / 2 - 3, W / 2 + 3, -2, 0.1, g - 0.4, g - 0.2);
    p.windowFront(W / 2 - 1.5, W / 2 + 1.5, -0.08, 0, 3, 1);
    for (const x of [2, W * 0.3, W * 0.7, W - 2]) p.cone(x, -1.2, 0);
    p.box('plant', 0.5, W / 2 - 4, -1.9, -0.6, 0, 0.5);
    p.box('plant', W / 2 + 4, W - 0.5, -1.9, -0.6, 0, 0.5);
    for (let k = 0; k < 8; k++) p.bush(1 + (k * (W - 2)) / 7, -1.25, 0.5, 0.4, k % 2 === 0);

    // The shaft, then the crown set back.
    const tiers = look.tiers ?? 1;
    const shaft = (x0: number, x1: number, y0: number, y1: number, z0: number, z1: number): void => {
      if (look.round) {
        p.ellipse(face, (x0 + x1) / 2, (y0 + y1) / 2, (x1 - x0) / 2, (y1 - y0) / 2, z0, z1);
        return;
      }
      p.box(face, x0, x1, y0, y1, z0, z1);
      if (look.piers) {
        const { mat, every, w } = look.piers;
        const n = Math.max(1, Math.round((x1 - x0) / every));
        for (let k = 0; k <= n; k++) {
          const x = x0 + ((x1 - x0) * k) / n;
          p.box(mat, x - w / 2, x + w / 2, y0 - 0.3, y0 + 0.2, z0, z1 + 0.25);
          p.box(mat, x - w / 2, x + w / 2, y1 - 0.2, y1 + 0.3, z0, z1 + 0.25);
        }
        const m2 = Math.max(1, Math.round((y1 - y0) / every));
        for (let k = 0; k <= m2; k++) {
          const y = y0 + ((y1 - y0) * k) / m2;
          p.box(mat, x0 - 0.3, x0 + 0.2, y - w / 2, y + w / 2, z0, z1 + 0.2);
          p.box(mat, x1 - 0.2, x1 + 0.3, y - w / 2, y + w / 2, z0, z1 + 0.2);
        }
      }
    };
    shaft(sx0, sx1, sy0, sy1, zP, crownZ);
    for (let t = 0; t < tiers; t++) {
      const c = 1.5 + t * 1.8;
      const z0 = crownZ + (t * (top - crownZ)) / tiers, z1 = crownZ + ((t + 1) * (top - crownZ)) / tiers;
      if (sw - 2 * c > 4 && sd - 2 * c > 4) shaft(sx0 + c, sx1 - c, sy0 + c, sy1 - c, z0, z1);
      if (look.cornice && !look.round) p.box(look.cornice, sx0 + c - 0.4 - 1.5, sx1 - c + 0.4 + 1.5, sy0 + c - 0.4 - 1.5, sy1 - c + 0.4 + 1.5, z0 - 0.4, z0 + 0.05);
    }
    const cTop = 1.5 + (tiers - 1) * 1.8;

    // Slab edges and balcony bands at every floor of the shaft.
    if (look.bands) {
      const { mat, deep, rail, sides } = look.bands;
      for (let k = 2; k < upper - look.crown + 1; k++) {
        const z = g + (k - 1) * s;
        if (look.round) {
          p.ellipse(mat, W / 2, D / 2, sw / 2 + deep, sd / 2 + deep, z, z + 0.25);
          continue;
        }
        p.box(mat, sx0 - (sides ? deep : 0), sx1 + (sides ? deep : 0), sy0 - deep, sy0, z, z + 0.25);
        p.box(mat, sx0 - (sides ? deep : 0), sx1 + (sides ? deep : 0), sy1, sy1 + deep, z, z + 0.25);
        if (sides) { p.box(mat, sx0 - deep, sx0, sy0, sy1, z, z + 0.25); p.box(mat, sx1, sx1 + deep, sy0, sy1, z, z + 0.25); }
        if (rail && deep > 0.5) {
          const railBox = (x0: number, x1: number, y0: number, y1: number): void => {
            if (rail === 'glassRail') p.box('glassRail', x0, x1, y0, y1, z + 0.25, z + 1.3);
            else p.rail(x0, x1, y0, y1, z + 0.25);
          };
          const ex = sides ? deep : 0;
          railBox(sx0 - ex, sx1 + ex, sy0 - deep, sy0 - deep + 0.04);
          railBox(sx0 - ex, sx1 + ex, sy1 + deep - 0.04, sy1 + deep);
          if (sides) { railBox(sx0 - deep, sx0 - deep + 0.04, sy0 - deep, sy1 + deep); railBox(sx1 + deep - 0.04, sx1 + deep, sy0 - deep, sy1 + deep); }
        }
      }
    }
    // Loggias: balconies in every third column, black railings.
    if (look.loggias) {
      const n = Math.max(3, Math.round(sw / look.bay));
      for (let k = 2; k < upper - look.crown + 1; k++) {
        const z = g + (k - 1) * s;
        for (let c = 1; c < n - 1; c += look.loggias.every) {
          const x0 = sx0 + (c * sw) / n, x1 = sx0 + ((c + 1) * sw) / n;
          for (const mirror of [null, D]) {
            p.mirror = mirror;
            p.box('trim', x0 - 0.1, x1 + 0.1, sy0 - 1.1, sy0, z, z + 0.2);
            p.rail(x0 - 0.1, x1 + 0.1, sy0 - 1.1, sy0 - 1.06, z + 0.2);
          }
          p.mirror = null;
        }
      }
    }
    // The strip up the front: standing forward, one storey higher.
    if (look.strip && !look.round) {
      const w = sw * look.strip.frac;
      const stripMat = look.strip.mat === 'curtainStrip' ? facade('curtainBlue', 1.2, s, zP) : look.strip.mat;
      p.box(stripMat, W / 2 - w / 2, W / 2 + w / 2, sy0 - 0.8, sy0 + 0.5, zP, top + s);
      p.box('trim', W / 2 - w / 2 - 0.2, W / 2 + w / 2 + 0.2, sy0 - 1, sy0 + 0.7, top + s, top + s + 0.3);
    }
    // The roof: parapet, railing, plant rooms, cooling towers, a water tank.
    const r0 = look.round ? null : { x0: sx0 + cTop, x1: sx1 - cTop, y0: sy0 + cTop, y1: sy1 - cTop };
    if (r0) {
      p.box('plant', r0.x0, r0.x1, r0.y0, r0.y1, top, top + 0.2);
      p.box('trim', r0.x0 - 0.1, r0.x1 + 0.1, r0.y0 - 0.1, r0.y0 + 0.2, top, top + 0.9);
      p.box('trim', r0.x0 - 0.1, r0.x1 + 0.1, r0.y1 - 0.2, r0.y1 + 0.1, top, top + 0.9);
      p.box('trim', r0.x0 - 0.1, r0.x0 + 0.2, r0.y0, r0.y1, top, top + 0.9);
      p.box('trim', r0.x1 - 0.2, r0.x1 + 0.1, r0.y0, r0.y1, top, top + 0.9);
      const cx = (r0.x0 + r0.x1) / 2, cy = (r0.y0 + r0.y1) / 2;
      p.box('lightGrid', cx - 3, cx + 3, cy - 2, cy + 2, top, top + 3.2);
      p.box('metal', cx - 3.2, cx + 3.2, cy - 2.2, cy + 2.2, top + 3.2, top + 3.4);
      for (const [x, y] of [[r0.x0 + 1.5, r0.y0 + 1.5], [r0.x1 - 1.5, r0.y0 + 1.5], [r0.x1 - 1.5, r0.y1 - 1.5]] as const) {
        p.box('metal', x - 0.8, x + 0.8, y - 0.6, y + 0.6, top + 0.2, top + 1.4);
      }
      p.cylinder('metal', r0.x0 + 2, r0.y1 - 2, top + 0.2, top + 2.6, 1);
    } else {
      p.ellipse('white', W / 2, D / 2, sw / 2 - cTop + 0.3, sd / 2 - cTop + 0.3, top, top + 0.6);
      p.ellipse('lightGrid', W / 2, D / 2, sw / 4, sd / 4, top + 0.6, top + 3.5, 16);
      p.ellipse('white', W / 2, D / 2, sw / 4 + 0.3, sd / 4 + 0.3, top + 3.5, top + 3.8, 16);
    }
  };
}

// ------------------------------------------------------------ the second set

type Design = (p: Parts, W: number, D: number, g: number, s: number, upper: number) => void;

/**
 * A flat roof's parapet in `mat` from z0 to z1 round the rectangle, and the
 * membrane deck inside it at `deck` (default just above z0): a rim, never a
 * lid of facade stone over the whole roof.
 */
function roofRing(p: Parts, mat: Mat, x0: number, x1: number, y0: number, y1: number, z0: number, z1: number, deck = z0): void {
  const r = Math.min(0.45, (x1 - x0) / 6, (y1 - y0) / 6);
  p.box(mat, x0, x1, y0, y0 + r, z0, z1);
  p.box(mat, x0, x1, y1 - r, y1, z0, z1);
  p.box(mat, x0, x0 + r, y0 + r, y1 - r, z0, z1);
  p.box(mat, x1 - r, x1, y0 + r, y1 - r, z0, z1);
  p.box('roofing', x0 + r, x1 - r, y0 + r, y1 - r, deck, Math.min(deck + 0.05, z1 - 0.02));
}

/** An open arch in a stone face: a belfry's or a loggia's, dark inside. */
const archOpening = (g: CanvasRenderingContext2D, w: number, h: number): void => {
  g.clearRect(0, 0, w, h);
  const n = w > h ? 2 : 1;
  for (let k = 0; k < n; k++) {
    const aw = w / n - 14, x = 7 + (k * w) / n;
    g.fillStyle = '#c4bdaf'; g.beginPath(); g.arc(x + aw / 2, aw / 2 + 4, aw / 2 + 4, Math.PI, 0); g.lineTo(x + aw + 4, h); g.lineTo(x - 4, h); g.fill();
    g.fillStyle = '#1b1d20'; g.beginPath(); g.arc(x + aw / 2, aw / 2 + 6, aw / 2, Math.PI, 0); g.lineTo(x + aw, h - 4); g.lineTo(x, h - 4); g.fill();
    g.fillStyle = '#6d6a64'; g.fillRect(x, h - 18, aw, 6);
    for (let b = x + 6; b < x + aw; b += 10) g.fillRect(b, h - 34, 3, 16);
  }
};

/** A two-storey podium in `mat`, glazed all round, its canopy, planters and trees; returns its top. */
function podium2(p: Parts, W: number, D: number, g: number, s: number, mat: Mat, canopy: Mat = 'metal'): number {
  const zP = g + s;
  p.box(mat, 0, W, 0, D, 0, zP);
  const cols = Math.max(2, Math.round(W / 4.5));
  for (const mirror of [null, D]) {
    p.mirror = mirror;
    for (let k = 0; k < cols; k++) p.box('podiumGlass', (k * W) / cols + 0.4, ((k + 1) * W) / cols - 0.4, -0.04, 0.02, 0.2, zP - 0.8);
  }
  p.mirror = null;
  roofRing(p, 'trim', -0.2, W + 0.2, -0.2, D + 0.2, zP - 0.5, zP + 0.06, zP);
  p.box(canopy, W / 2 - 3.5, W / 2 + 3.5, -2.2, 0.1, g - 0.45, g - 0.25);
  p.windowFront(W / 2 - 1.6, W / 2 + 1.6, -0.08, 0, 3, 1);
  for (const x of [1.5, W - 1.5]) p.cone(x, -1.2, 0);
  for (let k = 0; k < 6; k++) p.bush(3 + (k * (W - 6)) / 5, -1.1, 0, 0.45, k % 2 === 1);
  return zP + 0.06;
}

/** Plant on a flat roof: a plant room, units, a tank. */
function roofPlant(p: Parts, cx: number, cy: number, r: number, top: number): void {
  p.box('lightGrid', cx - r * 0.35, cx + r * 0.35, cy - r * 0.25, cy + r * 0.25, top, top + 3);
  p.box('metal', cx - r * 0.38, cx + r * 0.38, cy - r * 0.28, cy + r * 0.28, top + 3, top + 3.2);
  p.box('metal', cx + r * 0.45, cx + r * 0.6, cy - 0.6, cy + 0.6, top, top + 1.2);
  p.cylinder('metal', cx - r * 0.5, cy, top, top + 2.2, 0.8);
}

/** 1. A square tower turning a little at every floor, teal glass, white slab edges. */
const twistGreen: Design = (p, W, D, g, s, upper) => {
  const zP = podium2(p, W, D, g, s, 'stoneLight');
  const cx = W / 2, cy = D / 2, r = (Math.min(W, D) * 0.66) / Math.SQRT2;
  const face = facade('curtainTeal', 1.5, s, 0);
  for (let k = 2; k <= upper; k++) {
    const z = g + (k - 1) * s, rot = Math.PI / 4 + (k - 2) * 0.045;
    p.prism(face, cx, cy, r, Math.max(z, zP), z + s, 4, rot);
    p.prism('white', cx, cy, r + 0.55, z + s - 0.1, z + s + 0.18, 4, rot);
  }
  const top = g + upper * s + 0.18;
  roofPlant(p, cx, cy, r, top);
};

/** 2. A hexagon in terracotta with arched windows, white string courses, a lantern on top. */
const hexTerracotta: Design = (p, W, D, g, s, upper) => {
  const zP = podium2(p, W, D, g, s, 'stone', 'white');
  const cx = W / 2, cy = D / 2, r = Math.min(W, D) * 0.47;
  const face = facade('archTerracotta', 2.2, s, 0);
  const top = g + upper * s;
  p.prism(face, cx, cy, r, zP, top, 6, Math.PI / 6);
  for (let k = 2; k <= upper; k += 3) { const z = g + (k - 1) * s; p.prism('white', cx, cy, r + 0.3, z - 0.15, z + 0.3, 6, Math.PI / 6); }
  p.prism('white', cx, cy, r + 0.5, top, top + 0.6, 6, Math.PI / 6);
  p.prism('podiumGlass', cx, cy, r * 0.45, top + 0.6, top + 4.5, 6, Math.PI / 6);
  p.prism('white', cx, cy, r * 0.5, top + 4.5, top + 4.9, 6, Math.PI / 6);
  const roof = new ConeGeometry(r * 0.5, 3.5, 6, 1, false, Math.PI / 6);
  roof.translate(cx, top + 4.9 + 1.75, -cy);
  p.pushRaw('roofTerracotta', roof);
};

/** 3. A ziggurat of terraces every four floors, white ribbon windows, gardens and glass rails on each step. */
const stepGarden: Design = (p, W, D, g, s, upper) => {
  const zP = podium2(p, W, D, g, s, 'stoneLight');
  const face = facade('ribbonWhite', 3, s, 0);
  let x0 = 1.5, x1 = W - 1.5, y0 = 1.5, y1 = D - 1.5;
  const per = 4;
  for (let k = 2; k <= upper; k += per) {
    const z0 = Math.max(zP, g + (k - 1) * s), z1 = g + Math.min(upper, k - 1 + per) * s;
    p.box(face, x0, x1, y0, y1, z0, z1);
    // The terrace on top of this tier: planters round its edge, a glass rail.
    p.box('plant', x0, x1, y0, y1, z1, z1 + 0.15);
    const n = x1 - x0 > 8 ? 2.2 : 0;
    const nx0 = x0 + n, nx1 = x1 - n, ny0 = y0 + n, ny1 = y1 - n;
    if (k + per <= upper) {
      p.box('glassRail', x0, x1, y0, y0 + 0.05, z1 + 0.15, z1 + 1.2);
      p.box('glassRail', x0, x1, y1 - 0.05, y1, z1 + 0.15, z1 + 1.2);
      for (let t = 0; t < 4; t++) {
        const x = x0 + 0.8 + (t * (x1 - x0 - 1.6)) / 3;
        p.box('pot', x - 0.6, x + 0.6, y0 + 0.3, y0 + 1.3, z1 + 0.15, z1 + 0.7);
        p.bush(x, y0 + 0.8, z1 + 0.7, 0.55, t % 2 === 0);
      }
    }
    x0 = nx0; x1 = nx1; y0 = ny0; y1 = ny1;
    if (x1 - x0 < 6 || y1 - y0 < 6) break;
  }
  roofPlant(p, W / 2, D / 2, Math.min(x1 - x0, y1 - y0) / 2, g + upper * s + 0.15);
};

/** 4. White slab balconies that wave in and out, floor after floor, glass rails, blue glass behind. */
const waveWhite: Design = (p, W, D, g, s, upper) => {
  const zP = podium2(p, W, D, g, s, 'white');
  const sx0 = 2.5, sx1 = W - 2.5, sy0 = 2.5, sy1 = D - 2.5;
  const top = g + upper * s;
  p.box(facade('curtainBlue', 1.5, s, 0), sx0, sx1, sy0, sy1, zP, top);
  for (let k = 2; k <= upper; k++) {
    const z = g + (k - 1) * s;
    const seg = 1.2;
    for (const mirror of [null, D]) {
      p.mirror = mirror;
      for (let x = sx0 - 1; x < sx1 + 1; x += seg) {
        const deep = 1.1 + 0.9 * Math.sin(x * 0.42 + k * 0.75);
        p.box('white', x, x + seg + 0.01, sy0 - deep, sy0, z, z + 0.24);
        p.box('glassRail', x, x + seg, sy0 - deep, sy0 - deep + 0.04, z + 0.24, z + 1.2);
      }
    }
    p.mirror = null;
    for (const [x, out] of [[sx0, -1], [sx1, 1]] as const) {
      for (let y = sy0; y < sy1; y += 1.2) {
        const deep = 0.8 + 0.6 * Math.sin(y * 0.5 + k * 0.75);
        p.box('white', out < 0 ? x - deep : x, out < 0 ? x : x + deep, y, y + 1.21, z, z + 0.24);
      }
    }
  }
  p.box('white', sx0 - 0.3, sx1 + 0.3, sy0 - 0.3, sy1 + 0.3, top, top + 0.7);
  roofPlant(p, W / 2, D / 2, (sx1 - sx0) / 2, top + 0.7);
};

/** 5. Concrete with orange-framed windows, glass box balconies standing out in a chequer. */
const cubeBalcony: Design = (p, W, D, g, s, upper) => {
  const zP = podium2(p, W, D, g, s, 'darkPanel', 'orange');
  const sx0 = 1.5, sx1 = W - 1.5, sy0 = 2, sy1 = D - 2;
  const top = g + upper * s;
  p.box(facade('squareConcrete', 2.4, s, 0), sx0, sx1, sy0, sy1, zP, top);
  const cols = Math.max(3, Math.round((sx1 - sx0) / 3.6));
  for (let k = 2; k <= upper; k++) {
    const z = g + (k - 1) * s;
    for (const mirror of [null, D]) {
      p.mirror = mirror;
      for (let c = (k % 2); c < cols; c += 2) {
        const x0 = sx0 + (c * (sx1 - sx0)) / cols + 0.25, x1 = sx0 + ((c + 1) * (sx1 - sx0)) / cols - 0.25;
        p.box('orange', x0, x1, sy0 - 1.5, sy0, z + 0.05, z + 0.25);
        p.box('orange', x0, x1, sy0 - 1.5, sy0, z + s - 0.25, z + s - 0.05);
        p.box('orange', x0, x0 + 0.15, sy0 - 1.5, sy0, z + 0.25, z + s - 0.25);
        p.box('orange', x1 - 0.15, x1, sy0 - 1.5, sy0, z + 0.25, z + s - 0.25);
        p.box('glassRail', x0 + 0.15, x1 - 0.15, sy0 - 1.5, sy0 - 1.45, z + 0.25, z + s - 0.25);
      }
    }
    p.mirror = null;
  }
  p.box('trim', sx0 - 0.2, sx1 + 0.2, sy0 - 0.2, sy1 + 0.2, top, top + 0.6);
  roofPlant(p, W / 2, D / 2, (sx1 - sx0) / 2, top + 0.6);
};

/** 6. Twin navy towers with gold bands, joined by a glass sky bridge. */
const twinNavy: Design = (p, W, D, g, s, upper) => {
  const zP = podium2(p, W, D, g, s, 'darkPanel', 'gold');
  const face = facade('navyGrid', 1.8, s, 0);
  const tw = W * 0.36, y0 = D * 0.15, y1 = D * 0.85;
  const towers: [number, number, number][] = [[1.2, 1.2 + tw, g + upper * s], [W - 1.2 - tw, W - 1.2, g + Math.round(upper * 0.82) * s]];
  for (const [x0, x1, top] of towers) {
    p.box(face, x0, x1, y0, y1, zP, top);
    for (let z = zP + 5 * s; z < top - s; z += 5 * s) p.box('gold', x0 - 0.15, x1 + 0.15, y0 - 0.15, y1 + 0.15, z - 0.2, z + 0.2);
    p.box('gold', x0 - 0.3, x1 + 0.3, y0 - 0.3, y1 + 0.3, top, top + 0.8);
    p.box('darkPanel', x0 + 1, x1 - 1, y0 + 1, y1 - 1, top + 0.8, top + 3);
    p.cylinder('gold', (x0 + x1) / 2, (y0 + y1) / 2, top + 3, top + 9, 0.15);
  }
  const zb = g + Math.round(upper * 0.55) * s;
  p.box('glassRail', 1.2 + tw, W - 1.2 - tw, D * 0.4, D * 0.6, zb, zb + 2 * s);
  p.box('gold', 1.2 + tw, W - 1.2 - tw, D * 0.4 - 0.1, D * 0.6 + 0.1, zb - 0.3, zb);
  p.box('gold', 1.2 + tw, W - 1.2 - tw, D * 0.4 - 0.1, D * 0.6 + 0.1, zb + 2 * s, zb + 2 * s + 0.3);
};

/** 7. An octagon of glass behind copper fins, narrowing at the top under a copper spire. */
const octCopper: Design = (p, W, D, g, s, upper) => {
  const zP = podium2(p, W, D, g, s, 'stone', 'copper');
  const cx = W / 2, cy = D / 2, r = Math.min(W, D) * 0.46, rot = Math.PI / 8;
  const face = facade('copperFins', 1.2, s, 0);
  const top = g + upper * s, mid = g + Math.round(upper * 0.8) * s;
  p.prism(face, cx, cy, r, zP, mid, 8, rot);
  p.prism('copper', cx, cy, r + 0.2, mid, mid + 0.5, 8, rot);
  p.prism(face, cx, cy, r * 0.78, mid + 0.5, top, 8, rot);
  p.prism('copper', cx, cy, r * 0.82, top, top + 0.6, 8, rot);
  const spire = new ConeGeometry(r * 0.45, 14, 8, 1, false, rot);
  spire.translate(cx, top + 0.6 + 7, -cy);
  p.pushRaw('copper', spire);
};

/** 8. Blocks of four floors stacked out of line, black and white in turn. */
const stackedBlocks: Design = (p, W, D, g, s, upper) => {
  const zP = podium2(p, W, D, g, s, 'darkPanel');
  const white = facade('ribbonWhite', 2.4, s, 0), black = facade('ribbonBlack', 2.4, s, 0);
  const bw = W * 0.72, bd = D * 0.7;
  let i = 0;
  for (let k = 2; k <= upper; k += 4, i++) {
    const z0 = Math.max(zP, g + (k - 1) * s), z1 = g + Math.min(upper, k + 3) * s;
    const dx = i % 2 === 0 ? -2.5 : 2.5, dy = i % 3 === 0 ? -1.5 : i % 3 === 1 ? 1.5 : 0;
    const x0 = W / 2 - bw / 2 + dx, y0 = D / 2 - bd / 2 + dy;
    p.box(i % 2 === 0 ? white : black, x0, x0 + bw, y0, y0 + bd, z0, z1);
    p.box(i % 2 === 0 ? 'darkPanel' : 'white', x0 - 0.2, x0 + bw + 0.2, y0 - 0.2, y0 + bd + 0.2, z1 - 0.01, z1 + 0.35);
    // A roof garden where a block overhangs the next.
    p.bush(x0 + 1, y0 + 1, z1 + 0.35, 0.6);
    p.bush(x0 + bw - 1, y0 + bd - 1, z1 + 0.35, 0.6, true);
  }
};

/** 9. Pink flats on an L with a round corner, white-framed windows, corner balconies with black rails. */
const pinkCorner: Design = (p, W, D, g, s, upper) => {
  const zP = podium2(p, W, D, g, s, 'white');
  const face = facade('punchedPink', 2.2, s, 0);
  const top = g + upper * s;
  const r = D * 0.24;
  // The street wing with a rounded end, the side wing going back.
  p.box(face, r, W - 1, 1, 1 + 2 * r, zP, top);
  p.ellipse(face, r, 1 + r, r, r, zP, top, 20);
  p.box(face, W - 1 - 2 * r, W - 1, 1 + 2 * r, D - 1, zP, top);
  for (let k = 2; k <= upper; k++) {
    const z = g + (k - 1) * s;
    // Balconies in the corner of the L: along the street wing's back and the side wing's flank.
    p.box('white', r, W - 1 - 2 * r, 1 + 2 * r, 2.6 + 2 * r, z, z + 0.22);
    p.rail(r, W - 1 - 2 * r, 2.56 + 2 * r, 2.6 + 2 * r, z + 0.22);
    p.box('white', W - 2.6 - 2 * r, W - 1 - 2 * r, 2.6 + 2 * r, D - 1, z, z + 0.22);
    p.rail(W - 2.64 - 2 * r, W - 2.6 - 2 * r, 2.6 + 2 * r, D - 1, z + 0.22);
    p.ellipse('white', r, 1 + r, r + 0.15, r + 0.15, z - 0.1, z + 0.12, 20);
    if (k % 2 === 0) p.plant(r + 1.5, 2.2 + 2 * r, z + 0.22, 0.8);
  }
  p.box('white', r - 0.2, W - 0.8, 0.8, 1.2 + 2 * r, top, top + 0.5);
  p.ellipse('white', r, 1 + r, r + 0.2, r + 0.2, top, top + 0.5, 20);
  p.box('white', W - 1.2 - 2 * r, W - 0.8, 1.2 + 2 * r, D - 0.8, top, top + 0.5);
};

/** 10. A triangle of dark glass, white frame bands, a narrower crown and a mast. */
const triangleDark: Design = (p, W, D, g, s, upper) => {
  const zP = podium2(p, W, D, g, s, 'darkPanel');
  const cx = W / 2, cy = D * 0.52, r = Math.min(W, D) * 0.6, rot = Math.PI;
  const face = facade('curtainDark', 1.5, s, 0);
  const top = g + upper * s, crown = top - 4 * s;
  p.prism(face, cx, cy, r, zP, crown, 3, rot);
  for (let z = zP + 4 * s; z < crown; z += 4 * s) p.prism('white', cx, cy, r + 0.35, z - 0.2, z + 0.2, 3, rot);
  p.prism('white', cx, cy, r + 0.4, crown - 0.3, crown + 0.2, 3, rot);
  p.prism(face, cx, cy, r * 0.62, crown + 0.2, top, 3, rot);
  p.prism('white', cx, cy, r * 0.66, top, top + 0.5, 3, rot);
  p.cylinder('lightGrid', cx, cy, top + 0.5, top + 16, 0.25);
};

// ------------------------------------------------------------ civic buildings

type Painter = (g: CanvasRenderingContext2D, w: number, h: number) => void;

/** Lettering on a panel: `bg` null for letters alone. */
const lettering = (text: string, fg: string, bg: string | null, sub?: string): Painter => (g, w, h) => {
  if (bg) { g.fillStyle = bg; g.fillRect(0, 0, w, h); }
  g.fillStyle = fg; g.textAlign = 'center'; g.textBaseline = 'middle';
  const size = Math.min(h * (sub ? 0.5 : 0.7), (w / Math.max(4, text.length)) * 1.6);
  g.font = `700 ${size}px Georgia, serif`;
  g.fillText(text, w / 2, sub ? h * 0.38 : h / 2);
  if (sub) { g.font = `500 ${size * 0.42}px Georgia, serif`; g.fillText(sub, w / 2, h * 0.78); }
};
const clockFace: Painter = (g, w, h) => {
  const r = Math.min(w, h) / 2 - 4;
  g.fillStyle = '#3c4a3f'; g.beginPath(); g.arc(w / 2, h / 2, r + 4, 0, Math.PI * 2); g.fill();
  g.fillStyle = '#f4efe2'; g.beginPath(); g.arc(w / 2, h / 2, r, 0, Math.PI * 2); g.fill();
  g.strokeStyle = '#222'; g.lineWidth = r * 0.04;
  for (let k = 0; k < 12; k++) { const a = (k * Math.PI) / 6; g.beginPath(); g.moveTo(w / 2 + Math.cos(a) * r * 0.82, h / 2 + Math.sin(a) * r * 0.82); g.lineTo(w / 2 + Math.cos(a) * r * 0.95, h / 2 + Math.sin(a) * r * 0.95); g.stroke(); }
  g.lineWidth = r * 0.07; g.beginPath(); g.moveTo(w / 2, h / 2); g.lineTo(w / 2 + r * 0.45, h / 2 - r * 0.2); g.stroke();
  g.lineWidth = r * 0.05; g.beginPath(); g.moveTo(w / 2, h / 2); g.lineTo(w / 2 - r * 0.1, h / 2 - r * 0.7); g.stroke();
};
const redCross: Painter = (g, w, h) => {
  g.fillStyle = '#ffffff'; g.fillRect(0, 0, w, h);
  g.fillStyle = '#d32027'; g.fillRect(w * 0.38, h * 0.12, w * 0.24, h * 0.76); g.fillRect(w * 0.12, h * 0.38, w * 0.76, h * 0.24);
};
const helipad: Painter = (g, w, h) => {
  g.fillStyle = '#5a5e63'; g.fillRect(0, 0, w, h);
  g.strokeStyle = '#ffffff'; g.lineWidth = w * 0.04; g.beginPath(); g.arc(w / 2, h / 2, w * 0.4, 0, Math.PI * 2); g.stroke();
  g.fillStyle = '#ffffff'; g.font = `700 ${h * 0.5}px Arial`; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText('H', w / 2, h / 2);
};
const brazilFlag: Painter = (g, w, h) => {
  g.fillStyle = '#1a9b3c'; g.fillRect(0, 0, w, h);
  g.fillStyle = '#f7d117'; g.beginPath(); g.moveTo(w / 2, h * 0.1); g.lineTo(w * 0.92, h / 2); g.lineTo(w / 2, h * 0.9); g.lineTo(w * 0.08, h / 2); g.fill();
  g.fillStyle = '#1d3f8f'; g.beginPath(); g.arc(w / 2, h / 2, h * 0.24, 0, Math.PI * 2); g.fill();
};
const stripedFlag: Painter = (g, w, h) => {
  for (let k = 0; k < 7; k++) { g.fillStyle = k % 2 ? '#ffffff' : '#111111'; g.fillRect(0, (k * h) / 7, w, h / 7 + 1); }
  g.fillStyle = '#c8102e'; g.fillRect(0, 0, w * 0.4, h * 0.5);
};
const plainFlag = (colour: string, mark: string): Painter => (g, w, h) => {
  g.fillStyle = colour; g.fillRect(0, 0, w, h);
  g.fillStyle = mark; g.beginPath(); g.arc(w / 2, h / 2, h * 0.28, 0, Math.PI * 2); g.fill();
};
const garageDoor = (label: string): Painter => (g, w, h) => {
  g.fillStyle = '#5f6266'; g.fillRect(0, 0, w, h * 0.14);
  g.fillStyle = '#ffffff'; g.font = `700 ${h * 0.1}px Arial`; g.textAlign = 'center'; g.fillText(label, w / 2, h * 0.11);
  g.fillStyle = '#b8242a'; g.fillRect(0, h * 0.14, w, h * 0.86);
  for (let y = h * 0.14; y < h; y += h * 0.09) { g.fillStyle = 'rgba(0,0,0,.25)'; g.fillRect(0, y, w, 2); }
  g.fillStyle = '#2b3a44'; for (let k = 0; k < 4; k++) g.fillRect(w * 0.08 + k * w * 0.22, h * 0.42, w * 0.18, h * 0.14);
};
const badge: Painter = (g, w, h) => {
  g.fillStyle = '#c9a54a'; g.beginPath(); g.moveTo(w / 2, 4); g.lineTo(w - 6, h * 0.25); g.lineTo(w * 0.85, h * 0.8); g.lineTo(w / 2, h - 4); g.lineTo(w * 0.15, h * 0.8); g.lineTo(6, h * 0.25); g.fill();
  g.fillStyle = '#2f5a2a'; g.beginPath(); g.arc(w / 2, h / 2, w * 0.2, 0, Math.PI * 2); g.fill();
};
const scales: Painter = (g, w, h) => {
  g.strokeStyle = '#3a3a3a'; g.lineWidth = h * 0.06;
  g.beginPath(); g.moveTo(w / 2, h * 0.1); g.lineTo(w / 2, h * 0.85); g.moveTo(w * 0.2, h * 0.3); g.lineTo(w * 0.8, h * 0.3); g.moveTo(w * 0.3, h * 0.85); g.lineTo(w * 0.7, h * 0.85); g.stroke();
  for (const x of [0.2, 0.8]) { g.beginPath(); g.arc(w * x, h * 0.55, w * 0.12, 0, Math.PI); g.stroke(); }
};
const roseWindow: Painter = (g, w, h) => {
  const r = Math.min(w, h) / 2 - 3;
  g.fillStyle = '#cbbd9f'; g.beginPath(); g.arc(w / 2, h / 2, r + 3, 0, Math.PI * 2); g.fill();
  for (let k = 0; k < 8; k++) {
    const a = (k * Math.PI) / 4;
    g.fillStyle = ['#7a3b52', '#2f5a8a', '#c49a3a', '#3d7a4a'][k % 4]!;
    g.beginPath(); g.moveTo(w / 2, h / 2); g.arc(w / 2, h / 2, r * 0.92, a, a + Math.PI / 4 - 0.08); g.fill();
  }
  g.fillStyle = '#cbbd9f'; g.beginPath(); g.arc(w / 2, h / 2, r * 0.25, 0, Math.PI * 2); g.fill();
};
const archDoor: Painter = (g, w, h) => {
  g.fillStyle = '#d8ccb3'; g.fillRect(0, 0, w, h);
  g.fillStyle = '#6b4a2f'; g.beginPath(); g.arc(w / 2, w / 2, w * 0.42, Math.PI, 0); g.lineTo(w * 0.92, h); g.lineTo(w * 0.08, h); g.fill();
  g.fillStyle = '#3a2718'; g.fillRect(w / 2 - 2, w / 2, 4, h);
};
const ironGate: Painter = (g, w, h) => {
  g.clearRect(0, 0, w, h); g.strokeStyle = '#1b1c1e'; g.lineWidth = 4;
  for (let x = 6; x < w; x += 14) { g.beginPath(); g.moveTo(x, h); g.lineTo(x, h * 0.25 + Math.abs(x - w / 2) * 0.3); g.stroke(); }
  g.beginPath(); g.moveTo(0, h * 0.6); g.lineTo(w, h * 0.6); g.stroke(); g.beginPath(); g.arc(w / 2, h * 0.6, w * 0.45, Math.PI, 0); g.stroke();
};
const banner = (text: string): Painter => (g, w, h) => {
  g.fillStyle = '#23365c'; g.fillRect(0, 0, w, h);
  g.fillStyle = '#d8b25a'; g.font = `600 ${w * 0.16}px Georgia, serif`; g.textAlign = 'center';
  text.split(' ').forEach((word, i) => g.fillText(word, w / 2, h * 0.25 + i * w * 0.2));
  g.strokeStyle = '#d8b25a'; g.lineWidth = 3; g.beginPath(); g.arc(w / 2, h * 0.78, w * 0.18, 0.3, Math.PI - 0.3); g.stroke();
};

/** Columns along x on a portico: `n` of them between x0 and x1 at depth y, on `z`, `h` tall. */
function colonnade(p: Parts, x0: number, x1: number, y: number, z: number, h: number, n: number, r = 0.45, mat: Mat = 'ivory'): void {
  for (let k = 0; k < n; k++) {
    const x = n === 1 ? (x0 + x1) / 2 : x0 + ((x1 - x0) * k) / (n - 1);
    p.box(mat, x - r * 1.3, x + r * 1.3, y - r * 1.3, y + r * 1.3, z, z + 0.5);
    p.cylinder(mat, x, y, z + 0.5, z + h - 0.6, r);
    p.box(mat, x - r * 1.35, x + r * 1.35, y - r * 1.35, y + r * 1.35, z + h - 0.6, z + h);
  }
}

/** A balustrade along x at height z: a rail, balusters, a plinth. */
function balustrade(p: Parts, x0: number, x1: number, y: number, z: number, mat: Mat = 'ivory'): void {
  p.box(mat, x0, x1, y - 0.2, y + 0.2, z, z + 0.15);
  p.box(mat, x0, x1, y - 0.22, y + 0.22, z + 0.85, z + 1.0);
  for (let x = x0 + 0.2; x < x1; x += 0.35) p.cylinder(mat, x, y, z + 0.15, z + 0.85, 0.07);
}

/** 1. A town hall in red brick and stone: arched windows, a pedimented centre, a slate roof with dormers, a clock tower under a copper dome. */
const cityHallBrick: Design = (p, W, D, _g) => {
  const H = 1.6 + 4.2 * 2; // two tall storeys above a raised basement
  const face = facade('archBrick', 3.2, 4.2, 1.6);
  p.box('stoneLight', 0, W, 0, D, 0, 1.6);
  p.box(face, 0.3, W - 0.3, 0.3, D - 0.3, 1.6, H);
  for (const [x0, x1] of [[0, 1.4], [W - 1.4, W]] as const) p.box('stoneLight', x0, x1, -0.1, D + 0.1, 1.6, H);
  p.box('stoneLight', -0.1, W + 0.1, -0.1, D + 0.1, 1.6 + 4.2 - 0.2, 1.6 + 4.2 + 0.15);
  // The centre: brought forward, stone, paired columns, an arched door, a pediment with a crest.
  const c0 = W * 0.36, c1 = W * 0.64;
  p.box('stoneLight', c0, c1, -1.2, 0.3, 0, H);
  colonnade(p, c0 + 0.8, c0 + 2.0, -1.5, 1.6, H - 1.6 - 0.8, 2, 0.32);
  colonnade(p, c1 - 2.0, c1 - 0.8, -1.5, 1.6, H - 1.6 - 0.8, 2, 0.32);
  p.decal('archDoorTall', archDoor, W / 2, -1.25, 3.2, 5.6, 1.6);
  p.box('stoneLight', -0.3, W + 0.3, -0.4, D + 0.3, H, H + 0.7);
  p.gable('stoneLight', c0 - 0.3, c1 + 0.3, -1.6, 0.3, H + 0.7, 3.2, 'x');
  p.decal('crest', (gg, w, h) => { gg.fillStyle = '#cfc4ad'; gg.beginPath(); gg.moveTo(w / 2, 4); gg.lineTo(w - 6, h * 0.3); gg.lineTo(w / 2, h - 4); gg.lineTo(6, h * 0.3); gg.fill(); }, W / 2, -1.62, 2, 1.8, H + 1);
  balustrade(p, 0.5, c0 - 0.4, 0.2, H + 0.7);
  balustrade(p, c1 + 0.4, W - 0.5, 0.2, H + 0.7);
  // Slate roof with copper dormers, brick chimneys.
  p.hip('slate', 0.6, W - 0.6, 0.6, D - 0.6, H + 0.7, 6.5, 0.22);
  for (const x of [W * 0.2, W * 0.8]) {
    p.box('ivory', x - 1, x + 1, 1.8, 3.2, H + 1.2, H + 3.4);
    p.windowFront(x - 0.6, x + 0.6, 1.78, H + 1.5, H + 3, 0);
    p.hip('patina', x - 1.2, x + 1.2, 1.6, 3.4, H + 3.4, 1.2, 0.2);
  }
  for (const x of [W * 0.12, W * 0.88]) { p.box('brickRed', x - 0.9, x + 0.9, D * 0.4, D * 0.4 + 1.8, H + 2, H + 7.5); p.box('stoneLight', x - 1, x + 1, D * 0.4 - 0.1, D * 0.4 + 1.9, H + 7.5, H + 7.9); }
  // The clock tower: stone, clocks on three faces, an open belfry, a copper dome and finial.
  const tx = W / 2, ty = D * 0.45, t = 2.8, z0 = H + 5.5;
  p.box('stoneLight', tx - t, tx + t, ty - t, ty + t, H + 3, z0 + 3);
  p.decal('clock', clockFace, tx, ty - t - 0.02, 3, 3, z0 - 0.2);
  p.decal('clock', clockFace, tx - t - 0.02, ty, 3, 3, z0 - 0.2, 'left');
  p.decal('clock', clockFace, tx + t + 0.02, ty, 3, 3, z0 - 0.2, 'right');
  p.box('stoneLight', tx - t - 0.3, tx + t + 0.3, ty - t - 0.3, ty + t + 0.3, z0 + 3, z0 + 3.4);
  for (const [dx, dy] of [[-1, -1], [1, -1], [-1, 1], [1, 1]] as const) p.box('stoneLight', tx + dx * t - 0.5, tx + dx * t + 0.5, ty + dy * t - 0.5, ty + dy * t + 0.5, z0 + 3.4, z0 + 6.4);
  p.box('stoneLight', tx - t + 0.9, tx + t - 0.9, ty - t + 0.9, ty + t - 0.9, z0 + 3.4, z0 + 6.4);
  for (const f of ['front', 'left', 'right'] as const) {
    const [cx, cy] = f === 'front' ? [tx, ty - t - 0.02] : f === 'left' ? [tx - t - 0.02, ty] : [tx + t + 0.02, ty];
    p.decal('belfry', archOpening, cx, cy, 2 * t - 1, 3, z0 + 3.4, f);
  }
  p.box('stoneLight', tx - t - 0.3, tx + t + 0.3, ty - t - 0.3, ty + t + 0.3, z0 + 6.4, z0 + 7);
  p.dome('patina', tx, ty, t * 0.85, z0 + 7, 1.35);
  p.cylinder('patina', tx, ty, z0 + 7 + t * 0.85 * 1.35, z0 + 11.5, 0.12);
  // The steps and lamps.
  p.steps('stoneLight', W / 2 - 4, W / 2 + 4, -5.2, 9, 0.42, 0.18);
  p.lamp(W / 2 - 4.6, -4.5, 0, 3.4); p.lamp(W / 2 + 4.6, -4.5, 0, 3.4);
};

/** 2. An art deco skyscraper: setbacks of beige stone with gold strips, pinnacles, a golden crown and spire. */
const decoSpire: Design = (p, W, D, g, s, upper) => {
  const zP = podium2(p, W, D, g, s, 'stoneLight', 'gold');
  const face = facade('decoStripes', 2, s, 0);
  const top = g + upper * s;
  const tiers = 6;
  for (let t = 0; t < tiers; t++) {
    const inset = 1 + t * Math.min(W, D) * 0.07;
    const z0 = t === 0 ? zP : zP + ((top - zP) * t) / tiers, z1 = zP + ((top - zP) * (t + 1)) / tiers;
    const x0 = inset, x1 = W - inset, y0 = inset, y1 = D - inset;
    if (x1 - x0 < 3) break;
    p.box(face, x0, x1, y0, y1, z0, z1);
    // Corner pinnacles and a gold band at each setback.
    for (const [x, y] of [[x0, y0], [x1, y0], [x0, y1], [x1, y1]] as const) {
      p.box('ivory', x - 0.6, x + 0.6, y - 0.6, y + 0.6, z1 - 0.5, z1 + 2.2);
      p.box('gold', x - 0.2, x + 0.2, y - 0.2, y + 0.2, z1 + 2.2, z1 + 3.2);
    }
    p.box('gold', x0 - 0.15, x1 + 0.15, y0 - 0.15, y1 + 0.15, z1 - 0.35, z1 - 0.05);
    p.bush(x0 + 1, y0 + 0.9, z1, 0.45, t % 2 === 0); p.bush(x1 - 1, y0 + 0.9, z1, 0.45);
  }
  // The crown: a sunburst of gold fins and a spire.
  const cx = W / 2, cy = D / 2, cr = Math.min(W, D) * 0.12;
  for (let k = 0; k < 12; k++) {
    const a = (k / 12) * Math.PI * 2;
    const x = cx + Math.cos(a) * cr, y = cy + Math.sin(a) * cr;
    p.box('gold', x - 0.25, x + 0.25, y - 0.25, y + 0.25, top, top + 4 + (k % 3) * 2);
  }
  const spire = new ConeGeometry(cr * 0.7, 18, 8);
  spire.translate(cx, top + 9, -cy);
  p.pushRaw('gold', spire);
  // The entrance: a tall gold-framed portal, sconces, steps, cypresses.
  p.box('gold', W / 2 - 2.6, W / 2 + 2.6, -0.2, 0.1, 0, zP - 0.6);
  p.windowFront(W / 2 - 2.2, W / 2 + 2.2, -0.22, 0, zP - 1, 3);
  p.steps('stoneLight', W / 2 - 4, W / 2 + 4, -3, 5);
  for (const x of [2, W - 2, W / 2 - 5, W / 2 + 5]) p.cypress(x, -1.2, 4.5);
};

/** A hospital: a glass centre in a white frame, wings, an emergency canopy, a helipad, plant. */
function hospital(p: Parts, W: number, D: number, g: number, s: number, upper: number, variant: 0 | 1): void {
  const front = 9; // the drop-off drive in front of the doors
  const white = facade('officeWhite', 2.4, s, 0);
  const top = g + upper * s;
  const wing = variant === 0 ? Math.round(upper * 0.75) : Math.round(upper * 0.6);
  const wz = g + wing * s;
  p.box('asphalt', 0, W, 0, front, 0, 0.06);
  p.box('concreteLight', W * 0.42, W * 0.58, front * 0.35, front * 0.65, 0.06, 0.25);
  p.bush(W / 2, front / 2, 0.25, 0.8);
  // The wings either side and the low block in front.
  p.box(white, 0, W * 0.3, front, D, 0, wz);
  p.box(white, W * 0.7, W, front, D, 0, variant === 0 ? wz - 3 * s : wz);
  p.box(white, W * 0.3, W * 0.7, front, D * 0.92, 0, top);
  // The glass centre framed in white panels.
  p.box(facade('curtainBlue', 1.5, s, 0), W * 0.38, W * 0.62, front - 0.6, front + 1, 0, top - 1.5);
  p.box('white', W * 0.36, W * 0.64, front - 0.8, front + 1, top - 1.5, top + 0.4);
  p.decal(`hospital${variant}`, lettering('HOSPITAL', '#1f4f9c', null), W / 2, front - 0.82, W * 0.24, 1.6, top - 1.4);
  p.decal('redcross', redCross, W / 2, front - 0.82, 1.6, 1.6, top + 0.5);
  // The emergency canopy: glass roof on white frame and columns, its sign.
  p.box('white', W * 0.32, W * 0.68, 1.5, front, 4.2, 4.9);
  p.box('glassRail', W * 0.34, W * 0.66, 2, front - 0.2, 4.9, 5.1);
  for (const x of [W * 0.33, W * 0.67]) { p.box('white', x - 0.4, x + 0.4, 1.5, 2.3, 0, 4.2); }
  p.decal('emergencia', lettering('EMERGÊNCIA', '#d32027', '#ffffff'), W / 2, 1.48, W * 0.3, 0.7, 4.2);
  p.box('podiumGlass', W * 0.36, W * 0.64, front - 0.1, front + 0.05, 0.1, 3.8);
  // Roofs: helipad on the centre, plant on the wings.
  p.decal('helipad', helipad, W / 2, D * 0.55, Math.min(W * 0.36, 10), Math.min(W * 0.36, 10), top + 0.42);
  roofRing(p, 'white', W * 0.3, W * 0.7, front + 1, D * 0.92, top, top + 0.4);
  for (const [x0, x1, z] of [[0, W * 0.3, wz], [W * 0.7, W, variant === 0 ? wz - 3 * s : wz]] as const) {
    roofRing(p, 'white', x0, x1, front, D, z, z + 0.3);
    for (let k = 0; k < 3; k++) p.box('metal', x0 + 1 + k * 2.2, x0 + 2.6 + k * 2.2, front + 2, front + 3.4, z + 0.3, z + 1.5);
  }
  for (let k = 0; k < 3; k++) p.cylinder('lightGrid', W * 0.34 + k * 0.6, D * 0.85, top + 0.4, top + 4 + k, 0.06);
  // A sign at the drive and trees.
  p.box('white', W - 4, W - 2.6, 1, 1.6, 0, 3.2);
  p.decal('signTotem', lettering('PRONTO-SOCORRO', '#d32027', '#ffffff', 'Entrada principal'), W - 3.3, 0.98, 1.4, 2.4, 0.6);
  for (const x of [1.5, 4, W - 6]) p.tree(x, 2, 1.3, 4.5);
}
const hospitalA: Design = (p, W, D, g, s, upper) => hospital(p, W, D, g, s, upper, 0);
const hospitalB: Design = (p, W, D, g, s, upper) => hospital(p, W, D, g, s, upper, 1);

/** 4. Brick lofts: black shopfronts with awnings, big black-framed windows, terraces stepping back, a water tower. */
const loftBrick: Design = (p, W, D, g, s, upper) => {
  const face = facade('loftBrick', 3, s, 0);
  const top = g + upper * s, step = g + (upper - 3) * s;
  // The ground floor: black frame, shopfronts lit inside, awnings and signs.
  p.box('blackSteel', 0, W, 0, D, 0, g);
  const shops = 3;
  for (let k = 0; k < shops; k++) {
    const x0 = (k * W) / shops + 0.6, x1 = ((k + 1) * W) / shops - 0.6;
    p.box('podiumGlass', x0, x1, -0.04, 0.02, 0.2, g - 1);
    p.box('blackSteel', x0 - 0.2, x1 + 0.2, -1.6, 0, g - 1.1, g - 0.95);
    p.decal(`loftSign${k}`, lettering(['CAFÉ', 'LOFTS', 'MERCADO'][k]!, '#e7d6a8', '#151515'), (x0 + x1) / 2, -0.06, x1 - x0, 0.6, g - 0.9);
  }
  // The brick body, stepping back for terraces three floors from the top.
  p.box(face, 0, W, 0, D, g, step);
  p.box(face, 2.5, W - 2.5, 2.5, D - 1, step, top);
  roofRing(p, 'blackSteel', -0.1, W + 0.1, -0.1, D + 0.1, step - 0.2, step + 0.1, step);
  p.rail(0.1, W - 0.1, 0.1, 0.15, step + 0.1);
  for (let k = 0; k < 5; k++) p.plant(1 + k * (W - 2) / 4, 1.2, step + 0.1, 1);
  // A recessed column of balconies in the middle, black railings, plants.
  for (let k = 1; k < upper - 3; k++) {
    const z = g + (k - 1) * s;
    p.box('blackSteel', W / 2 - 2, W / 2 + 2, -1.1, 0, z, z + 0.2);
    p.rail(W / 2 - 2, W / 2 + 2, -1.1, -1.06, z + 0.2);
    p.plant(W / 2 - 1.4, -0.6, z + 0.2, 0.7);
  }
  // A painted sign on the side wall.
  p.decal('ghostSign', lettering('ARMAZÉM', 'rgba(235,225,200,.75)', null, 'RIVERTON & CIA'), -0.03, D / 2, D * 0.6, 4, g + s * 2, 'left');
  // The roof: a parapet, a pergola, and the water tower on steel legs.
  roofRing(p, 'blackSteel', 2.3, W - 2.3, 2.3, D - 0.8, top, top + 0.8);
  for (let k = 0; k < 4; k++) p.box('blackSteel', W * 0.55 + k * 1.2, W * 0.55 + k * 1.2 + 0.12, 3, 7, top + 0.8, top + 3.2);
  p.box('blackSteel', W * 0.55, W * 0.55 + 4.2, 3, 7, top + 3.2, top + 3.4);
  const wx = 5, wy = D - 5;
  for (const [dx, dy] of [[-1, -1], [1, -1], [-1, 1], [1, 1]] as const) p.cylinder('blackSteel', wx + dx * 1.2, wy + dy * 1.2, top, top + 4, 0.1);
  p.cylinder('woodDark', wx, wy, top + 4, top + 7.2, 1.7);
  const cap = new ConeGeometry(1.8, 1.4, 12);
  cap.translate(wx, top + 7.9, -wy);
  p.pushRaw('blackSteel', cap);
  for (const x of [1, W - 1]) { p.box('pot', x - 0.5, x + 0.5, -1.6, -0.6, 0, 0.6); p.bush(x, -1.1, 0.6, 0.6); }
};

/** 5. A grand white town hall: a portico of columns with a pediment, a tall clock tower and cupola, corner pavilions, banners and statues. */
const cityHallWhite: Design = (p, W, D, _g) => {
  const H = 1.8 + 4.5 * 3;
  const face = facade('archStone', 3, 4.5, 1.8);
  p.box('stoneLight', 0, W, 0, D, 0, 1.8);
  p.box(face, 0.3, W - 0.3, 0.3, D - 0.3, 1.8, H);
  roofRing(p, 'ivory', -0.2, W + 0.2, -0.2, D + 0.2, H, H + 0.9);
  balustrade(p, 0.4, W - 0.4, 0.3, H + 0.9);
  // Corner pavilions with mansard roofs and oculi.
  for (const [x0, x1] of [[0, W * 0.22], [W * 0.78, W]] as const) {
    p.box('ivory', x0, x1, -0.6, D * 0.5, 0, H + 2.2);
    p.hip('slate', x0 + 0.2, x1 - 0.2, -0.4, D * 0.5 - 0.2, H + 2.2, 4.5, 0.25);
    p.decal('oculus', (gg, w, h) => { gg.fillStyle = '#e6e0d2'; gg.beginPath(); gg.arc(w / 2, h / 2, w / 2 - 2, 0, 7); gg.fill(); gg.fillStyle = '#34424d'; gg.beginPath(); gg.arc(w / 2, h / 2, w / 2 - 10, 0, 7); gg.fill(); }, (x0 + x1) / 2, -0.55, 1.2, 1.2, H + 3.2);
    p.cylinder('patina', (x0 + x1) / 2, D * 0.25 - 0.3, H + 6.7, H + 8.5, 0.1);
  }
  // The portico: six columns, an entablature with lettering, a pediment.
  const c0 = W * 0.27, c1 = W * 0.73;
  colonnade(p, c0, c1, -2.2, 1.8, H - 1.8, 6, 0.55);
  p.box('ivory', c0 - 1, c1 + 1, -3, 0.3, H, H + 1.4);
  p.decal('civitas', lettering('CIDADE · CONCÓRDIA · PROGRESSO', '#5b5446', null), W / 2, -3.02, (c1 - c0) * 0.9, 0.7, H + 0.35);
  p.gable('ivory', c0 - 1.2, c1 + 1.2, -3.2, 0.3, H + 1.4, 4.2, 'x');
  for (let k = 0; k < 3; k++) p.decal('archDoorTall', archDoor, W / 2 + (k - 1) * 3.6, 0.27, 2.4, 4.4, 1.8);
  for (const x of [W / 2 - 5.4, W / 2 + 5.4]) p.decal('bannerCity', banner('UMA CIDADE MAIS FORTE'), x, -2.25, 1.5, 5.5, 4);
  // The clock tower behind the pediment: three stages, clocks, a cupola, a copper dome with a gold ball.
  const tx = W / 2, ty = D * 0.42, t = 3.2;
  p.box('ivory', tx - t, tx + t, ty - t, ty + t, H, H + 10);
  p.box('ivory', tx - t - 0.3, tx + t + 0.3, ty - t - 0.3, ty + t + 0.3, H + 10, H + 10.6);
  p.box('ivory', tx - t + 0.5, tx + t - 0.5, ty - t + 0.5, ty + t - 0.5, H + 10.6, H + 16);
  for (const f of ['front', 'left', 'right'] as const) {
    const [cx, cy] = f === 'front' ? [tx, ty - t + 0.48] : f === 'left' ? [tx - t + 0.48, ty] : [tx + t - 0.48, ty];
    p.decal('clock', clockFace, cx, cy, 3.4, 3.4, H + 11.6, f);
  }
  p.box('ivory', tx - t, tx + t, ty - t, ty + t, H + 16, H + 16.6);
  for (let k = 0; k < 8; k++) { const a = (k / 8) * Math.PI * 2; p.cylinder('ivory', tx + Math.cos(a) * 2, ty + Math.sin(a) * 2, H + 16.6, H + 19.6, 0.22); }
  p.prism('ivory', tx, ty, 2.5, H + 19.6, H + 20.2, 8, Math.PI / 8);
  p.dome('patina', tx, ty, 2.3, H + 20.2, 1.2);
  p.dome('gold', tx, ty, 0.45, H + 20.2 + 2.7, 2);
  // Steps, statues on pedestals, lamps, cypresses.
  p.steps('stoneLight', c0, c1, -6.4, 10, 0.42, 0.18);
  for (const x of [c0 - 1.6, c1 + 1.6]) {
    p.box('stoneLight', x - 1.1, x + 1.1, -6, -3.6, 0, 2.2);
    p.box('ivory', x - 0.6, x + 0.6, -5.2, -4.2, 2.2, 3);
    p.cylinder('ivory', x, -4.7, 3, 4.4, 0.45);
    p.dome('ivory', x, -4.7, 0.35, 4.4, 1.2);
  }
  p.lamp(W / 2 - 3, -6.8, 0, 3.6); p.lamp(W / 2 + 3, -6.8, 0, 3.6);
  for (const x of [1, 3, W - 3, W - 1]) p.cypress(x, -1.6, 5);
};

/** 6. A courthouse: a stone block of tall windows, a portico of four columns under a pediment with the scales, flags, planters. */
const forum: Design = (p, W, D, g, s, upper) => {
  const H = g + (upper - 1) * s;
  p.box(facade('tallStone', 3, H, 0), 0, W, 0, D, 0, H);
  roofRing(p, 'ivory', -0.2, W + 0.2, -0.2, D + 0.2, H, H + 0.8);
  roofRing(p, 'concreteLight', W * 0.3, W * 0.7, D * 0.3, D * 0.7, H, H + 3.5);
  p.box('roofing', W * 0.3, W * 0.7, D * 0.3, D * 0.7, H + 3.4, H + 3.45);
  p.hip('glassRail', W * 0.42, W * 0.58, D * 0.42, D * 0.58, H + 3.5, 1, 0.3);
  const c0 = W * 0.3, c1 = W * 0.7;
  p.box('ivory', c0 - 1.4, c1 + 1.4, -2.6, 0.2, 0, 0.9);
  colonnade(p, c0, c1, -1.8, 0.9, H - 0.9 - 1.6, 4, 0.6);
  p.box('ivory', c0 - 1.6, c1 + 1.6, -2.6, 0.3, H - 1.6, H + 0.8);
  p.decal('forum', lettering('FÓRUM', '#3f3a32', null, 'JUSTIÇA · CIDADANIA · DIREITOS'), W / 2, -2.62, (c1 - c0) + 2, 2, H - 1.5);
  p.gable('ivory', c0 - 1.8, c1 + 1.8, -2.8, 0.3, H + 0.8, 3, 'x');
  p.decal('scales', scales, W / 2, -2.82, 2, 1.6, H + 1.1);
  p.box('podiumGlass', c0 + 0.8, c1 - 0.8, -0.04, 0.02, 0.9, H - 2);
  p.box('gold', c0 + 0.6, c1 - 0.6, -0.07, -0.03, H - 2.1, H - 1.9);
  p.steps('stoneLight', c0 - 0.6, c1 + 0.6, -7, 11, 0.4, 0.08);
  for (const x of [c0 - 0.5, c1 + 0.5]) p.box('lightGrid', x - 0.04, x + 0.04, -7, -2.6, 0.9, 1.9);
  p.flag('br', brazilFlag, 3, -4, 8); p.flag('sp', stripedFlag, 5, -4, 8); p.flag('judiciary', plainFlag('#f2f2f2', '#9a8a5a'), 7, -4, 8);
  for (const [x0, x1] of [[1, c0 - 2], [c1 + 2, W - 1]] as const) {
    p.box('ivory', x0, x1, -4.5, -1.5, 0, 0.9);
    for (let x = x0 + 0.8; x < x1; x += 1.6) p.bush(x, -3, 0.9, 0.55, x % 2 > 1);
  }
  for (const x of [0.8, W - 0.8]) p.cypress(x, -0.8, 6);
};

/** 7. A church: a stone nave under a tiled gable roof, a rose window and arched portal, a bell tower with a tiled dome, an apse. */
const church: Design = (p, W, D) => {
  const face = facade('gothicStone', 3.2, 9, 0);
  const nx0 = W * 0.3, nx1 = W * 0.85, H = 9;
  p.box('stoneLight', nx0 - 6, nx1 + 3.5, -0.4, D * 0.85, 0, 0.6);
  p.box('gravel', nx0 - 2, nx1 + 2, -4.5, -0.4, 0, 0.04);
  p.box(face, nx0, nx1, 0, D * 0.8, 0.6, H);
  p.gable('roofTerracotta', nx0 - 0.4, nx1 + 0.4, 0, D * 0.8, H, 5.5, 'y');
  // The front: the gable end in stone, a rose window, the portal with its stepped arch.
  p.gable('stoneLight', nx0, nx1, -0.3, 0.05, H, 5.5, 'y');
  p.decal('rose', roseWindow, (nx0 + nx1) / 2, -0.32, 3.4, 3.4, H - 1);
  p.box('stoneLight', (nx0 + nx1) / 2 - 2.4, (nx0 + nx1) / 2 + 2.4, -1.2, 0, 0.6, 6.4);
  p.decal('portal', archDoor, (nx0 + nx1) / 2, -1.22, 3.6, 5.2, 0.6);
  p.box('stoneLight', (nx0 + nx1) / 2 - 0.15, (nx0 + nx1) / 2 + 0.15, -0.35, -0.05, H + 5.5, H + 7.6);
  p.box('stoneLight', (nx0 + nx1) / 2 - 0.7, (nx0 + nx1) / 2 + 0.7, -0.35, -0.05, H + 6.6, H + 6.9);
  // The transept and the apse with its conical roof.
  p.box(face, nx0 - 3, nx1 + 3, D * 0.45, D * 0.62, 0.6, H - 1.5);
  p.gable('roofTerracotta', nx0 - 3.2, nx1 + 3.2, D * 0.45, D * 0.62, H - 1.5, 3, 'x');
  const ax = (nx0 + nx1) / 2, ay = D * 0.8, ar = (nx1 - nx0) / 2 - 0.3;
  p.prism(face, ax, ay, ar, 0.6, H - 1, 8, Math.PI / 8);
  const apse = new ConeGeometry(ar + 0.4, 3.5, 8, 1, false, Math.PI / 8);
  apse.translate(ax, H - 1 + 1.75, -ay);
  p.pushRaw('roofTerracotta', apse);
  // The bell tower: stages, open arches with bells, a tiled dome and a cross.
  const tx = nx0 - 3, ty = 2.5, t = 2.6;
  p.box(face, tx - t, tx + t, ty - t, ty + t, 0.6, 17);
  p.box('stoneLight', tx - t - 0.25, tx + t + 0.25, ty - t - 0.25, ty + t + 0.25, 12, 12.4);
  for (const f of ['front', 'left', 'right'] as const) {
    const [cx, cy] = f === 'front' ? [tx, ty - t - 0.02] : f === 'left' ? [tx - t - 0.02, ty] : [tx + t + 0.02, ty];
    p.decal('belfryChurch', archOpening, cx, cy, 2 * t - 0.8, 3.4, 12.7, f);
  }
  p.cylinder('gold', tx, ty - t + 0.6, 13.6, 15, 0.55);
  p.box('stoneLight', tx - t - 0.3, tx + t + 0.3, ty - t - 0.3, ty + t + 0.3, 17, 17.6);
  p.prism('stoneLight', tx, ty, t * 1.1, 17.6, 18.8, 8, Math.PI / 8);
  p.dome('roofTerracotta', tx, ty, t * 1.05, 18.8, 0.9);
  p.box('stoneLight', tx - 0.12, tx + 0.12, ty - 0.12, ty + 0.12, 18.8 + t * 0.9, 18.8 + t * 0.9 + 2.2);
  p.box('stoneLight', tx - 0.6, tx + 0.6, ty - 0.12, ty + 0.12, 18.8 + t * 0.9 + 1.4, 18.8 + t * 0.9 + 1.7);
  // The forecourt: steps, lamps, gardens and cypresses.
  p.steps('stoneLight', nx0 - 1, nx1 + 1, -4, 4, 0.5, 0.15);
  p.lamp(nx0 - 1.5, -3.2, 0.6); p.lamp(nx1 + 1.5, -3.2, 0.6);
  for (const [x, y] of [[1, -2], [W - 1, 2], [W - 1.5, D * 0.6], [1.5, D * 0.7]] as const) p.cypress(x, y, 5, 0.6);
  for (let k = 0; k < 6; k++) p.bush(1 + k * 0.9, D * 0.3, 0.6, 0.5, k % 2 === 0);
};

/** 8. A bank: a stone block, a portico of four fluted columns under a pediment with its name, gold doors, a banner, planters. */
const bank: Design = (p, W, D, g, s, upper) => {
  const H = g + (upper - 1) * s;
  p.box(facade('tallStone', 2.6, H, 0), 0, W, 0, D, 0, H);
  roofRing(p, 'ivory', -0.3, W + 0.3, -0.3, D + 0.3, H, H + 0.9);
  p.box('concreteLight', W * 0.3, W * 0.7, D * 0.35, D * 0.75, H, H + 2.6);
  for (const x of [W * 0.35, W * 0.5, W * 0.62]) p.box('metal', x - 0.6, x + 0.6, D * 0.25, D * 0.3, H, H + 1.1);
  const c0 = W * 0.2, c1 = W * 0.8;
  colonnade(p, c0, c1, -2, 0.8, H - 0.8 - 1.8, 4, 0.7);
  p.box('ivory', c0 - 1.2, c1 + 1.2, -3, 0.3, H - 1.8, H + 0.9);
  p.decal('bankFrieze', lettering('ESTABILIDADE · CONFIANÇA · PROGRESSO', '#4b453a', null), W / 2, -3.02, c1 - c0, 0.6, H - 1.2);
  p.gable('ivory', c0 - 1.4, c1 + 1.4, -3.2, 0.3, H + 0.9, 3.4, 'x');
  p.decal('bankName', lettering('BANCO', '#3a352c', null), W / 2, -3.22, 6, 1.6, H + 1.1);
  p.box('podiumGlass', c0 + 1.2, c1 - 1.2, -0.04, 0.02, 0.8, H - 2.2);
  p.box('gold', W / 2 - 1.6, W / 2 + 1.6, -0.08, -0.03, 0.8, 3.8);
  p.decal('bankBanner', banner('UM AMANHÃ MAIS FORTE'), -0.03, D * 0.35, 1.8, 6, 3, 'left');
  for (const x of [c0 + 0.9, c1 - 0.9]) p.box('sconce', x - 0.15, x + 0.15, -1.2, -1.0, 3, 4);
  p.steps('stoneLight', c0, c1, -5.5, 5, 0.5, 0.16);
  for (const x of [c0 - 1.6, c1 + 1.6, 1.2, W - 1.2]) { p.box('ivory', x - 0.8, x + 0.8, -3, -1.4, 0, 0.8); p.cypress(x, -2.2, 2.6, 0.8); }
};

/** 9. A school: two storeys of brick with white-framed windows, a stone entrance with a clock and its name, a flag, a playground. */
const school: Design = (p, W, D, g, s) => {
  const H = g + s + 0.6;
  const face = facade('schoolBrick', 3, s, 0);
  p.box('lawn', 0, W, -6, D, 0, 0.05);
  p.box(face, 0, W * 0.42, 0, D * 0.55, 0, H);
  p.box(face, W * 0.58, W, 0, D * 0.55, 0, H);
  p.box(face, W * 0.2, W * 0.8, D * 0.55, D * 0.85, 0, H);
  p.box(face, W * 0.42, W * 0.58, 0.5, D * 0.6, 0, H + 1.2);
  for (const [x0, x1] of [[0, W * 0.42], [W * 0.58, W]] as const) roofRing(p, 'ivory', x0 - 0.1, x1 + 0.1, -0.1, D * 0.55 + 0.1, H, H + 0.4);
  p.box('ivory', W * 0.42, W * 0.58, -0.5, 0.6, 0, H + 2.4);
  p.decal('clock', clockFace, W / 2, -0.52, 1.6, 1.6, H + 0.4);
  p.decal('school', lettering('ESCOLA', '#3d342b', null, 'PÚBLICA RIVERSIDE'), W / 2, -0.52, W * 0.14, 1.6, H - 1.6);
  p.windowFront(W / 2 - 1.8, W / 2 + 1.8, -0.52, g, H - 1.8, 2);
  p.box('ivory', W / 2 - 2.6, W / 2 + 2.6, -3, -0.5, 3.3, 3.6);
  for (const x of [W / 2 - 2.3, W / 2 + 2.3]) p.cylinder('ivory', x, -2.7, 0.6, 3.3, 0.25);
  p.windowFront(W / 2 - 1.4, W / 2 + 1.4, -0.52, 0.6, 3, 1);
  p.steps('stoneLight', W / 2 - 2.6, W / 2 + 2.6, -4.6, 4, 0.4, 0.15);
  p.box('glassRail', W * 0.44, W * 0.56, D * 0.25, D * 0.4, H + 1.2, H + 1.25);
  p.hip('glassRail', W * 0.44, W * 0.56, D * 0.25, D * 0.4, H + 1.2, 1.2, 0.3);
  for (const [x, y] of [[W * 0.2, D * 0.3], [W * 0.8, D * 0.3], [W * 0.5, D * 0.75]] as const) p.box('metal', x - 1.2, x + 1.2, y - 0.8, y + 0.8, H + 0.4, H + 1.5);
  p.flag('brSchool', brazilFlag, W * 0.3, -4, 8);
  p.box('brickRed', 2, 8, -5.5, -4.7, 0, 1.4);
  p.decal('schoolSign', lettering('ESCOLA', '#f2ead8', null, 'RIVERSIDE'), 5, -5.52, 5.6, 1.2, 0.1);
  // The playground behind a fence: a frame, a slide, a court.
  const px = W * 0.86, py = D * 0.7;
  p.box('gravel', W * 0.8, W, D * 0.55, D * 0.95, 0, 0.06);
  p.box('blueSteel', px - 1, px + 1, py - 1, py + 1, 2.2, 2.4);
  for (const [dx, dy] of [[-1, -1], [1, -1], [-1, 1], [1, 1]] as const) p.box('yellowPaint', px + dx - 0.08, px + dx + 0.08, py + dy - 0.08, py + dy + 0.08, 0, 2.2);
  p.box('blueSteel', px + 1, px + 3, py - 0.4, py + 0.4, 0.4, 0.55);
  for (const x of [3, W * 0.65, W - 2]) p.tree(x, -3, 1.8, 6);
  for (let k = 0; k < 8; k++) p.bush(1.5 + k * 1.2, -0.8, 0, 0.45, k % 2 === 0);
};

/** 10. A fire station: three red bay doors, its name and crests, a red brick command block, a training tower with stairs, an apron. */
const fireStation: Design = (p, W, D, g, s) => {
  const H = g + s;
  const bay = W * 0.62, apron = 10;
  p.box('concreteLight', 0, W, 0, apron, 0, 0.06);
  for (let k = 1; k < 3; k++) p.box('yellowPaint', (k * bay) / 3 - 0.06, (k * bay) / 3 + 0.06, 0.5, apron, 0.06, 0.08);
  p.box('concreteLight', 0, bay, apron, D, 0, H);
  for (let k = 0; k < 3; k++) {
    const x0 = (k * bay) / 3 + 0.6, x1 = ((k + 1) * bay) / 3 - 0.6;
    p.decal(`bayDoor${k}`, garageDoor(String(k + 1)), (x0 + x1) / 2, apron - 0.03, x1 - x0, g + 0.6, 0);
    p.box('yellowPaint', x1 + 0.05, x1 + 0.45, apron - 0.3, apron, 0, 1.4);
  }
  p.decal('bombeiros', lettering('CORPO DE BOMBEIROS', '#333333', null), bay / 2, apron - 0.03, bay * 0.75, 1.2, g + 0.9);
  p.box('brickRed', bay, W, apron + 2, D, 0, H);
  p.box(facade('curtainBlue', 1.5, s, 0), bay + 0.5, W - 4, apron + 1.98, apron + 2.02, g, H - 0.4);
  p.box('redPaint', bay + 0.5, W - 4, apron, apron + 2, g - 0.6, g - 0.2);
  p.decal('comando', lettering('COMANDO', '#ffffff', '#b3262a'), bay + 0.5 + (W - 4.5 - bay) / 2, apron - 0.02, W - 4.5 - bay, 0.4, g - 0.6);
  p.windowFront(bay + 1, bay + 3.2, apron + 1.98, 0, 2.6, 1);
  roofRing(p, 'concreteLight', -0.1, W + 0.1, apron - 0.1, D + 0.1, H, H + 0.5);
  for (let k = 0; k < 4; k++) p.box('darkPanel', 2 + k * 3.4, 5 + k * 3.4, apron + 4, apron + 7, H + 0.5, H + 0.7);
  // The training tower: concrete with a red stripe, landings and stairs on its side.
  const tx = W - 2.5, ty = apron + 1.5, t = 2;
  p.box('concreteLight', tx - t, tx + t, ty - t + 4, ty + t + 4, 0, H + 12);
  p.box('redPaint', tx - 0.4, tx + 0.4, ty - t + 3.95, ty - t + 4, 0, H + 12);
  p.decal('193', lettering('193', '#c62828', null), tx, ty - t + 3.93, 2, 1, H + 8);
  for (let z = 3; z < H + 12; z += 3) { p.box('metal', tx + t, tx + t + 1.4, ty + 2, ty + 6, z, z + 0.1); p.rail(tx + t + 1.38, tx + t + 1.42, ty + 2, ty + 6, z + 0.1); }
  p.rail(tx - t, tx + t, ty + 2, ty + 2.04, H + 12);
  p.cylinder('lightGrid', tx, ty + 4, H + 12, H + 15, 0.05);
  p.decal('windsock', (gg, w, h) => { for (let k = 0; k < 5; k++) { gg.fillStyle = k % 2 ? '#ffffff' : '#e53935'; gg.fillRect((k * w) / 5, h * 0.2, w / 5 + 1, h * 0.6); } }, tx + 0.7, ty + 4, 1.4, 0.5, H + 14.3);
  for (const x of [W * 0.7, W * 0.76, W * 0.82]) p.cylinder('lightGrid', x, apron - 2, 0, 7, 0.05);
  p.box('lawn', bay, W - 5, 1, apron - 3, 0, 0.3);
  for (let k = 0; k < 5; k++) p.bush(bay + 0.8 + k * 1.3, 3, 0.3, 0.6, k % 2 === 0);
  p.box('concreteLight', bay + 1, bay + 4.5, 5.5, 5.8, 0.3, 1.8);
  p.decal('lema', lettering('DISCIPLINA', '#7a1f1f', '#d9d6cf', 'VIDAS MAIS SEGURAS'), bay + 2.75, 5.48, 3.4, 1.4, 0.35);
};

/** 11. A police station: grey concrete, a black central block with the badge and name, louvres, a garage of patrol cars behind a gate. */
const police: Design = (p, W, D, g, s) => {
  const H = g + s;
  p.box('concreteLight', 0, W * 0.72, 3, D, 0, H);
  p.box('concreteLight', W * 0.72, W, 9, D, 0, H - 0.8);
  roofRing(p, 'concreteLight', W * 0.72, W, 9, D, H - 0.8, H - 0.4);
  p.box('blackSteel', W * 0.24, W * 0.5, 2.2, D * 0.6, 0, H + 1.2);
  p.decal('badge', badge, W * 0.37, 2.18, 2.2, 2.6, H - 2.4);
  p.decal('policia', lettering('POLÍCIA CIVIL', '#eeeeee', null), W * 0.37, 2.18, W * 0.24, 0.9, H - 3.4);
  p.box('blackSteel', W * 0.22, W * 0.52, 0, 2.2, g - 0.5, g - 0.2);
  p.decal('lema2', lettering('SEGURANÇA · CIDADANIA · JUSTIÇA', '#ffffff', '#1f2124'), W * 0.37, -0.02, W * 0.3, 0.3, g - 0.5);
  p.windowFront(W * 0.3, W * 0.44, 2.18, 0, g - 0.6, 1);
  for (const x0 of [1.2, W * 0.55]) {
    for (const z of [0.8, g + 0.8]) {
      p.windowFront(x0, x0 + 3.6, 2.98, z, z + 1.8, 1);
      for (let k = 0; k < 4; k++) p.box('blackSteel', x0, x0 + 3.6, 2.6, 2.98, z + 1.9 + k * 0.12, z + 1.96 + k * 0.12);
    }
  }
  for (const x of [W * 0.24, W * 0.5]) for (const z of [2, g + 2]) p.box('sconce', x - 0.08, x + 0.08, 2.05, 2.15, z, z + 0.3);
  // The garage for the patrol cars and its sliding gate.
  p.box('blackSteel', W * 0.72, W, 5, 9, g - 0.4, g);
  p.decal('viaturas', lettering('VIATURAS ›››', '#ffffff', '#1f2124'), W * 0.86, 4.98, W * 0.26, 0.4, g - 0.4);
  p.box('asphalt', W * 0.72, W, 0, 9, 0, 0.05);
  for (const x of [W * 0.78, W * 0.92]) {
    p.box('blackSteel', x - 0.9, x + 0.9, 6, 10.4, 0.3, 1.3);
    p.box('white', x - 0.92, x + 0.92, 6.6, 9.6, 0.6, 1.0);
    p.box('blackSteel', x - 0.8, x + 0.8, 7, 9.4, 1.3, 1.9);
  }
  p.rail(W * 0.72, W - 0.4, 0.2, 0.24, 0, 2);
  p.box('concreteLight', W - 0.8, W, 0, 0.8, 0, 2.4);
  p.decal('190', lettering('190', '#222222', '#d0cdc6'), W - 0.4, -0.02, 0.6, 0.4, 1.4);
  // Roof plant and the radio mast; flags and planters in front.
  roofRing(p, 'concreteLight', -0.1, W * 0.72 + 0.1, 2.9, D + 0.1, H, H + 0.5);
  p.box('darkPanel', W * 0.3, W * 0.42, D * 0.6, D * 0.8, H + 0.5, H + 2);
  for (const x of [W * 0.55, W * 0.6]) p.box('metal', x, x + 1, D * 0.5, D * 0.5 + 0.8, H + 0.5, H + 1.4);
  p.cylinder('lightGrid', W * 0.62, D * 0.75, H + 0.5, H + 14, 0.1);
  p.flag('sp2', stripedFlag, 1.5, -1, 7); p.flag('br2', brazilFlag, 3.2, -1, 7.6); p.flag('pc', plainFlag('#1d1f22', '#c9a54a'), 4.9, -1, 7);
  p.box('concreteLight', 0.5, W * 0.2, -1.8, -0.4, 0, 1.2);
  p.decal('servir', lettering('SERVIR · PROTEGER', '#333333', null), W * 0.1 + 0.25, -1.82, W * 0.18, 0.6, 0.4);
  for (let k = 0; k < 6; k++) p.bush(W * 0.24 + k * 1.2, 0.6, 0, 0.5, k % 2 === 0);
};

/** 13. A cemetery: a stone wall with iron railings and an iron gate, gravel paths, hedged plots of graves, mausoleums, cypresses, a chapel. */
const cemetery: Design = (p, W, D) => {
  p.box('gravel', 0, W, 0, D, 0, 0.05);
  // The wall: stone piers, a low wall and railings, the gate with lanterns.
  const gateW = 4;
  for (const [a, b, y] of [[0, W / 2 - gateW / 2, 0], [W / 2 + gateW / 2, W, 0], [0, W, D]] as const) {
    p.box('stoneLight', a, b, y - 0.3, y + 0.3, 0, 0.9);
    p.rail(a, b, y - 0.05, y + 0.05, 0.9, 1.3);
    for (let x = a; x <= b + 0.01; x += 4) p.box('stoneLight', x - 0.4, x + 0.4, y - 0.4, y + 0.4, 0, 2.4);
  }
  for (const x of [0, W]) {
    p.box('stoneLight', x - 0.3, x + 0.3, 0, D, 0, 0.9);
    p.rail(x - 0.05, x + 0.05, 0, D, 0.9, 1.3);
    for (let y = 0; y <= D + 0.01; y += 4) p.box('stoneLight', x - 0.4, x + 0.4, y - 0.4, y + 0.4, 0, 2.4);
  }
  for (const x of [W / 2 - gateW / 2, W / 2 + gateW / 2]) { p.box('stoneLight', x - 0.6, x + 0.6, -0.6, 0.6, 0, 3.2); p.box('sconce', x - 0.2, x + 0.2, -0.2, 0.2, 3.2, 3.7); }
  p.decal('gate', ironGate, W / 2, 0, gateW - 1.2, 3, 0);
  p.box('concreteLight', W / 2 - 2, W / 2 + 2, -3, 0, 0, 0.08);
  // Plots: hedged beds of graves either side of the paths.
  const plots: [number, number, number, number][] = [];
  for (const [x0, x1] of [[1.5, W / 2 - 2.5], [W / 2 + 2.5, W - 1.5]] as const) {
    for (let y = 2; y + 5 < D * 0.65; y += 6.5) plots.push([x0, x1, y, y + 5]);
  }
  for (const [x0, x1, y0, y1] of plots) {
    p.box('lawn', x0, x1, y0, y1, 0.05, 0.12);
    p.box('leafDark', x0, x1, y0 - 0.25, y0, 0, 0.6);
    p.box('leafDark', x0, x1, y1, y1 + 0.25, 0, 0.6);
    for (let x = x0 + 0.8; x < x1 - 0.5; x += 1.6) {
      for (const y of [y0 + 1.2, y0 + 3.4]) {
        p.box('stoneLight', x - 0.45, x + 0.45, y, y + 1.6, 0.12, 0.35);
        if ((Math.floor(x) + Math.floor(y)) % 3 === 0) { p.box('stoneLight', x - 0.08, x + 0.08, y - 0.05, y + 0.1, 0.35, 1.4); p.box('stoneLight', x - 0.35, x + 0.35, y - 0.05, y + 0.1, 1.0, 1.15); }
        else p.box('stoneLight', x - 0.4, x + 0.4, y - 0.1, y + 0.1, 0.35, 1.1);
      }
    }
  }
  // A central monument with a cross, cypresses along the paths, trees in the corners, benches.
  p.box('stoneLight', W / 2 - 1, W / 2 + 1, D * 0.4 - 1, D * 0.4 + 1, 0, 1);
  p.box('stoneLight', W / 2 - 0.15, W / 2 + 0.15, D * 0.4 - 0.15, D * 0.4 + 0.15, 1, 4);
  p.box('stoneLight', W / 2 - 0.8, W / 2 + 0.8, D * 0.4 - 0.15, D * 0.4 + 0.15, 3, 3.3);
  for (let y = 3; y < D * 0.7; y += 5) { p.cypress(W / 2 - 1.8, y, 5); p.cypress(W / 2 + 1.8, y, 5); }
  for (const [x, y] of [[2, 2], [W - 2, 2], [2, D - 2], [W - 2.5, D * 0.6]] as const) p.tree(x, y, 2.2, 7);
  for (const x of [W / 2 - 3, W / 2 + 3]) p.box('stoneLight', x - 0.8, x + 0.8, D * 0.4 - 0.25, D * 0.4 + 0.25, 0, 0.45);
  // Mausoleums and the chapel at the back.
  for (const x of [W * 0.2, W * 0.8]) {
    p.box('stoneLight', x - 1.5, x + 1.5, D * 0.72, D * 0.72 + 3, 0, 2.8);
    p.gable('stoneLight', x - 1.7, x + 1.7, D * 0.72 - 0.2, D * 0.72 + 3.2, 2.8, 1, 'y');
    p.box('woodDark', x - 0.5, x + 0.5, D * 0.72 - 0.03, D * 0.72, 0, 2);
  }
  const cx = W / 2, cy0 = D * 0.72, cy1 = D - 1.5;
  p.box(facade('gothicStone', 2.4, 6, 0), cx - 3, cx + 3, cy0, cy1, 0, 6);
  p.gable('slate', cx - 3.3, cx + 3.3, cy0 - 0.2, cy1 + 0.2, 6, 3.8, 'y');
  p.gable('stoneLight', cx - 3, cx + 3, cy0 - 0.25, cy0, 6, 3.8, 'y');
  p.decal('chapelDoor', archDoor, cx, cy0 - 0.27, 2, 3.4, 0);
  p.box('stoneLight', cx - 0.7, cx + 0.7, cy0 - 0.3, cy0 + 1, 9.8, 12);
  p.hip('slate', cx - 0.9, cx + 0.9, cy0 - 0.5, cy0 + 1.2, 12, 2.2, 0);
  p.box('stoneLight', cx - 0.08, cx + 0.08, cy0 + 0.3, cy0 + 0.46, 14.2, 15.6);
  p.box('stoneLight', cx - 0.4, cx + 0.4, cy0 + 0.3, cy0 + 0.46, 15, 15.2);
  p.steps('stoneLight', cx - 1.5, cx + 1.5, cy0 - 1.5, 3, 0.5, 0.15);
};

const DESIGNS: Partial<Record<string, Design>> = {
  balconyMid,
  ...Object.fromEntries(Object.entries(LOOKS).map(([kind, look]) => [kind, towerOf(look)])),
  twistGreen, hexTerracotta, stepGarden, waveWhite, cubeBalcony, twinNavy, octCopper, stackedBlocks, pinkCorner, triangleDark,
  cityHallBrick, decoSpire, hospitalA, loftBrick, cityHallWhite, forum, church, bank, school, fireStation, police, hospitalB, cemetery,
  ...LANDMARKS,
};

/** Whether this module draws the building's body. */
export function drawsSignature(b: Building): boolean {
  const kind = signatureKind(b);
  return kind !== null && DESIGNS[kind] !== undefined;
}

/**
 * The body of a signature building, placed in the world: `floor` is the
 * height of its ground floor (world units), as the generic body would stand.
 */
export function buildSignature(b: Building, floor: number): Group | null {
  const kind = signatureKind(b);
  const design = kind ? DESIGNS[kind] : undefined;
  if (!design) return null;
  materials ??= makeMaterials();
  const U = m(1);
  const closed = b.volumes.filter((v) => !v.open);
  if (!closed.length) return null;
  const base = closed.filter((v) => v.base === 0).sort((p, q) => q.w * q.d - p.w * p.d)[0] ?? closed[0]!;
  const levels = Math.max(...closed.map((v) => v.base + v.storeys.length));
  const parts = new Parts();
  design(parts, base.w / U, base.d / U, b.groundHeight / U, b.storeyHeight / U, Math.max(1, levels - 1));
  const group = new Group();
  group.name = `signature-${b.id}`;
  for (const [mat, list] of parts.byMat) {
    const merged = mergeGeometries(list, false);
    for (const g of list) g.dispose();
    if (!merged) continue;
    merged.scale(U, U, U);
    merged.computeBoundingSphere();
    const mesh = new Mesh(merged, materials[mat] ?? facades.get(mat)!);
    mesh.castShadow = mat !== 'glass' && mat !== 'sconce';
    mesh.receiveShadow = true;
    mesh.name = `signature-${mat}`;
    group.add(mesh);
  }
  // The body's frame: the base block's corner, in the building's frame, in the world.
  group.position.set(b.x, floor, -b.y);
  group.rotation.y = b.rotation;
  const inner = new Group();
  inner.position.set(base.x, 0, -base.y);
  inner.add(...group.children);
  group.add(inner);
  group.updateMatrixWorld(true);
  return group;
}

export function disposeSignature(group: Group): void {
  group.traverse((o) => { if ((o as Mesh).isMesh) (o as Mesh).geometry.dispose(); });
}
