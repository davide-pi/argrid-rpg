// Thin wrapper around getUserMedia for the rear camera, with graceful
// start/stop. On desktops without a camera the caller falls back to file upload.

export class Camera {
  private stream: MediaStream | null = null;
  // Log the track's focus capabilities only once per session (they don't change while a
  // stream is live) so the console isn't flooded on every tap-to-focus.
  private focusLogged = false;

  constructor(private video: HTMLVideoElement) {}

  get isRunning(): boolean {
    return this.stream !== null;
  }

  async start(): Promise<void> {
    if (this.stream) return;

    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error('Fotocamera non supportata da questo browser.');
    }

    // Prefer the rear camera at a decent resolution.
    const constraints: MediaStreamConstraints = {
      audio: false,
      video: {
        facingMode: { ideal: 'environment' },
        width: { ideal: 1920 },
        height: { ideal: 1080 },
      },
    };

    this.stream = await navigator.mediaDevices.getUserMedia(constraints);
    this.video.srcObject = this.stream;
    await this.video.play();
  }

  stop(): void {
    if (this.stream) {
      for (const track of this.stream.getTracks()) track.stop();
      this.stream = null;
    }
    this.video.srcObject = null;
  }

  /** Best-effort native tap-to-focus at a normalized point (nx,ny in [0,1] of the video frame).
   * Returns true if at least one applyConstraints call resolved (mostly Android Chrome); a silent
   * no-op returning false where the device advertises neither `focusMode` nor `pointsOfInterest`
   * (iOS Safari). We CANNOT test this on Android ourselves, so it logs richly (prefix `[focus]`):
   * the track capabilities + settings before/after each attempt, so a user can paste back exactly
   * what their device reported and we can see whether the constraints were accepted.
   *
   * Robustness: some devices accept `pointsOfInterest` only alongside a compatible `focusMode`, and
   * some reject a combined `advanced` entry but accept the two applied separately. So we try the
   * COMBINED entry first, then fall back to SEPARATE, independent best-effort entries (focusMode
   * first — it sets the compatible mode — then the POI). Each attempt is caught on its own. */
  async focusAt(nx: number, ny: number): Promise<boolean> {
    const track = this.stream?.getVideoTracks?.()[0] as any;
    if (!track?.getCapabilities || !track?.applyConstraints) {
      console.info('[focus] track / getCapabilities non disponibile → no-op');
      return false;
    }

    let caps: any = {};
    try {
      caps = track.getCapabilities() ?? {};
    } catch (err) {
      console.warn('[focus] getCapabilities() ha lanciato', err);
    }
    const settingsBefore = this.readSettings(track);

    const focusModes: string[] = Array.isArray(caps.focusMode) ? caps.focusMode : [];
    // Feature-detect POI by its PRESENCE in the advertised capabilities (its shape varies across
    // browsers, so don't test truthiness of a possibly-empty object/array).
    const poiSupported = 'pointsOfInterest' in caps;

    // Log the device's focus capabilities once — this is the key diagnostic for on-device triage.
    if (!this.focusLogged) {
      this.focusLogged = true;
      console.info('[focus] capabilities', {
        focusMode: caps.focusMode ?? '(assente)',
        pointsOfInterest: poiSupported ? (caps.pointsOfInterest ?? true) : '(assente)',
        settingsBefore,
      });
    }

    // Prefer a single-shot focus lock at the tapped point; fall back to continuous.
    const mode = focusModes.includes('single-shot')
      ? 'single-shot'
      : focusModes.includes('continuous')
        ? 'continuous'
        : null;

    if (!mode && !poiSupported) {
      // iOS Safari and other browsers without manual focus control: nothing to apply.
      console.info('[focus] focus non supportato su questo device (nessun focusMode/pointsOfInterest) → no-op');
      return false;
    }

    const poi = [{ x: nx, y: ny }];
    let applied = false;

    // 1) COMBINED entry — one advanced constraint carrying both mode + POI (what most Android
    //    Chrome builds want). POI is included only when the device advertises it.
    const combined: any = {};
    if (mode) combined.focusMode = mode;
    if (poiSupported) combined.pointsOfInterest = poi;
    try {
      await track.applyConstraints({ advanced: [combined] });
      applied = true;
      console.info('[focus] applyConstraints combinato OK', combined);
    } catch (err) {
      console.warn('[focus] applyConstraints combinato FALLITO', combined, err);
    }

    // Did it "hook"? If the device advertises a focusMode but getSettings() doesn't reflect the one
    // we asked for, the combined apply was silently ignored — retry the entries separately.
    const hooked = mode ? this.readSettings(track).focusMode === mode : applied;
    if (!applied || !hooked) {
      // 2) SEPARATE entries — each applied independently and caught on its own. focusMode first so
      //    the compatible mode is set before the POI (some devices require that ordering).
      const entries: any[] = [];
      if (mode) entries.push({ focusMode: mode });
      // Attempt POI even if it wasn't advertised: harmless (caught) and rescues devices that accept
      // it without listing it in capabilities.
      entries.push({ pointsOfInterest: poi });
      for (const entry of entries) {
        try {
          await track.applyConstraints({ advanced: [entry] });
          applied = true;
          console.info('[focus] applyConstraints separato OK', entry);
        } catch (err) {
          console.warn('[focus] applyConstraints separato FALLITO', entry, err);
        }
      }
    }

    // Log the resulting settings so the user can tell us whether focusMode / pointsOfInterest were
    // actually accepted by their camera.
    console.info('[focus] settings dopo apply', this.readSettings(track), { applied });
    return applied;
  }

  /** getSettings() defensively — some browsers throw or lack it. */
  private readSettings(track: any): any {
    try {
      return track.getSettings?.() ?? {};
    } catch (err) {
      console.warn('[focus] getSettings() ha lanciato', err);
      return {};
    }
  }

  /** Draws the current video frame into a fresh canvas at native resolution. */
  grabFrame(): HTMLCanvasElement {
    const w = this.video.videoWidth;
    const h = this.video.videoHeight;
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d')!;
    ctx.drawImage(this.video, 0, 0, w, h);
    return canvas;
  }
}
