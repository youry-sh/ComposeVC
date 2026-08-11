import fs from 'fs'

const path = 'C:\\Users\\youry\\Documents\\break\\Excalidraw\\Схема питания YouTube.excalidraw.md'

function id() {
  return Math.random().toString(16).slice(2, 11)
}
function seed() {
  return Math.floor(Math.random() * 2e9)
}

const now = Date.now()
const els = []

function rect(x, y, w, h, bg, stroke) {
  const e = {
    id: id(),
    type: 'rectangle',
    x,
    y,
    width: w,
    height: h,
    angle: 0,
    strokeColor: stroke || '#cdd6f4',
    backgroundColor: bg || 'transparent',
    fillStyle: 'solid',
    strokeWidth: 2,
    strokeStyle: 'solid',
    roughness: 0,
    opacity: 100,
    groupIds: [],
    frameId: null,
    roundness: { type: 3 },
    seed: seed(),
    version: 1,
    versionNonce: seed(),
    isDeleted: false,
    boundElements: null,
    updated: now,
    link: null,
    locked: false,
  }
  els.push(e)
  return e
}

function text(x, y, t, size, color, align = 'center', w) {
  const fontSize = size || 20
  const width = w || Math.max(40, t.length * fontSize * 0.58)
  const height = fontSize * 1.25 * (String(t).split('\n').length)
  const e = {
    id: id(),
    type: 'text',
    x,
    y,
    width,
    height,
    angle: 0,
    strokeColor: color || '#cdd6f4',
    backgroundColor: 'transparent',
    fillStyle: 'solid',
    strokeWidth: 1,
    strokeStyle: 'solid',
    roughness: 0,
    opacity: 100,
    groupIds: [],
    frameId: null,
    roundness: null,
    seed: seed(),
    version: 1,
    versionNonce: seed(),
    isDeleted: false,
    boundElements: null,
    updated: now,
    link: null,
    locked: false,
    text: t,
    fontSize,
    fontFamily: 2,
    textAlign: align,
    verticalAlign: 'middle',
    containerId: null,
    originalText: t,
    autoResize: true,
    lineHeight: 1.25,
  }
  els.push(e)
  return e
}

function arrow(points, stroke, startId, endId) {
  const xs = points.map((p) => p[0])
  const ys = points.map((p) => p[1])
  const minX = Math.min(...xs)
  const minY = Math.min(...ys)
  const maxX = Math.max(...xs)
  const maxY = Math.max(...ys)
  const norm = points.map((p) => [p[0] - minX, p[1] - minY])
  const e = {
    id: id(),
    type: 'arrow',
    x: minX,
    y: minY,
    width: Math.max(1, maxX - minX),
    height: Math.max(1, maxY - minY),
    angle: 0,
    strokeColor: stroke || '#89b4fa',
    backgroundColor: 'transparent',
    fillStyle: 'solid',
    strokeWidth: 3,
    strokeStyle: 'solid',
    roughness: 0,
    opacity: 100,
    groupIds: [],
    frameId: null,
    roundness: { type: 2 },
    seed: seed(),
    version: 1,
    versionNonce: seed(),
    isDeleted: false,
    boundElements: null,
    updated: now,
    link: null,
    locked: false,
    points: norm,
    lastCommittedPoint: null,
    startBinding: startId ? { elementId: startId, focus: 0, gap: 8 } : null,
    endBinding: endId ? { elementId: endId, focus: 0, gap: 8 } : null,
    startArrowhead: null,
    endArrowhead: 'arrow',
  }
  els.push(e)
  return e
}

function line(points, stroke, sw) {
  const xs = points.map((p) => p[0])
  const ys = points.map((p) => p[1])
  const minX = Math.min(...xs)
  const minY = Math.min(...ys)
  const maxX = Math.max(...xs)
  const maxY = Math.max(...ys)
  const norm = points.map((p) => [p[0] - minX, p[1] - minY])
  const e = {
    id: id(),
    type: 'line',
    x: minX,
    y: minY,
    width: Math.max(1, maxX - minX),
    height: Math.max(1, maxY - minY),
    angle: 0,
    strokeColor: stroke || '#6c7086',
    backgroundColor: 'transparent',
    fillStyle: 'solid',
    strokeWidth: sw || 2,
    strokeStyle: 'solid',
    roughness: 0,
    opacity: 100,
    groupIds: [],
    frameId: null,
    roundness: { type: 2 },
    seed: seed(),
    version: 1,
    versionNonce: seed(),
    isDeleted: false,
    boundElements: null,
    updated: now,
    link: null,
    locked: false,
    points: norm,
    lastCommittedPoint: null,
    startBinding: null,
    endBinding: null,
    startArrowhead: null,
    endArrowhead: null,
  }
  els.push(e)
  return e
}

const bg = rect(-80, -120, 1680, 980, '#11111b', '#313244')
bg.strokeWidth = 1

text(300, -95, 'POWER SUPPLY SCHEMATIC', 40, '#cba6f7', 'center', 900)
text(420, -42, 'Схема питания  ·  для YouTube-ролика', 18, '#a6adc8', 'center', 700)

text(40, 18, 'INPUT', 13, '#f9e2af', 'left', 80)
text(520, 18, 'CONVERSION', 13, '#89b4fa', 'left', 140)
text(1080, 18, 'OUTPUTS', 13, '#a6e3a1', 'left', 100)

const ac = rect(40, 70, 160, 110, '#45475a', '#f9e2af')
text(55, 95, 'AC 220V', 26, '#f9e2af', 'center', 130)
text(60, 135, '50 / 60 Hz', 16, '#a6adc8', 'center', 120)

const fuse = rect(260, 85, 120, 80, '#313244', '#fab387')
text(275, 100, 'FU1', 18, '#fab387', 'center', 90)
text(270, 130, 'Fuse', 14, '#cdd6f4', 'center', 100)

const sw = rect(430, 85, 120, 80, '#313244', '#f38ba8')
text(445, 100, 'SW1', 18, '#f38ba8', 'center', 90)
text(440, 130, 'Switch', 14, '#cdd6f4', 'center', 100)

const emi = rect(600, 85, 140, 80, '#1e1e2e', '#89b4fa')
text(620, 100, 'EMI FILTER', 16, '#89b4fa', 'center', 100)
text(615, 130, 'L + C + Y', 14, '#a6adc8', 'center', 110)

const bridge = rect(790, 70, 150, 110, '#1e1e2e', '#74c7ec')
text(805, 90, 'BRIDGE', 18, '#74c7ec', 'center', 120)
text(810, 120, 'RECTIFIER', 16, '#74c7ec', 'center', 110)
text(810, 148, 'AC  →  DC', 15, '#cdd6f4', 'center', 110)

const cap = rect(990, 85, 130, 80, '#1e1e2e', '#cba6f7')
text(1005, 100, 'Cin', 18, '#cba6f7', 'center', 100)
text(1000, 130, '400V 100µF', 13, '#a6adc8', 'center', 110)

arrow(
  [
    [200, 125],
    [255, 125],
  ],
  '#f9e2af',
  ac.id,
  fuse.id,
)
arrow(
  [
    [380, 125],
    [425, 125],
  ],
  '#fab387',
  fuse.id,
  sw.id,
)
arrow(
  [
    [550, 125],
    [595, 125],
  ],
  '#f38ba8',
  sw.id,
  emi.id,
)
arrow(
  [
    [740, 125],
    [785, 125],
  ],
  '#89b4fa',
  emi.id,
  bridge.id,
)
arrow(
  [
    [940, 125],
    [985, 125],
  ],
  '#74c7ec',
  bridge.id,
  cap.id,
)

text(990, 50, '~ 310V DC', 14, '#cba6f7', 'center', 100)

const dcdc = rect(520, 260, 280, 160, '#181825', '#89b4fa')
dcdc.strokeWidth = 3
text(560, 280, 'DC-DC CONVERTER', 20, '#89b4fa', 'center', 200)
text(555, 315, 'Flyback / Buck', 16, '#cdd6f4', 'center', 210)
text(560, 350, 'PWM  ·  65–100 kHz', 14, '#a6adc8', 'center', 200)
text(575, 380, 'Feedback + Opto', 14, '#a6e3a1', 'center', 180)

arrow(
  [
    [1055, 165],
    [1055, 340],
    [800, 340],
  ],
  '#cba6f7',
  cap.id,
  dcdc.id,
)

const xfmr = rect(860, 290, 100, 100, '#1e1e2e', '#f5c2e7')
text(875, 310, 'T1', 20, '#f5c2e7', 'center', 70)
text(870, 345, 'ISO', 14, '#a6adc8', 'center', 80)
text(865, 365, 'Xformer', 12, '#6c7086', 'center', 90)

const ic = rect(400, 300, 90, 80, '#1e1e2e', '#f9e2af')
text(415, 320, 'IC1', 18, '#f9e2af', 'center', 60)
text(410, 350, 'PWM', 14, '#a6adc8', 'center', 70)

const fb = rect(400, 450, 120, 60, '#1e1e2e', '#a6e3a1')
text(415, 460, 'FB / TL431', 14, '#a6e3a1', 'center', 90)
text(420, 485, 'Optocoupler', 12, '#6c7086', 'center', 80)

arrow(
  [
    [490, 340],
    [515, 340],
  ],
  '#f9e2af',
  ic.id,
  dcdc.id,
)
arrow(
  [
    [460, 450],
    [460, 385],
  ],
  '#a6e3a1',
  fb.id,
  ic.id,
)

const y0 = 260
const outs = [
  { label: '+12V', sub: '5A  ·  main', color: '#a6e3a1', bg: '#1a2e1a', y: y0 },
  { label: '+5V', sub: '3A  ·  logic', color: '#89b4fa', bg: '#1a2233', y: y0 + 110 },
  { label: '+3.3V', sub: '2A  ·  MCU', color: '#74c7ec', bg: '#152030', y: y0 + 220 },
  { label: 'GND', sub: 'common', color: '#6c7086', bg: '#1e1e2e', y: y0 + 330 },
]

const outBoxes = outs.map((o) => {
  const r = rect(1180, o.y, 160, 90, o.bg, o.color)
  r.strokeWidth = 3
  text(1200, o.y + 18, o.label, 28, o.color, 'center', 120)
  text(1200, o.y + 55, o.sub, 13, '#a6adc8', 'center', 120)
  return r
})

const ldo = rect(1000, 470, 120, 70, '#1e1e2e', '#74c7ec')
text(1015, 485, 'LDO', 18, '#74c7ec', 'center', 90)
text(1010, 515, '5->3.3V', 14, '#a6adc8', 'center', 100)

const buck = rect(1000, 360, 120, 70, '#1e1e2e', '#89b4fa')
text(1015, 375, 'BUCK', 18, '#89b4fa', 'center', 90)
text(1010, 405, '12->5V', 14, '#a6adc8', 'center', 100)

arrow(
  [
    [800, 300],
    [1175, 300],
  ],
  '#a6e3a1',
  dcdc.id,
  outBoxes[0].id,
)
arrow(
  [
    [800, 340],
    [995, 395],
  ],
  '#89b4fa',
  dcdc.id,
  buck.id,
)
arrow(
  [
    [1120, 395],
    [1175, 415],
  ],
  '#89b4fa',
  buck.id,
  outBoxes[1].id,
)
arrow(
  [
    [1120, 450],
    [1060, 470],
  ],
  '#74c7ec',
  buck.id,
  ldo.id,
)
arrow(
  [
    [1120, 505],
    [1175, 525],
  ],
  '#74c7ec',
  ldo.id,
  outBoxes[2].id,
)
arrow(
  [
    [800, 400],
    [1175, 635],
  ],
  '#6c7086',
  dcdc.id,
  outBoxes[3].id,
)

const prot = rect(40, 260, 300, 200, '#1e1e2e', '#f38ba8')
text(70, 280, 'PROTECTION', 20, '#f38ba8', 'center', 240)
text(60, 320, '• OVP  over-voltage', 15, '#cdd6f4', 'left', 260)
text(60, 350, '• OCP  over-current', 15, '#cdd6f4', 'left', 260)
text(60, 380, '• OTP  over-temp', 15, '#cdd6f4', 'left', 260)
text(60, 410, '• SCP  short-circuit', 15, '#cdd6f4', 'left', 260)

const load = rect(1180, 70, 160, 110, '#181825', '#f5c2e7')
text(1200, 90, 'LOAD', 16, '#f5c2e7', 'center', 120)
text(1195, 120, 'MCU · Sensors', 13, '#a6adc8', 'center', 130)
text(1200, 145, 'Motors · LEDs', 13, '#a6adc8', 'center', 120)

line(
  [
    [1260, 160],
    [1260, 255],
  ],
  '#f5c2e7',
  2,
)

rect(40, 720, 1300, 90, '#181825', '#313244')
text(60, 740, 'Legend:', 16, '#cdd6f4', 'left', 100)
text(180, 740, '■ AC input', 15, '#f9e2af', 'left', 120)
text(340, 740, '■ Power stage', 15, '#89b4fa', 'left', 150)
text(530, 740, '■ Regulators', 15, '#74c7ec', 'left', 130)
text(700, 740, '■ DC rails', 15, '#a6e3a1', 'left', 130)
text(880, 740, '■ Protection', 15, '#f38ba8', 'left', 100)
text(
  60,
  775,
  'Energy flow:  AC 220V  →  rectify  →  DC-DC  →  12V / 5V / 3.3V rails  →  load',
  15,
  '#a6adc8',
  'left',
  1200,
)

line(
  [
    [40, 10],
    [1340, 10],
  ],
  '#cba6f7',
  3,
)
line(
  [
    [40, 810],
    [1340, 810],
  ],
  '#313244',
  2,
)

rect(1380, 70, 140, 50, '#313244', '#f9e2af')
text(1395, 85, 'INPUT 220V', 14, '#f9e2af', 'center', 110)
rect(1380, 140, 140, 50, '#313244', '#a6e3a1')
text(1395, 155, 'EFF >= 85%', 14, '#a6e3a1', 'center', 110)
rect(1380, 210, 140, 50, '#313244', '#89b4fa')
text(1400, 225, 'ISO 3kV', 14, '#89b4fa', 'center', 100)

const scene = {
  type: 'excalidraw',
  version: 2,
  source: 'https://github.com/zsviczian/obsidian-excalidraw-plugin/releases/tag/2.16.1',
  elements: els,
  appState: {
    gridSize: null,
    viewBackgroundColor: '#11111b',
    currentItemStrokeColor: '#cdd6f4',
    currentItemBackgroundColor: 'transparent',
    currentItemFillStyle: 'solid',
    currentItemStrokeWidth: 2,
    currentItemRoughness: 0,
    currentItemOpacity: 100,
    currentItemFontFamily: 2,
    currentItemFontSize: 20,
    scrollX: 120,
    scrollY: 160,
    zoom: { value: 0.75 },
  },
  files: {},
}

const md = [
  '---',
  '',
  'excalidraw-plugin: parsed',
  'tags: [excalidraw]',
  '',
  '---',
  '==⚠  Switch to EXCALIDRAW VIEW in the MORE OPTIONS menu of this document. ⚠==',
  '',
  '',
  '## Drawing',
  '```json',
  JSON.stringify(scene),
  '```',
  '%%',
  '',
].join('\n')

fs.writeFileSync(path, md, 'utf8')
console.log('written', path, 'elements', els.length, 'bytes', md.length)
