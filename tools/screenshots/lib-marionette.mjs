// Minimal Marionette (Firefox remote-protocol) client — no dependencies.
// Start Firefox with:  firefox --headless --marionette --profile <dir> --no-remote about:blank
// then: const m = await connect(); await m.send("WebDriver:NewSession", {}); ...

import net from "node:net";

export function connect(port = 2828) {
  return new Promise((resolve, reject) => {
    let buf = Buffer.alloc(0);
    let msgId = 0;
    const pending = new Map();
    const sock = net.connect(port, "127.0.0.1");

    sock.on("data", (d) => {
      buf = Buffer.concat([buf, d]);
      while (true) {
        const colon = buf.indexOf(0x3a); // ':'
        if (colon === -1) return;
        const len = parseInt(buf.slice(0, colon).toString("ascii"), 10);
        if (!Number.isFinite(len) || buf.length < colon + 1 + len) return;
        const payload = buf.slice(colon + 1, colon + 1 + len).toString("utf8");
        buf = buf.slice(colon + 1 + len);
        let msg;
        try { msg = JSON.parse(payload); } catch { continue; }
        if (Array.isArray(msg) && msg[0] === 1) {
          const [, id, err, result] = msg;
          const p = pending.get(id);
          if (p) { pending.delete(id); err ? p.reject(err) : p.resolve(result); }
        }
      }
    });
    sock.on("error", reject);

    const api = {
      send(name, params = {}) {
        const id = ++msgId;
        const frame = Buffer.from(JSON.stringify([0, id, name, params]), "utf8");
        sock.write(`${frame.length}:`);
        sock.write(frame);
        return new Promise((res, rej) => pending.set(id, { resolve: res, reject: rej }));
      },
      exec: (script, args = []) => api.send("WebDriver:ExecuteScript", { script, args }).then((r) => r.value),
      async findRef(selector, tries = 40, delay = 250) {
        for (let i = 0; i < tries; i++) {
          try {
            const r = await api.send("WebDriver:FindElement", { using: "css selector", value: selector });
            const v = r.value;
            const ref = v[Object.keys(v)[0]];
            if (ref) return ref;
          } catch {}
          await sleep(delay);
        }
        throw new Error("element not found: " + selector);
      },
      click: (ref) => api.send("WebDriver:ElementClick", elArgs(ref)),
      type: (ref, text) => api.send("WebDriver:ElementSendKeys", { ...elArgs(ref), text, value: [...text] }),
      async screenshot(path) {
        const s = await api.send("WebDriver:TakeScreenshot", { full: true, hash: false });
        const { writeFileSync } = await import("node:fs");
        writeFileSync(path, Buffer.from(s.value || s.data, "base64"));
      },
      close() { sock.end(); },
    };

    // wait for the server hello frame, then hand back the client
    setTimeout(() => resolve(api), 300);
  });
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function elArgs(ref) {
  return { id: ref, "element-6066-11e4-a52e-4f735466cecf": ref, ELEMENT: ref };
}
