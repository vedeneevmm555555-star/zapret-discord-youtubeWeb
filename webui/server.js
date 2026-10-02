const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn, execFile } = require('child_process');
const { TextDecoder } = require('util');

const CP866 = new TextDecoder('ibm866');
function decodeWindows(buffer) {
  if (!buffer) return '';
  if (typeof buffer === 'string') return buffer;
  const bytes = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
  const utf8 = bytes.toString('utf8');
  // Windows console programs on Russian systems commonly write CP866.
  // Keep UTF-8 when it is clearly valid; otherwise decode as CP866.
  if (!utf8.includes('\uFFFD')) return utf8;
  return CP866.decode(bytes);
}
const os = require('os');

const ROOT = path.resolve(__dirname, '..');
const PUBLIC = path.join(__dirname, 'public');
const PORT = Number(process.env.ZAPRET_WEBUI_PORT || 40210);
const HOST = process.env.ZAPRET_WEBUI_HOST || '127.0.0.1';
const SERVICE = 'zapret';

function run(file, args = [], options = {}) {
  return new Promise((resolve) => {
    execFile(file, args, { windowsHide: true, timeout: options.timeout || 15000, encoding: 'buffer' },
      (error, stdout, stderr) => resolve({ ok: !error, code: error?.code ?? 0, stdout: decodeWindows(stdout), stderr: decodeWindows(stderr) }));
  });
}

function isAdmin() {
  return new Promise(resolve => {
    execFile('net', ['session'], { windowsHide: true }, err => resolve(!err));
  });
}

async function serviceState() {
  const r = await run('sc.exe', ['query', SERVICE]);
  const m = r.stdout.match(/STATE\s+:\s+\d+\s+(\w+)/i);
  return { installed: r.ok || /SERVICE_NAME/i.test(r.stdout), state: m ? m[1] : 'NOT_INSTALLED' };
}

async function processRunning(name) {
  const r = await run('tasklist.exe', ['/FI', 'IMAGENAME eq ' + name]);
  return r.stdout.split(/\r?\n/).some(line => line.trim().toLowerCase().startsWith(name.toLowerCase() + ' '));
}

function currentStrategy() {
  try {
    const r = require('child_process').execFileSync('reg.exe',
      ['query','HKLM\\System\\CurrentControlSet\\Services\\zapret','/v','zapret-discord-youtube'],
      { encoding: 'utf8', windowsHide: true });
    const m = r.match(/zapret-discord-youtube\s+REG_SZ\s+(.+)/i);
    return m ? m[1].trim() : null;
  } catch { return null; }
}

function strategyList() {
  return fs.readdirSync(ROOT)
    .filter(f => f.toLowerCase().endsWith('.bat') && !f.toLowerCase().startsWith('service'))
    .sort((a,b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' }));
}

function runServiceMenu(inputs) {
  return new Promise(resolve => {
    const child = spawn(process.env.ComSpec || 'cmd.exe',
      ['/d','/c', 'service.bat admin'], { cwd: ROOT, windowsHide: true });
    const stdout = [], stderr = [];
    child.stdout.on('data', d => stdout.push(d));
    child.stderr.on('data', d => stderr.push(d));
    child.on('close', code => resolve({ ok: code === 0, code, stdout: decodeWindows(Buffer.concat(stdout)), stderr: decodeWindows(Buffer.concat(stderr)) }));
    child.stdin.write(inputs.map(String).join('\r\n') + '\r\n');
    child.stdin.end();
    setTimeout(() => { try { child.kill(); } catch {} }, 12000);
  });
}

function json(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, {'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});
  res.end(body);
}

async function status() {
  const svc = await serviceState();
  return {
    ok: true,
    admin: await isAdmin(),
    service: svc,
    winws: await processRunning('winws.exe'),
    windivert: (await run('sc.exe',['query','WinDivert'])).ok || (await run('sc.exe',['query','WinDivert14'])).ok || fs.existsSync(path.join(ROOT, 'bin', 'WinDivert64.sys')), 
    strategy: currentStrategy(),
    strategies: strategyList(),
    root: ROOT,
    version: '1.1.0'
  };
}

async function action(name, value) {
  if (!(await isAdmin())) return { ok:false, error:'Administrator privileges are required.' };

  switch (name) {
    case 'install': {
      const list = strategyList();
      const idx = list.indexOf(value);
      if (idx < 0) return {ok:false,error:'Выберите стратегию для установки сервиса.'};
      return runServiceMenu(['1', idx + 1, '', '0']);
    }
    case 'start': return run('sc.exe',['start',SERVICE]);
    case 'stop': return run('sc.exe',['stop',SERVICE]);
    case 'restart':
      await run('sc.exe',['stop',SERVICE]);
      await new Promise(r => setTimeout(r, 700));
      return run('sc.exe',['start',SERVICE]);
    case 'remove':
      await run('sc.exe',['stop',SERVICE]);
      return run('sc.exe',['delete',SERVICE]);
    case 'strategy': {
      const list = strategyList();
      const idx = list.indexOf(value);
      if (idx < 0) return {ok:false,error:'Неизвестная стратегия.'};
      return runServiceMenu(['1', idx + 1, '', '0']);
    }
    case 'game': return runServiceMenu(['4','0']);
    case 'ipset': return runServiceMenu(['5','0']);
    case 'autoupdate': return runServiceMenu(['6','0']);
    case 'fakes': return runServiceMenu(['7','0']);
    case 'ipset_update': return runServiceMenu(['8','0']);
    case 'hosts_update': return runServiceMenu(['9','0']);
    case 'check_updates': return runServiceMenu(['10','0']);
    case 'diagnostics': return runServiceMenu(['11','0']);
    case 'tests': return runServiceMenu(['12','0']);
    default: return {ok:false,error:'Unknown action.'};
  }
}

const server = http.createServer(async (req,res) => {
  try {
    const u = new URL(req.url, 'http://' + req.headers.host);
    if (u.pathname === '/api/status') return json(res,200,await status());
    if (u.pathname === '/api/action' && req.method === 'POST') {
      let raw=''; req.on('data',c=>raw+=c);
      req.on('end', async () => {
        try {
          const body = JSON.parse(raw || '{}');
          const result = await action(body.action, body.value);
          json(res, result.ok ? 200 : 400, result);
        } catch(e) { json(res,500,{ok:false,error:e.message}); }
      });
      return;
    }
    let file = u.pathname === '/' ? 'index.html' : u.pathname.replace(/^\/+/, '');
    const full = path.resolve(PUBLIC, file);
    if (!full.startsWith(PUBLIC + path.sep) || !fs.existsSync(full)) return json(res,404,{error:'Not found'});
    const ext = path.extname(full).toLowerCase();
    const types = {'.html':'text/html; charset=utf-8','.css':'text/css; charset=utf-8','.js':'application/javascript; charset=utf-8'};
    res.writeHead(200,{'Content-Type':types[ext] || 'application/octet-stream'});
    fs.createReadStream(full).pipe(res);
  } catch(e) { json(res,500,{ok:false,error:e.message}); }
});

server.listen(PORT, HOST, () => {
  console.log('Zapret Web UI: http://' + HOST + ':' + PORT);
  console.log('Root: ' + ROOT);
});
