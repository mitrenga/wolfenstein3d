const { AdlibIMF } = await import('./svision/js/audio/chip/adlibIMF.js?ver='+window.srcVersion);
// begin code

/**
 * The music renderer, in a thread of its own.
 *
 * A track of Wolfenstein is a minute of OPL2 and takes about five seconds of
 * processor to render. There are three places that could happen and only one
 * of them is any good:
 *
 * - **in the page**, a slice at a time between frames: the audio manager did
 *   that at first, and with a budget small enough not to stutter the game
 *   (eight milliseconds in every hundred) the first tune of a level was ready
 *   after a minute and a half. In practice the music never played at all.
 * - **in the game worker**: it is busy being the game, seventy times a
 *   second.
 * - **here**: a worker that does nothing else. Five seconds of it cost the
 *   page nothing, and the samples come back as a buffer that is handed over
 *   rather than copied.
 *
 * The whole renderer is the library's `AdlibIMF` over its `OPL2`, both of
 * them free of DOM by design (R-001) - which is exactly what makes this
 * possible. The same class runs under Node for the tools: `new
 * MusicWorker(post)` and `handleMessage()`, no worker anywhere.
 *
 * ## The protocol
 *
 * | zpráva | význam |
 * |---|---|
 * | `{id:'render', index, stream, sampleRate, gain}` | render this track |
 * | `{id:'cancel'}` | forget what has not been rendered yet |
 *
 * and back:
 *
 * | zpráva | význam |
 * |---|---|
 * | `{id:'rendered', index, samples, sampleRate, seconds, ms}` | the samples, transferred |
 * | `{id:'failed', index, message}` | a track that could not be rendered |
 */
export class MusicWorker {

  /**
   * @param {Function} post - Sends a message back (`postMessage`).
   */
  constructor(post) {
    this.id = 'MusicWorker';
    this.post = post;
    /** how many tracks have been rendered, for a report */
    this.rendered = 0;
  } // constructor

  /**
   * One message.
   * @param {Object} msg - `{id, ...}`.
   */
  handleMessage(msg) {
    switch (msg.id) {
      case 'render':
        this.render(msg);
        break;
      case 'cancel':
        break;
    }
  } // handleMessage

  /**
   * Renders one track whole and sends it back.
   * @param {Object} msg - `{index, stream, sampleRate, gain}`.
   */
  render(msg) {
    var started = MusicWorker.now();
    try {
      var stream = msg.stream instanceof Uint8Array ? msg.stream : new Uint8Array(msg.stream);
      var player = new AdlibIMF({sampleRate: msg.sampleRate, gain: msg.gain});
      player.play(stream);
      var samples = player.renderAll();
      this.rendered++;
      this.post({
        id: 'rendered', index: msg.index, samples: samples,
        sampleRate: player.sampleRate, seconds: player.pieceSeconds,
        ms: Math.round(MusicWorker.now()-started)
      }, [samples.buffer]);
    } catch (error) {
      this.post({id: 'failed', index: msg.index, message: error.message});
    }
  } // render

  static now() {
    return (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
  } // now

} // MusicWorker

// In the worker the renderer wires itself up; under Node and on the main
// thread it stays a class.
if (typeof self !== 'undefined' && typeof self.postMessage === 'function' && typeof self.document === 'undefined') {
  var musicWorker = new MusicWorker(function(msg, transfer) { self.postMessage(msg, transfer || []); });
  self.onmessage = function(event) { musicWorker.handleMessage(event.data); };
}
