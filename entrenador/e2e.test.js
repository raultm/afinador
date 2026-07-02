// Test end-to-end: ejecuta el código REAL de la página (pitch.js + script de
// index.html) en Node con DOM simulado, sintetiza melodías conocidas y
// comprueba lo que detecta el pipeline completo.
const vm = require('vm');
const fs = require('fs');

function stubEl() {
  return {
    addEventListener() {}, appendChild() {}, click() {},
    style: {}, classList: { toggle() {} },
    textContent: '', value: '', innerHTML: '', hidden: false, files: [],
  };
}
const ctx = {
  document: {
    getElementById: () => stubEl(),
    querySelectorAll: () => [],
    createElement: () => stubEl(),
  },
  window: { addEventListener() {} },
  navigator: {},
  performance: { now: () => 0 },
  requestAnimationFrame() {},
  setTimeout, console, Promise,
  ABCJS: { renderAbc() {} },
};
vm.createContext(ctx);
vm.runInContext(fs.readFileSync(__dirname + '/pitch.js', 'utf8'), ctx);
vm.runInContext(/<script>([\s\S]*?)<\/script>/.exec(fs.readFileSync(__dirname + '/index.html', 'utf8'))[1], ctx);

// ── Síntesis en JS puro (equivalente a synthesizeDemo, sin WebAudio) ─────────
let seed = 12345;
function rnd() { seed = (seed * 16807) % 2147483647; return seed / 2147483647; }

function synthesize(notes, bpm, gapFrac, sr = 44100) {
  const beatS = 60 / bpm;
  const totalS = notes.reduce((s, n) => s + n[1], 0) * beatS + 1;
  const data = new Float32Array(Math.ceil(totalS * sr));
  let t = 0.2;
  for (const [midi, beats] of notes) {
    const ioi = beats * beatS * (0.94 + rnd() * 0.12);   // ±6% timing
    const silenceS = Math.max(0.06, ioi * gapFrac);      // articulación mínima 60 ms
    const soundS = Math.max(0.05, ioi - silenceS);
    const detune = rnd() * 16 - 8;                        // ±8 cents
    const f = 440 * Math.pow(2, (midi - 69) / 12) * Math.pow(2, detune / 1200);
    const n0 = Math.round(t * sr), n1 = Math.round((t + soundS) * sr);
    for (let i = n0; i < n1 && i < data.length; i++) {
      const tt = (i - n0) / sr;
      let env = 0.5;
      if (tt < 0.015) env *= tt / 0.015;
      if ((n1 - i) / sr < 0.03) env *= (n1 - i) / sr / 0.03;
      const ph = 2 * Math.PI * f * tt;
      data[i] += env * (Math.sin(ph) + 0.4 * Math.sin(2 * ph) + 0.2 * Math.sin(3 * ph) + 0.08 * Math.sin(4 * ph));
    }
    t += ioi;
  }
  return data;
}

// ── Pasa el buffer por el pipeline real de la página ─────────────────────────
function runPipeline(data, sr = 44100) {
  ctx.TESTDATA = data;
  ctx.SR = sr;
  return JSON.parse(vm.runInContext(`
    (() => {
      resetDetectionState();
      const w = new Float32Array(2048);
      const hop = Math.round(SR * 0.016);
      for (let pos = 0; pos + 2048 <= TESTDATA.length; pos += hop) {
        for (let i = 0; i < 2048; i++) w[i] = TESTDATA[pos + i];
        processFrame(autoCorrelate(w, SR), rmsOf(w), (pos / SR) * 1000);
      }
      closeCurrentNote(lastVoiceTime || (TESTDATA.length / SR) * 1000);
      if (history.length >= 4) removeOutliers();
      mergeConsecutive();
      if (history.length >= 3) bpm = estimateTempo();
      recomputeRhythms();
      return JSON.stringify({ bpm, notes: history.map((n) => [n.midi, n.rhythm.beats, n.cents]) });
    })()
  `, ctx));
}

// ── Casos ────────────────────────────────────────────────────────────────────
const CASES = [
  { name: 'Escala Do mayor 90bpm', bpm: 90, gap: 0.1,
    notes: [[60,1],[62,1],[64,1],[65,1],[67,1],[69,1],[71,1],[72,2]] },
  { name: 'Cumpleaños feliz 100bpm', bpm: 100, gap: 0.12,
    notes: [[67,0.75],[67,0.25],[69,1],[67,1],[72,1],[71,2],
            [67,0.75],[67,0.25],[69,1],[67,1],[74,1],[72,2]] },
  { name: 'Repetidas staccato 90bpm', bpm: 90, gap: 0.3,
    notes: [[67,0.5],[67,0.5],[67,0.5],[67,0.5],[69,0.5],[69,0.5],[69,0.5],[69,0.5],
            [67,1],[67,1],[65,2]] },
  { name: 'Ritmo mixto 75bpm', bpm: 75, gap: 0.1,
    notes: [[60,1],[62,0.5],[64,0.5],[65,1.5],[67,0.5],[69,1],[67,1],
            [65,0.5],[64,0.5],[62,0.5],[60,0.5],[60,2]] },
];

let allOk = true;
for (const c of CASES) {
  const res = runPipeline(synthesize(c.notes, c.bpm, c.gap));
  const gotN = res.notes.map((n) => n[0]);
  const expN = c.notes.map((n) => n[0]);
  const gotR = res.notes.map((n) => n[1]);
  const expR = c.notes.map((n) => n[1]);
  const pitchOk = JSON.stringify(gotN) === JSON.stringify(expN);
  const rhythmOk = JSON.stringify(gotR) === JSON.stringify(expR);
  const bpmOk = Math.abs(res.bpm - c.bpm) / c.bpm < 0.08;
  if (!(pitchOk && rhythmOk && bpmOk)) allOk = false;
  console.log(`${pitchOk && rhythmOk && bpmOk ? 'PASS' : 'FAIL'}  ${c.name}`);
  console.log(`  bpm: ${c.bpm} -> ${res.bpm} ${bpmOk ? 'ok' : 'MAL'}`);
  console.log(`  notas   ${pitchOk ? 'ok' : 'MAL  esp=' + JSON.stringify(expN) + ' obt=' + JSON.stringify(gotN)}`);
  console.log(`  figuras ${rhythmOk ? 'ok' : 'MAL  esp=' + JSON.stringify(expR) + ' obt=' + JSON.stringify(gotR)}`);
}
process.exit(allOk ? 0 : 1);
