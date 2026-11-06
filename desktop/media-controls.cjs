const { ipcMain } = require('electron');
function setupMediaControls({ getWindow, origin, alarmActive, log }) {
  let native;
  try { native = require('./media-controls.node'); }
  catch (error) { log(`Native media controls unavailable: ${error.message}`); }
  let ready = false, played = false;
  if (native) native.start(json => {
    const event = JSON.parse(json);
    log(`Media control: ${event.action}${event.phase ? ' ' + event.phase : ''}`);
    const window = getWindow();
    if (ready && window && !window.isDestroyed() && !alarmActive()) window.webContents.send('media:action', event);
  });
  const allowed = event => {
    const window = getWindow();
    return window && event.sender === window.webContents && event.senderFrame === window.webContents.mainFrame && new URL(event.senderFrame.url).origin === origin();
  };
  ipcMain.handle('media:ready', event => { if (!allowed(event)) return false; ready = true; return !!native; });
  ipcMain.handle('media:status', event => allowed(event) && native ? JSON.parse(native.status()) : null);
  ipcMain.on('media:state', (event, state) => {
    if (!native || !ready || !allowed(event) || !state || typeof state.paused !== 'boolean' || !Number.isSafeInteger(state.id)) return;
    for (const key of ['title','artist','album']) if (typeof state[key] !== 'string' || state[key].length > 1000) return;
    if (!Number.isFinite(state.position) || !Number.isFinite(state.duration) || state.duration < 0 || state.position < 0) return;
    if (state.id > 0 && !state.paused) played = true;
    native.update(JSON.stringify({ ...state, active: played && state.id > 0, position: Math.min(state.duration, state.position) }));
  });
  return { reset: () => { ready = false; }, close: () => { native?.update(JSON.stringify({ active: false })); } };
}
module.exports = { setupMediaControls };
