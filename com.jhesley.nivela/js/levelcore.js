/*
 * Nivela - motor de nivelamento de fala (implementacao propria, "clean-room").
 *
 * Fluxo em duas passadas, sem carregar o arquivo inteiro na memoria:
 *   1. Analise: decodifica com ffmpeg, aplica ponderacao K (ITU-R BS.1770) e
 *      guarda a energia de cada bloco de 100 ms.
 *   2. Curva de ganho: loudness de curto prazo -> deteccao de fala/silencio ->
 *      media movel em janela de alguns segundos -> ganho que leva cada trecho ao
 *      alvo, com protecao para nao levantar o ruido de fundo -> normalizacao.
 *   3. Render: decodifica de novo, aplica a curva, compressor leve opcional e
 *      limitador com look-ahead, e grava WAV 24 bits via ffmpeg.
 */
'use strict';

const { spawn } = require('child_process');
const fsys = require('fs');

const SUB_SEC = 0.1; // bloco de analise (100 ms)

const DEFAULTS = {
  ffmpeg: 'ffmpeg',
  ffprobe: 'ffprobe',
  target: -18,        // LUFS de saida
  strength: 1.0,      // 0..1, quanto do nivelamento por trecho aplicar
  window: 4,          // segundos, largura da janela de nivelamento
  maxBoost: 20,       // dB acima do ganho estatico
  maxCut: 12,         // dB abaixo do ganho estatico
  noiseProtect: true,
  noiseDepth: 28,     // ruido fica pelo menos isso abaixo do alvo
  compressor: true,
  ceiling: -1.0,      // dBFS
};

// ---------------------------------------------------------------- utilitarios

const db2lin = (db) => Math.pow(10, db / 20);
const pow2lufs = (p) => -0.691 + 10 * Math.log10(p + 1e-20);

function run(cmd, args) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { windowsHide: true });
    let out = '', err = '';
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (err += d));
    p.on('error', reject);
    p.on('close', (code) => (code === 0 ? resolve({ out, err }) : reject(new Error(`${cmd} saiu com codigo ${code}: ${err.slice(-800)}`))));
  });
}

async function probe(opts, file) {
  const { out } = await run(opts.ffprobe, [
    '-v', 'error', '-select_streams', 'a:0',
    '-show_entries', 'stream=sample_rate,channels,duration:format=duration',
    '-of', 'json', file,
  ]);
  const j = JSON.parse(out);
  const s = (j.streams || [])[0];
  if (!s) throw new Error('O arquivo nao tem faixa de audio: ' + file);
  const duration = parseFloat(s.duration) || parseFloat((j.format || {}).duration) || 0;
  return { sampleRate: parseInt(s.sample_rate, 10), channels: s.channels, duration };
}

// Decodifica para float32 intercalado e entrega blocos de quadros ao callback.
// Se o callback devolver uma Promise, a leitura pausa ate ela resolver.
function decode(opts, file, info, onFrames, ctl) {
  return new Promise((resolve, reject) => {
    const ch = info.channels;
    const frameBytes = 4 * ch;
    const p = spawn(opts.ffmpeg, [
      '-v', 'error', '-nostdin', '-i', file, '-map', '0:a:0', '-vn',
      '-f', 'f32le', '-acodec', 'pcm_f32le', '-ar', String(info.sampleRate), '-ac', String(ch), 'pipe:1',
    ], { windowsHide: true });
    if (ctl) ctl.procs.add(p);
    let rest = Buffer.alloc(0), err = '', failed = null;
    p.stderr.on('data', (d) => (err += d));
    p.stdout.on('data', (chunk) => {
      if (failed) return;
      const buf = rest.length ? Buffer.concat([rest, chunk]) : chunk;
      const n = Math.floor(buf.length / frameBytes);
      rest = buf.subarray(n * frameBytes);
      if (!n) return;
      const fa = new Float32Array(n * ch);
      buf.copy(Buffer.from(fa.buffer), 0, 0, n * frameBytes);
      let r;
      try { r = onFrames(fa, n); } catch (e) { failed = e; p.kill(); return; }
      if (r && typeof r.then === 'function') {
        p.stdout.pause();
        r.then(() => p.stdout.resume(), (e) => { failed = e; p.kill(); });
      }
    });
    p.on('error', reject);
    p.on('close', (code) => {
      if (ctl) ctl.procs.delete(p);
      if (failed) return reject(failed);
      if (ctl && ctl.cancelled) return reject(new Error('Cancelado'));
      if (code !== 0) return reject(new Error('ffmpeg (decodificacao) falhou: ' + err.slice(-800)));
      resolve();
    });
  });
}

// ------------------------------------------------------- ponderacao K (BS.1770)

function kWeightingCoefs(fs) {
  // Estagio 1: shelving de alta frequencia
  let f0 = 1681.974450955533, G = 3.999843853973347, Q = 0.7071752369554196;
  let K = Math.tan(Math.PI * f0 / fs);
  const Vh = Math.pow(10, G / 20), Vb = Math.pow(Vh, 0.4996667741545416);
  let a0 = 1 + K / Q + K * K;
  const s1 = {
    b0: (Vh + Vb * K / Q + K * K) / a0, b1: 2 * (K * K - Vh) / a0, b2: (Vh - Vb * K / Q + K * K) / a0,
    a1: 2 * (K * K - 1) / a0, a2: (1 - K / Q + K * K) / a0,
  };
  // Estagio 2: passa-altas RLB
  f0 = 38.13547087602444; Q = 0.5003270373238773;
  K = Math.tan(Math.PI * f0 / fs);
  a0 = 1 + K / Q + K * K;
  const s2 = { b0: 1, b1: -2, b2: 1, a1: 2 * (K * K - 1) / a0, a2: (1 - K / Q + K * K) / a0 };
  return [s1, s2];
}

function channelWeights(ch) {
  if (ch === 6) return [1, 1, 1, 0, 1.41, 1.41]; // 5.1: ignora LFE, surrounds +1.5 dB
  return new Array(ch).fill(1);
}

// ------------------------------------------------------------------ passada 1

async function analyze(opts, file, info, onProgress, ctl) {
  const fs = info.sampleRate, ch = info.channels;
  const sub = Math.max(1, Math.round(fs * SUB_SEC));
  const [s1, s2] = kWeightingCoefs(fs);
  const w = channelWeights(ch);
  const z = new Float64Array(ch * 4); // estados das biquads (DF-II transposta)
  const energies = [];
  let acc = 0, cnt = 0, done = 0;
  const total = Math.max(1, info.duration * fs);

  await decode(opts, file, info, (fa, n) => {
    for (let i = 0; i < n; i++) {
      let e = 0;
      for (let c = 0; c < ch; c++) {
        const x = fa[i * ch + c], o = c * 4;
        let y = s1.b0 * x + z[o];
        z[o] = s1.b1 * x - s1.a1 * y + z[o + 1];
        z[o + 1] = s1.b2 * x - s1.a2 * y;
        const y2 = y + z[o + 2];
        z[o + 2] = -2 * y - s2.a1 * y2 + z[o + 3];
        z[o + 3] = y - s2.a2 * y2;
        e += w[c] * y2 * y2;
      }
      acc += e;
      if (++cnt === sub) { energies.push(acc / sub); acc = 0; cnt = 0; }
    }
    done += n;
    if (onProgress) onProgress(Math.min(1, done / total));
  }, ctl);
  if (cnt > 0) energies.push(acc / cnt);
  return { energies: Float64Array.from(energies), sub, frames: done };
}

// ----------------------------------------------------------- curva de ganho

function gatedIntegrated(blockPow) {
  let sum = 0, n = 0;
  for (const p of blockPow) if (pow2lufs(p) > -70) { sum += p; n++; }
  if (!n) return -Infinity;
  const rel = pow2lufs(sum / n) - 10;
  sum = 0; n = 0;
  for (const p of blockPow) { const l = pow2lufs(p); if (l > -70 && l > rel) { sum += p; n++; } }
  return n ? pow2lufs(sum / n) : -Infinity;
}

function gaussianSmooth(values, weights, sigma) {
  const n = values.length, out = new Float64Array(n);
  const R = Math.max(1, Math.ceil(sigma * 3));
  const k = new Float64Array(2 * R + 1);
  for (let i = -R; i <= R; i++) k[i + R] = Math.exp(-0.5 * (i / sigma) * (i / sigma));
  let kSum = 0; for (const v of k) kSum += v;
  for (let i = 0; i < n; i++) {
    let num = 0, den = 0;
    const a = Math.max(0, i - R), b = Math.min(n - 1, i + R);
    for (let j = a; j <= b; j++) {
      const ww = k[j - i + R] * (weights ? weights[j] : 1);
      num += ww * values[j]; den += ww;
    }
    out[i] = den > kSum * 1e-3 ? num / den : NaN;
  }
  return out;
}

function fillNaN(a) {
  let last = NaN;
  for (let i = 0; i < a.length; i++) { if (isNaN(a[i])) a[i] = last; else last = a[i]; }
  last = NaN;
  for (let i = a.length - 1; i >= 0; i--) { if (isNaN(a[i])) a[i] = last; else last = a[i]; }
  for (let i = 0; i < a.length; i++) if (isNaN(a[i])) a[i] = 0;
}

function computeGains(energies, o) {
  const n = energies.length;
  const T = o.target;
  // Loudness de 400 ms centrado em cada bloco de 100 ms
  const B = new Float64Array(n), L = new Float64Array(n);
  for (let k = 0; k < n; k++) {
    let s = 0, c = 0;
    for (let j = Math.max(0, k - 2); j <= Math.min(n - 1, k + 1); j++) { s += energies[j]; c++; }
    B[k] = s / c; L[k] = pow2lufs(B[k]);
  }
  const Lint = gatedIntegrated(B);
  if (!isFinite(Lint)) return { gains: new Float32Array(n), stats: { inputLufs: null, silent: true } };

  // Piso de ruido: percentil 10 dos blocos com sinal
  const sorted = Array.from(L).filter((v) => v > -100).sort((a, b) => a - b);
  const noiseFloor = sorted.length ? sorted[Math.floor(sorted.length * 0.1)] : -100;
  const gate = Math.max(-65, Lint - 30, Math.min(noiseFloor + 8, Lint - 10));
  const active = new Float64Array(n);
  let activeCount = 0;
  for (let k = 0; k < n; k++) if (L[k] > gate) { active[k] = 1; activeCount++; }

  // Loudness media local (em dB) so sobre trechos de fala
  const sigma = Math.max(0.5, o.window / 2) / SUB_SEC;
  const S = gaussianSmooth(L, active, sigma);
  const gStatic = T - Lint;
  const g = new Float64Array(n);
  for (let k = 0; k < n; k++) {
    if (isNaN(S[k])) { g[k] = NaN; continue; }
    let dev = (T - S[k]) - gStatic;
    dev = Math.max(-o.maxCut, Math.min(o.maxBoost, dev)) * o.strength;
    g[k] = gStatic + dev;
  }
  fillNaN(g);

  const predicted = (gains) => {
    const P = new Float64Array(n);
    for (let k = 0; k < n; k++) P[k] = B[k] * Math.pow(10, gains[k] / 10);
    return gatedIntegrated(P);
  };

  let off = T - predicted(g);
  for (let k = 0; k < n; k++) g[k] += off;

  if (o.noiseProtect) {
    const gStat = gStatic + off;
    for (let k = 0; k < n; k++) {
      if (active[k]) continue;
      const cap = Math.max(gStat, (T - o.noiseDepth) - L[k]);
      if (g[k] > cap) g[k] = cap;
    }
  }

  const gs = gaussianSmooth(g, null, 0.25 / SUB_SEC);
  off = T - predicted(gs);
  const gains = new Float32Array(n);
  for (let k = 0; k < n; k++) gains[k] = gs[k] + off;

  let gMin = Infinity, gMax = -Infinity;
  for (const v of gains) { if (v < gMin) gMin = v; if (v > gMax) gMax = v; }
  return {
    gains,
    stats: {
      inputLufs: Lint, noiseFloor, gate, speechPct: (100 * activeCount) / n,
      gainMin: gMin, gainMax: gMax,
    },
  };
}

// ------------------------------------------------------------- processadores

class Compressor {
  // Compressor RMS leve, soft knee. Atua so nos picos de fala acima do alvo.
  constructor(fs, ch, o) {
    this.ch = ch;
    this.thr = o.target + 8; this.ratio = 2.5; this.knee = 6;
    this.att = Math.exp(-1 / (0.005 * fs));
    this.rel = Math.exp(-1 / (0.12 * fs));
    this.env = 0;
  }
  gainFor(frame, base) {
    let p = 0;
    for (let c = 0; c < this.ch; c++) { const x = frame[base + c]; p += x * x; }
    p /= this.ch;
    const a = p > this.env ? this.att : this.rel;
    this.env = a * this.env + (1 - a) * p;
    const lvl = 10 * Math.log10(this.env + 1e-20) + 3.01; // RMS de seno ~ pico-3dB
    const over = lvl - this.thr, k2 = this.knee / 2;
    let red = 0;
    if (over > k2) red = over * (1 - 1 / this.ratio);
    else if (over > -k2) red = (1 - 1 / this.ratio) * (over + k2) * (over + k2) / (2 * this.knee);
    return red > 0 ? db2lin(-red) : 1;
  }
}

class Limiter {
  // Limitador com look-ahead: minimo deslizante + media movel garante que o
  // ganho ja esta baixo quando o pico chega. Latencia = L quadros.
  constructor(fs, ch, ceilingDb) {
    this.ch = ch;
    this.L = Math.max(1, Math.round(0.005 * fs));
    this.ceil = db2lin(ceilingDb - 0.3); // margem p/ o erro da estimativa de pico real
    this.relA = Math.exp(-1 / (0.08 * fs));
    const cap = this.L + 2;
    this.sig = new Float32Array(cap * ch); // atraso do sinal
    this.r = new Float64Array(cap);        // ganho requerido por quadro
    this.cap = cap;
    this.dq = new Int32Array(cap); this.dqH = 0; this.dqT = 0; // deque de indices (minimo)
    this.mBuf = new Float64Array(this.L + 1); this.mSum = 0; this.mCount = 0;
    this.h = 1; this.inIdx = 0;
    // Pico real (true peak) aproximado: 3 pontos interpolados entre amostras
    // (sobreamostragem 4x) com sinc janelado de 8 coeficientes.
    this.hist = new Float64Array(ch * 8);
    this.taps = [0.25, 0.5, 0.75].map((f) => {
      const t = [];
      for (let k = 0; k < 8; k++) {
        const x = k - 3 - f, sinc = Math.abs(x) < 1e-9 ? 1 : Math.sin(Math.PI * x) / (Math.PI * x);
        const w = 0.5 + 0.5 * Math.cos(Math.PI * x / 4.5); // janela Hann
        t.push(sinc * w);
      }
      const sum = t.reduce((a, b) => a + b, 0);
      return Float64Array.from(t.map((v) => v / sum));
    });
  }
  // Recebe um quadro; devolve true se escreveu um quadro de saida em out[ob..]
  push(frame, base, out, ob) {
    const ch = this.ch, i = this.inIdx++, slot = i % this.cap, hs = this.hist;
    let pk = 0;
    for (let c = 0; c < ch; c++) {
      const x = frame[base + c], h = c * 8;
      for (let k = 0; k < 7; k++) hs[h + k] = hs[h + k + 1];
      hs[h + 7] = x;
      let v = Math.abs(x);
      // pontos entre x[n-4] e x[n-3]; os quadros deles ainda estao no look-ahead
      for (let p = 0; p < 3; p++) {
        const t = this.taps[p];
        let y = 0;
        for (let k = 0; k < 8; k++) y += t[k] * hs[h + k];
        if (Math.abs(y) > v) v = Math.abs(y);
      }
      if (v > pk) pk = v;
      this.sig[slot * ch + c] = x;
    }
    this.r[slot] = pk > this.ceil ? this.ceil / pk : 1;
    const dq = this.dq, cap = this.cap;
    while (this.dqT > this.dqH && this.r[dq[(this.dqT - 1) % cap] % cap] >= this.r[slot]) this.dqT--;
    dq[this.dqT % cap] = i; this.dqT++;
    const j = i - this.L; // m[j] = min r[j..j+L]
    if (j < 0) return false;
    while (dq[this.dqH % cap] < j) this.dqH++;
    const m = this.r[dq[this.dqH % cap] % cap];
    // media movel de m sobre L+1 valores
    const mi = j % (this.L + 1);
    if (this.mCount <= this.L) this.mCount++; else this.mSum -= this.mBuf[mi];
    this.mBuf[mi] = m; this.mSum += m;
    // No aquecimento ainda nao ha L+1 valores; m[j] sozinho ja cobre o quadro j.
    const gAvg = this.mCount > this.L ? this.mSum / (this.L + 1) : m;
    // saida corresponde ao quadro j (atraso L); subida com release exponencial
    const g = gAvg < this.h ? gAvg : this.relA * this.h + (1 - this.relA) * gAvg;
    this.h = g;
    const os = (j % cap) * ch;
    for (let c = 0; c < ch; c++) out[ob + c] = this.sig[os + c] * g;
    return true;
  }
}

// ------------------------------------------------------------------ passada 2

function makeEncoder(opts, info, outFile, ctl) {
  const p = spawn(opts.ffmpeg, [
    '-v', 'error', '-y', '-f', 'f32le', '-ar', String(info.sampleRate), '-ac', String(info.channels),
    '-i', 'pipe:0', '-c:a', 'pcm_s24le', outFile,
  ], { windowsHide: true });
  if (ctl) ctl.procs.add(p);
  let err = '';
  p.stderr.on('data', (d) => (err += d));
  const done = new Promise((resolve, reject) => {
    p.on('error', reject);
    p.on('close', (code) => {
      if (ctl) ctl.procs.delete(p);
      if (ctl && ctl.cancelled) return reject(new Error('Cancelado'));
      code === 0 ? resolve() : reject(new Error('ffmpeg (gravacao) falhou: ' + err.slice(-800)));
    });
  });
  const write = (f32) => new Promise((resolve, reject) => {
    const ok = p.stdin.write(Buffer.from(f32.buffer, f32.byteOffset, f32.byteLength), (e) => e && reject(e));
    ok ? resolve() : p.stdin.once('drain', resolve);
  });
  return { write, end: () => { p.stdin.end(); return done; } };
}

function curveGain(gains, sub) {
  const G = new Float32Array(gains.length);
  for (let k = 0; k < gains.length; k++) G[k] = db2lin(gains[k]);
  const nG = G.length;
  return (idx) => {
    const pos = idx / sub - 0.5;
    const k0 = Math.floor(pos);
    if (k0 < 0) return G[0];
    if (k0 >= nG - 1) return G[nG - 1];
    return G[k0] + (G[k0 + 1] - G[k0]) * (pos - k0);
  };
}

async function render(opts, file, info, gainAt, totalFrames, useComp, outFile, onProgress, ctl) {
  const ch = info.channels, fs = info.sampleRate;
  const comp = useComp ? new Compressor(fs, ch, opts) : null;
  const lim = new Limiter(fs, ch, opts.ceiling);
  const enc = makeEncoder(opts, info, outFile, ctl);
  const tmp = new Float32Array(ch);
  let n = 0, written = 0;
  const total = Math.max(1, totalFrames);

  await decode(opts, file, info, (fa, frames) => {
    const out = new Float32Array(frames * ch);
    let oc = 0;
    for (let i = 0; i < frames; i++, n++) {
      const g = gainAt(n), b = i * ch;
      for (let c = 0; c < ch; c++) tmp[c] = fa[b + c] * g;
      if (comp) { const cg = comp.gainFor(tmp, 0); for (let c = 0; c < ch; c++) tmp[c] *= cg; }
      if (lim.push(tmp, 0, out, oc * ch)) oc++;
    }
    written += oc;
    if (onProgress) onProgress(Math.min(1, n / total));
    return oc ? enc.write(out.subarray(0, oc * ch)) : null;
  }, ctl);

  // Esvazia o look-ahead do limitador com silencio
  const tail = new Float32Array(lim.L * ch);
  let tc = 0;
  for (let c = 0; c < ch; c++) tmp[c] = 0;
  while (written + tc < n) { if (lim.push(tmp, 0, tail, tc * ch)) tc++; }
  if (tc) await enc.write(tail.subarray(0, tc * ch));
  await enc.end();
}

// --------------------------------------------------------------- medicao final

async function measure(opts, file) {
  const { err } = await run(opts.ffmpeg, ['-hide_banner', '-nostdin', '-i', file, '-af', 'loudnorm=print_format=json', '-f', 'null', '-']);
  const m = err.match(/\{[\s\S]*\}/);
  if (!m) return null;
  const j = JSON.parse(m[0]);
  return { lufs: parseFloat(j.input_i), truePeak: parseFloat(j.input_tp), lra: parseFloat(j.input_lra) };
}

// ----------------------------------------------------------------------- API

async function levelFile(inFile, outFile, userOpts, onProgress, ctl) {
  const o = Object.assign({}, DEFAULTS, userOpts || {});
  const prog = (stage, f) => onProgress && onProgress(stage, f);
  const info = await probe(o, inFile);
  prog('analise', 0);
  const an = await analyze(o, inFile, info, (f) => prog('analise', f), ctl);
  const { gains, stats } = computeGains(an.energies, o);
  if (stats.silent) throw new Error('O audio esta em silencio; nada para nivelar.');
  prog('render', 0);
  const tmpFile = outFile.replace(/\.wav$/i, '') + '.parcial.wav';
  try {
    await render(o, inFile, info, curveGain(gains, an.sub), an.frames, o.compressor, tmpFile, (f) => prog('render', f), ctl);
    // O compressor e o limitador tiram um pouco de loudness; mede e corrige.
    prog('medicao', 0);
    let result = await measure(o, tmpFile);
    const fix = result && isFinite(result.lufs) ? o.target - result.lufs : 0;
    if (Math.abs(fix) > 0.2) {
      prog('ajuste', 0);
      const g = db2lin(fix);
      await render(o, tmpFile, info, () => g, an.frames, false, outFile, (f) => prog('ajuste', f), ctl);
      fsys.unlinkSync(tmpFile);
      try { result = await measure(o, outFile); } catch (e) { /* medicao e opcional */ }
    } else {
      if (fsys.existsSync(outFile)) fsys.unlinkSync(outFile);
      fsys.renameSync(tmpFile, outFile);
    }
    return { info, stats, result, outFile };
  } catch (e) {
    // Nao deixa arquivo pela metade (o painel reaproveita arquivos existentes)
    for (const f of [tmpFile, outFile]) { try { if (fsys.existsSync(f)) fsys.unlinkSync(f); } catch (e2) {} }
    throw e;
  }
}

function createControl() {
  const ctl = { cancelled: false, procs: new Set() };
  ctl.cancel = () => { ctl.cancelled = true; for (const p of ctl.procs) { try { p.kill(); } catch (e) {} } };
  return ctl;
}

module.exports = { levelFile, probe, measure, computeGains, createControl, DEFAULTS, _internal: { Limiter, Compressor, kWeightingCoefs } };
