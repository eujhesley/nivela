/* Nivela - painel (CEP, Node habilitado). */
(function () {
  'use strict';

  const path = require('path');
  const fs = require('fs');
  const crypto = require('crypto');
  const { execFileSync } = require('child_process');

  const extDir = (() => {
    let p = window.__adobe_cep__.getSystemPath('extension');
    p = decodeURIComponent(p).replace(/^file:\/{2,3}/, '');
    return path.normalize(p);
  })();
  const core = require(path.join(extDir, 'js', 'levelcore.js'));

  const $ = (id) => document.getElementById(id);
  const SETTINGS_KEY = 'nivelador.settings.v1';
  const fields = ['target', 'strength', 'window', 'maxBoost', 'maxCut', 'ceiling', 'compressor', 'noiseProtect', 'disableOriginal', 'ffmpeg'];

  // ------------------------------------------------------------ ExtendScript

  function evalHost(script) {
    return new Promise((resolve, reject) => {
      window.__adobe_cep__.evalScript(script, (res) => {
        if (res === 'EvalScript error.') return reject(new Error('Erro no ExtendScript ao executar: ' + script.slice(0, 40)));
        try { resolve(JSON.parse(res)); } catch (e) { reject(new Error('Resposta invalida do Premiere: ' + res)); }
      });
    });
  }
  const hostCall = (fn, obj) => evalHost(`${fn}(${JSON.stringify(JSON.stringify(obj))})`);

  // --------------------------------------------------------------- interface

  function log(msg, cls) {
    const el = document.createElement('div');
    el.textContent = msg;
    if (cls) el.className = cls;
    $('log').appendChild(el);
    $('log').scrollTop = $('log').scrollHeight;
  }
  const setStage = (t) => ($('stage').textContent = t);
  const setBar = (f) => ($('barFill').style.width = Math.round(Math.max(0, Math.min(1, f)) * 100) + '%');

  function updateOutputs() {
    $('strengthOut').textContent = $('strength').value + '%';
    $('windowOut').textContent = $('window').value + ' s';
    $('maxBoostOut').textContent = '+' + $('maxBoost').value + ' dB';
    $('maxCutOut').textContent = '-' + $('maxCut').value + ' dB';
    $('ceilingOut').textContent = $('ceiling').value + ' dBTP';
  }

  function saveSettings() {
    const s = {};
    for (const f of fields) { const el = $(f); s[f] = el.type === 'checkbox' ? el.checked : el.value; }
    try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(s)); } catch (e) {}
  }

  function loadSettings() {
    let s = {};
    try { s = JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}'); } catch (e) {}
    for (const f of fields) {
      if (!(f in s)) continue;
      const el = $(f);
      if (el.type === 'checkbox') el.checked = !!s[f]; else el.value = s[f];
    }
    if (!$('ffmpeg').value) $('ffmpeg').value = findFfmpeg();
    updateOutputs();
  }

  function findFfmpeg() {
    try {
      const out = execFileSync('where', ['ffmpeg'], { windowsHide: true }).toString().split(/\r?\n/)[0].trim();
      if (out) return out;
    } catch (e) {}
    const winget = path.join(process.env.LOCALAPPDATA || '', 'Microsoft', 'WinGet', 'Packages');
    try {
      for (const d of fs.readdirSync(winget)) {
        if (!/ffmpeg/i.test(d)) continue;
        const base = path.join(winget, d);
        for (const sub of fs.readdirSync(base)) {
          const exe = path.join(base, sub, 'bin', 'ffmpeg.exe');
          if (fs.existsSync(exe)) return exe;
        }
      }
    } catch (e) {}
    for (const c of ['C:\\ffmpeg\\bin\\ffmpeg.exe', 'C:\\Program Files\\ffmpeg\\bin\\ffmpeg.exe']) if (fs.existsSync(c)) return c;
    return '';
  }

  function options() {
    const ff = $('ffmpeg').value.trim();
    if (!ff) throw new Error('ffmpeg não encontrado. Instale (winget install Gyan.FFmpeg) ou informe o caminho em Avançado.');
    const probe = /ffmpeg(\.exe)?$/i.test(ff) ? ff.replace(/ffmpeg(\.exe)?$/i, (m) => m.replace(/ffmpeg/i, 'ffprobe')) : 'ffprobe';
    return {
      ffmpeg: ff,
      ffprobe: probe,
      target: parseFloat($('target').value),
      strength: parseFloat($('strength').value) / 100,
      window: parseFloat($('window').value),
      maxBoost: parseFloat($('maxBoost').value),
      maxCut: parseFloat($('maxCut').value),
      ceiling: parseFloat($('ceiling').value),
      compressor: $('compressor').checked,
      noiseProtect: $('noiseProtect').checked,
    };
  }

  // ------------------------------------------------------------- processamento

  const STAGES = { analise: ['Analisando', 0, 0.4], render: ['Nivelando', 0.4, 0.85], medicao: ['Medindo', 0.85, 0.9], ajuste: ['Ajuste final', 0.9, 1] };
  let ctl = null;

  function outputPathFor(src, opts, outDir) {
    const st = fs.statSync(src);
    const key = JSON.stringify({ src: path.resolve(src).toLowerCase(), size: st.size, mtime: st.mtimeMs, o: Object.assign({}, opts, { ffmpeg: 0, ffprobe: 0 }) });
    const hash = crypto.createHash('md5').update(key).digest('hex').slice(0, 6);
    const base = path.basename(src).replace(/\.[^.]+$/, '');
    return path.join(outDir, `${base}_nivelado_${hash}.wav`);
  }

  async function levelOne(src, out, opts, idx, total) {
    if (fs.existsSync(out)) { log(`Já nivelado antes, reaproveitando: ${path.basename(out)}`); return; }
    log(`> ${path.basename(src)}`);
    const r = await core.levelFile(src, out, opts, (stage, f) => {
      const s = STAGES[stage] || [stage, 0, 1];
      setStage(`${s[0]} (${idx + 1}/${total}) ${path.basename(src)}`);
      setBar((idx + s[1] + (s[2] - s[1]) * f) / total);
    }, ctl);
    const st = r.stats, m = r.result;
    log(`  entrada ${st.inputLufs.toFixed(1)} LUFS, fala ${st.speechPct.toFixed(0)}%, ganho ${st.gainMin.toFixed(1)} a ${st.gainMax.toFixed(1)} dB`);
    if (m) log(`  saída ${m.lufs.toFixed(1)} LUFS, pico ${m.truePeak.toFixed(1)} dBTP`, 'ok');
  }

  function setBusy(b) {
    $('btnSel').disabled = b; $('btnFile').disabled = b;
    $('btnCancel').hidden = !b;
  }

  async function guarded(fn) {
    setBusy(true); setBar(0); $('log').textContent = '';
    ctl = core.createControl();
    try { await fn(); }
    catch (e) { log('Erro: ' + e.message, 'err'); setStage(ctl.cancelled ? 'Cancelado.' : 'Falhou.'); }
    finally { setBusy(false); ctl = null; }
  }

  function ensureDir(d) { fs.mkdirSync(d, { recursive: true }); return d; }

  async function levelSelection() {
    const opts = options();
    setStage('Lendo a seleção...');
    const sel = await evalHost('nv_getSelection()');
    if (!sel.ok) throw new Error(sel.error);
    for (const s of sel.skipped) log('Ignorado: ' + s, 'err');
    if (!sel.items.length) throw new Error('Selecione um ou mais clipes de ÁUDIO na timeline.');

    const sources = [...new Set(sel.items.map((i) => i.path))];
    const missing = sources.filter((p) => !fs.existsSync(p));
    if (missing.length) throw new Error('Mídia offline: ' + missing.join(', '));

    const outDir = ensureDir(sel.projectDir ? path.join(sel.projectDir, 'Nivelados') : path.join(path.dirname(sources[0]), 'Nivelados'));
    const outFor = {};
    for (let i = 0; i < sources.length; i++) {
      outFor[sources[i]] = outputPathFor(sources[i], opts, outDir);
      await levelOne(sources[i], outFor[sources[i]], opts, i, sources.length);
    }

    setStage('Colocando na timeline...');
    const items = sel.items.map((i) => Object.assign({}, i, { newPath: outFor[i.path] }));
    const res = await hostCall('nv_place', { items, disableOriginal: $('disableOriginal').checked });
    if (!res.ok) throw new Error(res.error);
    for (const e of res.errors) log(e, 'err');
    setBar(1);
    setStage(`Concluído: ${res.placed} de ${items.length} clipe(s) nivelado(s). Ctrl+Z desfaz.`);
    log(`Arquivos em ${outDir}`);
  }

  async function levelFiles() {
    const opts = options();
    const pick = window.cep.fs.showOpenDialogEx(true, false, 'Escolha os arquivos de áudio ou vídeo', '', ['wav', 'mp3', 'aif', 'aiff', 'm4a', 'aac', 'flac', 'ogg', 'mp4', 'mov', 'mxf', 'mkv']);
    if (pick.err || !pick.data || !pick.data.length) { setStage('Nenhum arquivo escolhido.'); return; }
    const projDir = await evalHost('(function(){return nv_json(nv_projectDir());})()').catch(() => '');
    const outs = [];
    for (let i = 0; i < pick.data.length; i++) {
      const src = pick.data[i];
      const outDir = ensureDir(projDir ? path.join(projDir, 'Nivelados') : path.join(path.dirname(src), 'Nivelados'));
      const out = outputPathFor(src, opts, outDir);
      await levelOne(src, out, opts, i, pick.data.length);
      outs.push(out);
    }
    const res = await hostCall('nv_importOnly', { paths: outs });
    if (!res.ok) throw new Error(res.error);
    setBar(1);
    setStage(`Concluído: ${outs.length} arquivo(s) importado(s) no bin "Nivelados".`);
  }

  // --------------------------------------------------------------------- init

  loadSettings();
  for (const f of fields) $(f).addEventListener('input', () => { updateOutputs(); saveSettings(); });
  $('btnSel').addEventListener('click', () => guarded(levelSelection));
  $('btnFile').addEventListener('click', () => guarded(levelFiles));
  $('btnCancel').addEventListener('click', () => ctl && ctl.cancel());
})();
