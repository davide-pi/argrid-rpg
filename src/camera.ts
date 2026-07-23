// Thin wrapper around getUserMedia for the rear camera, with graceful
// start/stop. On desktops without a camera the caller falls back to file upload.

export class Camera {
  private stream: MediaStream | null = null;

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
