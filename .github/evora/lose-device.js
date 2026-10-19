// Evora CI witness (EVORA-KIN-25), written by Evora: served by the smoke bench only, on a copy of
// the engine's page (the artefact is not modified). Every WebGPU device the engine's page requests
// is destroyed as soon as it is created, so the engine never draws a frame: the smoke test must
// then fail on « périphérique graphique perdu : GPU device lost (Destroyed) » and on « aucun widget
// à l'écran », the checks that guard the screen gates against a lost graphics device.
(() => {
  if (typeof GPUAdapter !== "function") return;
  const request = GPUAdapter.prototype.requestDevice;
  GPUAdapter.prototype.requestDevice = async function (...args) {
    const device = await request.apply(this, args);
    device.destroy();
    return device;
  };
})();
