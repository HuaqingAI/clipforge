const { test } = require("node:test");
const assert = require("node:assert/strict");
const { spawn, execFileSync } = require("node:child_process");
const { mkdtemp, writeFile, rm } = require("node:fs/promises");
const { tmpdir } = require("node:os");
const path = require("node:path");

const supervisor = path.resolve(__dirname, "../server-entry.cjs");

async function launch(t, source) {
  const directory = await mkdtemp(path.join(tmpdir(), "clipforge-supervisor-中文 空格-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const entry = path.join(directory, "server.cjs");
  await writeFile(entry, source(directory));
  const child = spawn(process.execPath, [supervisor, entry], { windowsHide: true, stdio: ["ignore", "ignore", "pipe", "ipc"] });
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", value => { stderr += value; });
  const messages = [];
  const waiters = new Set();
  child.on("message", message => {
    messages.push(message);
    for (const waiter of waiters) waiter(message);
  });
  const exited = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => { resolve({ code, signal }); });
  });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill();
    await exited;
  });
  return {
    child, messages,
    waitFor: predicate => {
      const found = messages.find(predicate);
      if (found) return Promise.resolve(found);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { waiters.delete(waiter); reject(new Error(`Supervisor IPC timed out: ${stderr}`)); }, 5000);
        const waiter = message => {
          if (predicate(message)) { clearTimeout(timer); waiters.delete(waiter); resolve(message); }
        };
        waiters.add(waiter);
        exited.then(() => { clearTimeout(timer); waiters.delete(waiter); reject(new Error(`Supervisor exited before IPC result: ${stderr}`)); });
      });
    },
    finished: async () => { assert.deepEqual(await exited, { code: 0, signal: null }, stderr); },
  };
}

function assertTracked(messages, pids) {
  for (const pid of pids) {
    assert.equal(messages.filter(message => message.type === "clipforge:child-start" && message.pid === pid).length, 1);
    assert.equal(messages.filter(message => message.type === "clipforge:child-end" && message.pid === pid).length, 1);
  }
}

for (const method of ["execFile", "exec"]) {
  test(`supervisor preserves ${method} promise output, errors, buffers and tracked children`, { timeout: 15_000 }, async t => {
    const instance = await launch(t, directory => {
      const payload = path.join(directory, "output.cjs");
      return `
        const assert = require('node:assert/strict');
        const cp = require('node:child_process');
        const { promisify } = require('node:util');
        const { once } = require('node:events');
        require('node:fs').writeFileSync(${JSON.stringify(payload)}, "const binary=process.argv[2]==='buffer';process.stdout.write(binary?Buffer.from([0,127,255]):JSON.stringify({ok:true}));process.stderr.write(binary?Buffer.from([254,1,128]):'diagnostic');process.exitCode=Number(process.argv[3]);");
        (async () => {
          const esm = await import('node:child_process');
          assert.equal(esm.${method}, cp.${method});
          assert.equal(typeof esm.${method}[promisify.custom], 'function');
          const pids = [];
          for (const encoding of ['utf8', 'buffer']) for (const code of [0, 7]) {
            const format = encoding === 'buffer' ? 'buffer' : 'json';
            const options = { encoding, windowsHide: true };
            const args = ${JSON.stringify(method)} === 'execFile'
              ? [process.execPath, [${JSON.stringify(payload)}, format, String(code)], options]
              : ['"' + process.execPath + '" "' + ${JSON.stringify(payload)} + '" ' + format + ' ' + code, options];
            const operation = promisify(esm.${method})(...args);
            assert.ok(operation.child instanceof cp.ChildProcess);
            assert.ok(operation.child.pid > 0);
            pids.push(operation.child.pid);
            const closed = once(operation.child, 'close');
            const stdout = encoding === 'buffer' ? Buffer.from([0, 127, 255]) : '{"ok":true}';
            const stderr = encoding === 'buffer' ? Buffer.from([254, 1, 128]) : 'diagnostic';
            if (code) await assert.rejects(operation, error => {
              assert.equal(error.code, code);
              assert.deepEqual(error.stdout, stdout);
              assert.deepEqual(error.stderr, stderr);
              return true;
            });
            else assert.deepEqual(await operation, { stdout, stderr });
            await closed;
          }
          const callbackArgs = ${JSON.stringify(method)} === 'execFile'
            ? [process.execPath, [${JSON.stringify(payload)}, 'json', '0'], { windowsHide: true }]
            : ['"' + process.execPath + '" "' + ${JSON.stringify(payload)} + '" json 0', { windowsHide: true }];
          await new Promise((resolve, reject) => {
            const child = cp.${method}(...callbackArgs, (error, stdout, stderr) => {
              if (error) return reject(error);
              try { assert.equal(stdout, '{"ok":true}'); assert.equal(stderr, 'diagnostic'); resolve(); }
              catch (failure) { reject(failure); }
            });
            pids.push(child.pid);
          });
          process.send({ type: 'test:result', pids }, () => process.exit(0));
        })().catch(error => { console.error(error); process.exit(1); });
      `;
    });
    const result = await instance.waitFor(message => message.type === "test:result");
    await instance.finished();
    assert.equal(result.pids.length, 5);
    assertTracked(instance.messages, result.pids);
  });
}

test("supervisor allows ffprobe JSON parsing after a real media process", { timeout: 15_000 }, async t => {
  const ffmpeg = require("ffmpeg-static");
  const ffprobe = require("@ffprobe-installer/ffprobe").path;
  const instance = await launch(t, directory => {
    const image = path.join(directory, "generated-grid.png");
    execFileSync(ffmpeg, ["-v", "error", "-f", "lavfi", "-i", "color=c=red:s=90x162", "-frames:v", "1", image], { windowsHide: true });
    return `
      const { execFile } = require('node:child_process');
      const { promisify } = require('node:util');
      (async () => {
        const operation = promisify(execFile)(${JSON.stringify(ffprobe)}, ['-v', 'error', '-show_entries', 'stream=width,height', '-of', 'json', ${JSON.stringify(image)}], { windowsHide: true });
        const { stdout, stderr } = await operation;
        const parsed = JSON.parse(stdout);
        process.send({ type: 'test:result', pid: operation.child.pid, streams: parsed.streams, stderr }, () => process.exit(0));
      })().catch(error => { console.error(error); process.exit(1); });
    `;
  });
  const result = await instance.waitFor(message => message.type === "test:result");
  await instance.finished();
  assert.deepEqual(result.streams, [{ width: 90, height: 162 }]);
  assert.equal(result.stderr, "");
  assertTracked(instance.messages, [result.pid]);
});

test("supervisor shutdown keeps tracking active promise children and prevents new work", { timeout: 15_000 }, async t => {
  const instance = await launch(t, () => `
    const assert = require('node:assert/strict');
    const cp = require('node:child_process');
    const { promisify } = require('node:util');
    const pending = promisify(cp.execFile)(process.execPath, ['-e', 'setTimeout(()=>{},20000)'], { windowsHide: true });
    pending.catch(() => {});
    process.on('SIGTERM', () => {
      assert.throws(() => cp.spawn(process.execPath, ['-e', '']), /正在退出/);
      assert.throws(() => promisify(cp.execFile)(process.execPath, ['-e', '']), /正在退出/);
      assert.throws(() => promisify(cp.exec)('echo should-not-run'), /正在退出/);
      pending.child.kill();
      pending.child.once('close', () => process.exit(0));
    });
    process.send({ type: 'test:ready', pid: pending.child.pid });
  `);
  const ready = await instance.waitFor(message => message.type === "test:ready");
  instance.child.send({ type: "clipforge:shutdown" });
  const stopping = await instance.waitFor(message => message.type === "clipforge:stopping");
  assert.deepEqual(stopping.pids, [ready.pid]);
  await instance.finished();
  assertTracked(instance.messages, [ready.pid]);
});

test("supervisor kills an active promisified child after the Electron IPC connection closes", { timeout: 15_000 }, async t => {
  const instance = await launch(t, () => `
    const { execFile } = require('node:child_process');
    const { promisify } = require('node:util');
    const pending = promisify(execFile)(process.execPath, ['-e', 'setTimeout(()=>{},20000)'], { windowsHide: true });
    pending.catch(() => {});
    process.on('SIGTERM', () => process.exit(0));
    process.send({ type: 'test:ready', pid: pending.child.pid });
  `);
  const ready = await instance.waitFor(message => message.type === "test:ready");
  instance.child.disconnect();
  await instance.finished();
  assert.throws(() => process.kill(ready.pid, 0), { code: "ESRCH" });
});
