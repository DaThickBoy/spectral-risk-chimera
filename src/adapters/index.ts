// Public API of src/adapters/ for the composition root (src/main/). Each submodule keeps its
// own index; this file re-exports the ones the root assembles. SEC and WebSocket adapters are
// not assembled yet (H8: no SEC connectivity in the hackathon slice).
export * from './fx/index.js';
export * from './http/index.js';
