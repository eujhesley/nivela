#!/usr/bin/env node
// Uso: node cli.js entrada.(wav|mp3|mp4...) saida.wav [--target -18] [--window 4] [--strength 1]
//      [--maxBoost 18] [--ceiling -1] [--no-compressor] [--no-noise]
'use strict';
const path = require('path');
const core = require(path.join(__dirname, 'com.jhesley.nivela', 'js', 'levelcore.js'));

const args = process.argv.slice(2);
if (args.length < 2) { console.error('Uso: node cli.js entrada saida.wav [opcoes]'); process.exit(1); }
const [inFile, outFile] = args;
const opts = {};
for (let i = 2; i < args.length; i++) {
  const a = args[i];
  if (a === '--no-compressor') opts.compressor = false;
  else if (a === '--no-noise') opts.noiseProtect = false;
  else if (a.startsWith('--')) opts[a.slice(2)] = parseFloat(args[++i]);
}

let last = '';
const t0 = Date.now();
core.levelFile(inFile, outFile, opts, (stage, f) => {
  const s = `${stage} ${Math.round(f * 100)}%`;
  if (s !== last && Math.round(f * 100) % 10 === 0) { console.log(s); last = s; }
}).then((r) => {
  console.log(JSON.stringify({ stats: r.stats, result: r.result, segundos: (Date.now() - t0) / 1000 }, null, 2));
}).catch((e) => { console.error('ERRO:', e.message); process.exit(1); });
