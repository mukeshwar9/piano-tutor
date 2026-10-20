// Mic mode capture: collects the microphone's 128-sample render blocks into 512-sample chunks and
// posts them to the link page, which runs the pitch tracker (public/pitch.js). Detection stays on
// the page so the same code runs where AudioWorklet is missing (ScriptProcessor fallback).
class PitchCapture extends AudioWorkletProcessor {
  constructor() {
    super();
    this.chunk = new Float32Array(512);
    this.n = 0;
  }

  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (ch) {
      for (let i = 0; i < ch.length; i++) {
        this.chunk[this.n++] = ch[i];
        if (this.n === this.chunk.length) {
          this.port.postMessage(this.chunk, [this.chunk.buffer]);
          this.chunk = new Float32Array(512);
          this.n = 0;
        }
      }
    }
    return true;
  }
}

registerProcessor("pitch-capture", PitchCapture);
