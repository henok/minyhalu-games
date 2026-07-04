// Tiny WebSocket wrapper with named message handlers.

export class Net {
  constructor() {
    this.handlers = {};
    this.ws = null;
  }
  connect() {
    return new Promise((resolve, reject) => {
      const proto = location.protocol === 'https:' ? 'wss' : 'ws';
      this.ws = new WebSocket(`${proto}://${location.host}`);
      this.ws.onopen = () => resolve();
      this.ws.onerror = (e) => reject(e);
      this.ws.onmessage = (ev) => {
        let msg;
        try { msg = JSON.parse(ev.data); } catch { return; }
        const fn = this.handlers[msg.t];
        if (fn) fn(msg);
      };
      this.ws.onclose = () => {
        const fn = this.handlers._closed;
        if (fn) fn();
      };
    });
  }
  on(type, fn) { this.handlers[type] = fn; }
  send(obj) {
    if (this.ws && this.ws.readyState === 1) this.ws.send(JSON.stringify(obj));
  }
}
