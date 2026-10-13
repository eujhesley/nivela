/*
 * Nivela - lado ExtendScript (Premiere Pro).
 * Le a selecao da timeline, importa os WAVs nivelados e coloca cada um
 * exatamente sobre o clipe original, numa trilha de audio livre.
 */

var NV_BIN = 'Nivelados';

function nv_q(s) {
  return '"' + String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"')
    .replace(/\r/g, '\\r').replace(/\n/g, '\\n').replace(/\t/g, '\\t') + '"';
}

function nv_json(v) {
  if (v === null || v === undefined) return 'null';
  var t = typeof v;
  if (t === 'number') return isFinite(v) ? String(v) : 'null';
  if (t === 'boolean') return v ? 'true' : 'false';
  if (t === 'string') return nv_q(v);
  var i, parts = [];
  if (v instanceof Array) {
    for (i = 0; i < v.length; i++) parts.push(nv_json(v[i]));
    return '[' + parts.join(',') + ']';
  }
  for (var k in v) if (v.hasOwnProperty(k)) parts.push(nv_q(k) + ':' + nv_json(v[k]));
  return '{' + parts.join(',') + '}';
}

function nv_norm(p) { return String(p).replace(/\//g, '\\').toLowerCase(); }

function nv_time(sec) { var t = new Time(); t.seconds = sec; return t; }

function nv_findClip(seq, nodeId) {
  for (var t = 0; t < seq.audioTracks.numTracks; t++) {
    var clips = seq.audioTracks[t].clips;
    for (var c = 0; c < clips.numItems; c++) {
      if (clips[c].nodeId === nodeId) return { track: t, clip: clips[c] };
    }
  }
  return null;
}

function nv_getSelection() {
  try {
    var seq = app.project.activeSequence;
    if (!seq) return nv_json({ ok: false, error: 'Nenhuma sequencia ativa. Abra uma sequencia na timeline.' });
    var sel = seq.getSelection();
    var items = [], skipped = [];
    for (var i = 0; i < sel.length; i++) {
      var ti = sel[i];
      if (ti.mediaType !== 'Audio') continue;
      var pi = ti.projectItem;
      var path = '';
      try { path = pi ? pi.getMediaPath() : ''; } catch (e1) {}
      if (!path) { skipped.push(ti.name + ': sem arquivo de midia (sequencia aninhada ou multicam)'); continue; }
      var speed = 1;
      try { speed = ti.getSpeed(); } catch (e2) {}
      var rev = false;
      try { rev = ti.isSpeedReversed(); } catch (e3) {}
      if (Math.abs(speed - 1) > 0.0001 || rev) { skipped.push(ti.name + ': velocidade alterada, nao suportado'); continue; }
      var found = nv_findClip(seq, ti.nodeId);
      items.push({
        nodeId: ti.nodeId, name: ti.name, path: path, track: found ? found.track : -1,
        start: ti.start.seconds, end: ti.end.seconds, inPt: ti.inPoint.seconds, outPt: ti.outPoint.seconds
      });
    }
    var projPath = app.project.path || '';
    var projDir = projPath ? projPath.replace(/[\\\/][^\\\/]*$/, '') : '';
    return nv_json({ ok: true, items: items, skipped: skipped, projectDir: projDir, sequence: seq.name });
  } catch (e) {
    return nv_json({ ok: false, error: String(e) });
  }
}

function nv_getBin() {
  var root = app.project.rootItem;
  for (var i = 0; i < root.children.numItems; i++) {
    var c = root.children[i];
    if (c.type === ProjectItemType.BIN && c.name === NV_BIN) return c;
  }
  var b = root.createBin(NV_BIN);
  if (b) return b;
  for (i = 0; i < root.children.numItems; i++) {
    c = root.children[i];
    if (c.type === ProjectItemType.BIN && c.name === NV_BIN) return c;
  }
  return root;
}

function nv_findByPath(parent, path) {
  var want = nv_norm(path);
  for (var i = 0; i < parent.children.numItems; i++) {
    var c = parent.children[i];
    if (c.type === ProjectItemType.BIN) {
      var r = nv_findByPath(c, path);
      if (r) return r;
    } else {
      var p = '';
      try { p = c.getMediaPath(); } catch (e) {}
      if (p && nv_norm(p) === want) return c;
    }
  }
  return null;
}

function nv_import(paths) {
  var bin = nv_getBin(), todo = [], map = {};
  for (var i = 0; i < paths.length; i++) {
    var hit = nv_findByPath(bin, paths[i]);
    if (hit) map[paths[i]] = hit; else todo.push(paths[i]);
  }
  if (todo.length) app.project.importFiles(todo, true, bin, false);
  for (i = 0; i < todo.length; i++) map[todo[i]] = nv_findByPath(bin, todo[i]) || nv_findByPath(app.project.rootItem, todo[i]);
  return map;
}

function nv_trackFree(track, start, end) {
  try { if (track.isLocked()) return false; } catch (e) {}
  var clips = track.clips;
  for (var c = 0; c < clips.numItems; c++) {
    var s = clips[c].start.seconds, e2 = clips[c].end.seconds;
    if (s < end - 0.0005 && e2 > start + 0.0005) return false;
  }
  return true;
}

function nv_addAudioTrack(seq) {
  var before = seq.audioTracks.numTracks;
  try {
    app.enableQE();
    var q = qe.project.getActiveSequence();
    var tries = [
      function () { q.addTracks(0, 0, 1, 1, before); },
      function () { q.addTracks(0, 0, 1, 0, before); },
      function () { q.addTracks(0, 0, 1); }
    ];
    for (var i = 0; i < tries.length && seq.audioTracks.numTracks === before; i++) {
      try { tries[i](); } catch (e) {}
    }
  } catch (e2) {}
  return seq.audioTracks.numTracks > before ? seq.audioTracks.numTracks - 1 : -1;
}

function nv_clipAt(track, start) {
  var clips = track.clips;
  for (var c = 0; c < clips.numItems; c++) {
    if (Math.abs(clips[c].start.seconds - start) < 0.002) return clips[c];
  }
  return null;
}

function nv_setRange(pi, inPt, outPt) {
  try { pi.setInPoint(inPt, 4); pi.setOutPoint(outPt, 4); }
  catch (e) { pi.setInPoint(nv_time(inPt), 4); pi.setOutPoint(nv_time(outPt), 4); }
}

function nv_clearRange(pi) {
  // Se falhar, o item no bin so fica com in/out marcados; nada quebra.
  try { pi.clearInPoint(); pi.clearOutPoint(); } catch (e) {}
}

// Tenta colocar o clipe numa trilha; confirma que ele apareceu la.
function nv_tryPlace(seq, t, pi, it) {
  var track = seq.audioTracks[t];
  if (!nv_trackFree(track, it.start, it.end)) return null;
  nv_setRange(pi, it.inPt, it.outPt);
  try { track.overwriteClip(pi, nv_time(it.start)); } catch (e) {}
  nv_clearRange(pi);
  var nc = nv_clipAt(track, it.start);
  if (!nc) return null;
  try { if (Math.abs(nc.end.seconds - it.end) > 0.0001) nc.end = nv_time(it.end); } catch (e2) {}
  return nc;
}

function nv_place(argStr) {
  try {
    var a = eval('(' + argStr + ')');
    var seq = app.project.activeSequence;
    if (!seq) return nv_json({ ok: false, error: 'Nenhuma sequencia ativa.' });
    var paths = [], seen = {}, i;
    for (i = 0; i < a.items.length; i++) {
      if (!seen[a.items[i].newPath]) { seen[a.items[i].newPath] = 1; paths.push(a.items[i].newPath); }
    }
    var map = nv_import(paths);
    var placed = 0, errors = [];
    for (i = 0; i < a.items.length; i++) {
      var it = a.items[i];
      var pi = map[it.newPath];
      if (!pi) { errors.push(it.name + ': nao consegui importar ' + it.newPath); continue; }
      var orig = nv_findClip(seq, it.nodeId);
      if (!orig) { errors.push(it.name + ': clipe original nao encontrado (a timeline mudou?)'); continue; }
      // ordem de preferencia: trilhas abaixo da original, depois as acima, depois uma nova
      var order = [], t;
      for (t = orig.track + 1; t < seq.audioTracks.numTracks; t++) order.push(t);
      for (t = orig.track - 1; t >= 0; t--) order.push(t);
      var nc = null;
      for (t = 0; t < order.length && !nc; t++) nc = nv_tryPlace(seq, order[t], pi, it);
      if (!nc) {
        var nt = nv_addAudioTrack(seq);
        if (nt >= 0) nc = nv_tryPlace(seq, nt, pi, it);
      }
      if (!nc) { errors.push(it.name + ': sem trilha de audio livre. Crie uma trilha de audio vazia e tente de novo.'); continue; }
      if (a.disableOriginal) {
        try { orig.clip.disabled = true; } catch (e) { errors.push(it.name + ': colocado, mas nao consegui desativar o original'); }
      }
      placed++;
    }
    return nv_json({ ok: true, placed: placed, errors: errors });
  } catch (e) {
    return nv_json({ ok: false, error: String(e) });
  }
}

function nv_importOnly(argStr) {
  try {
    var a = eval('(' + argStr + ')');
    var map = nv_import(a.paths), n = 0;
    for (var k in map) if (map.hasOwnProperty(k) && map[k]) n++;
    return nv_json({ ok: true, imported: n });
  } catch (e) {
    return nv_json({ ok: false, error: String(e) });
  }
}

function nv_projectDir() {
  var p = app.project.path || '';
  return p ? p.replace(/[\\\/][^\\\/]*$/, '') : '';
}
