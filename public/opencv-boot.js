// Classic (non-module) OpenCV bootstrap.
//
// Loaded from index.html BEFORE the app module. The app consumes:
//   window.__cvOnProgress(fn)  -> download/init progress
//   window.__cvOnReady(fn,err) -> ready callback (SYNCHRONOUS, see below)
//
// Hard-won details (verified with Playwright, incl. main-thread liveness):
//  * Ready MUST be signalled from a callback set DIRECTLY inside the script's
//    onload (i.e. cv.onRuntimeInitialized = done). Deferring the setup by even
//    one microtask (a `.then()` after the injected-script promise) leaves the
//    main thread frozen after init. So no promise wrapper around the injection.
//  * Ready MUST be delivered via a synchronous callback, not a promise .then()
//    (Emscripten's post-init work can starve the microtask queue).
//  * Do NOT URL.revokeObjectURL the blob script — Emscripten keeps referencing
//    it; revoking wedges the main thread.
//  * Strategy: fetch with byte progress -> blob: <script src> (browser
//    stream-compiles the ~11 MB, keeping the stall small).
(function () {
  var LOCAL_URL = '/opencv.js';
  var CDN_URL = 'https://docs.opencv.org/4.x/opencv.js';

  var progressListeners = [];
  var lastProgress = null;
  window.__cvOnProgress = function (fn) {
    progressListeners.push(fn);
    if (lastProgress) { try { fn(lastProgress); } catch (e) {} }
  };
  function emit(p) {
    lastProgress = p;
    for (var i = 0; i < progressListeners.length; i++) {
      try { progressListeners[i](p); } catch (e) {}
    }
  }

  var readyCbs = [];
  var readyCv = null;
  var readyErr = null;
  window.__cvOnReady = function (fn, onErr) {
    if (readyCv) { try { fn(readyCv); } catch (e) {} return; }
    if (readyErr) { if (onErr) onErr(readyErr); return; }
    readyCbs.push({ ok: fn, err: onErr });
  };
  function fireReady(cv) {
    if (readyCv) return;
    readyCv = cv;
    emit({ phase: 'ready' });
    for (var i = 0; i < readyCbs.length; i++) {
      try { readyCbs[i].ok(cv); } catch (e) {}
    }
  }
  function fireError(e) {
    if (readyErr || readyCv) return;
    readyErr = e;
    for (var i = 0; i < readyCbs.length; i++) {
      try { if (readyCbs[i].err) readyCbs[i].err(e); } catch (err) {}
    }
  }

  function fetchCode() {
    return fetch(LOCAL_URL).then(function (res) {
      if (!res.ok) throw new Error('HTTP ' + res.status);
      var total = Number(res.headers.get('Content-Length')) || null;
      if (!res.body) {
        return res.arrayBuffer().then(function (ab) {
          var buf = new Uint8Array(ab);
          emit({ phase: 'download', loaded: buf.length, total: buf.length });
          return new TextDecoder().decode(buf);
        });
      }
      var reader = res.body.getReader();
      var chunks = [];
      var loaded = 0;
      function pump() {
        return reader.read().then(function (r) {
          if (r.done) return;
          chunks.push(r.value);
          loaded += r.value.length;
          emit({ phase: 'download', loaded: loaded, total: total });
          return pump();
        });
      }
      return pump().then(function () {
        var all = new Uint8Array(loaded);
        var off = 0;
        for (var i = 0; i < chunks.length; i++) { all.set(chunks[i], off); off += chunks[i].length; }
        return new TextDecoder().decode(all);
      });
    });
  }

  // Inject a classic <script src>; set the ready detection DIRECTLY in onload.
  function injectAndWatch(src) {
    var s = document.createElement('script');
    s.src = src;
    s.onload = function () {
      var cv = window.cv;
      if (!cv) return fireError(new Error('OpenCV non disponibile.'));
      if (cv.Mat) return fireReady(cv);
      cv.onRuntimeInitialized = function () { fireReady(window.cv); };
      // Safety timeout only (no busy poll needed).
      setTimeout(function () {
        if (!readyCv) {
          if (window.cv && window.cv.Mat) fireReady(window.cv);
          else fireError(new Error('Timeout inizializzazione OpenCV.'));
        }
      }, 60000);
    };
    s.onerror = function () { fireError(new Error('Download fallito: ' + src)); };
    document.head.appendChild(s);
  }

  if (window.cv && window.cv.Mat) {
    fireReady(window.cv);
  } else {
    fetchCode()
      .then(function (code) {
        emit({ phase: 'init' });
        injectAndWatch(URL.createObjectURL(new Blob([code], { type: 'text/javascript' })));
      })
      .catch(function () {
        // Fallback: plain <script src> (no progress), local then CDN.
        emit({ phase: 'init' });
        var s = document.createElement('script');
        s.src = LOCAL_URL;
        s.onerror = function () { injectAndWatch(CDN_URL); };
        s.onload = function () {
          var cv = window.cv;
          if (cv && cv.Mat) return fireReady(cv);
          if (cv) cv.onRuntimeInitialized = function () { fireReady(window.cv); };
        };
        document.head.appendChild(s);
      });
  }
})();
