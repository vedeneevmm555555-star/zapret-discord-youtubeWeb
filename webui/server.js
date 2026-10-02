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

function readFlag(name) {
  return fs.existsSync(path.join(ROOT, 'utils', name));
}

function toggleFlag(name) {
  const file = path.join(ROOT, 'utils', name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (fs.existsSync(file)) {
    fs.unlinkSync(file);
    return false;
  }
  fs.writeFileSync(file, 'ENABLED\r\n', 'utf8');
  return true;
}

function ipsetMode() {
  const file = path.join(ROOT, 'lists', 'ipset-all.txt');
  const backup = file + '.backup';
  if (!fs.existsSync(file)) return 'any';
  const data = fs.readFileSync(file, 'utf8').trim();
  if (!data) return 'any';
  if (data.includes('203.0.113.113/32')) return 'none';
  return 'loaded';
}

function cycleIpset() {
  const file = path.join(ROOT, 'lists', 'ipset-all.txt');
  const backup = file + '.backup';
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const mode = ipsetMode();

  if (mode === 'loaded') {
    if (fs.existsSync(backup)) fs.unlinkSync(backup);
    fs.renameSync(file, backup);
    fs.writeFileSync(file, '203.0.113.113/32\r\n', 'utf8');
    return 'none';
  }
  if (mode === 'none') {
    fs.writeFileSync(file, '', 'utf8');
    return 'any';
  }
  if (fs.existsSync(backup)) {
    if (fs.existsSync(file)) fs.unlinkSync(file);
    fs.renameSync(backup, file);
    return 'loaded';
  }
  return 'any';
}

function fakeList() {
  const bin = path.join(ROOT, 'bin');
  if (!fs.existsSync(bin)) return [];
  return fs.readdirSync(bin)
    .filter(f => f.toLowerCase().endsWith('.bin') && !f.toUpperCase().startsWith('ACTIVE_'))
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
    gameFilter: readFlag('game_filter.enabled'),
    autoUpdate: readFlag('check_updates.enabled'),
    ipsetMode: ipsetMode(),
    fakes: fakeList(),
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
    case 'game': {
      const enabled = toggleFlag('game_filter.enabled');
      return {ok:true, stdout:'Game Filter: ' + (enabled ? 'включен' : 'выключен') + '. Перезапустите Zapret для применения.'};
    }
    case 'ipset': {
      const mode = cycleIpset();
      return {ok:true, stdout:'IPSet Filter: режим ' + mode + '.'};
    }
    case 'autoupdate': {
      const enabled = toggleFlag('check_updates.enabled');
      return {ok:true, stdout:'Auto-Update Check: ' + (enabled ? 'включен' : 'выключен') + '.'};
    }
    case 'fakes': {
      if (!value || !['1','2'].includes(String(value.type)) || !value.file) {
        return {ok:false,error:'Выберите тип fake и файл.'};
      }
      const src = path.join(ROOT, 'bin', path.basename(String(value.file)));
      if (!fakeList().includes(path.basename(src))) return {ok:false,error:'Файл fake не найден.'};
      const target = path.join(ROOT, 'bin', String(value.type) === '1' ? 'ACTIVE_DISCORD_UDP.bin' : 'ACTIVE_GAME_UDP.bin');
      fs.copyFileSync(src, target);
      return {ok:true, stdout:'Fake-файл заменен: ' + path.basename(target) + ' ← ' + path.basename(src)};
    }
    case 'ipset_update': {
      return run('powershell.exe', ['-NoProfile','-ExecutionPolicy','Bypass','-Command',
        "$u='https://raw.githubusercontent.com/Flowseal/zapret-discord-youtube/refs/heads/main/.service/ipset-service.txt'; $o='" + path.join(ROOT,'lists','ipset-all.txt').replace(/'/g,"''") + "'; Invoke-WebRequest -Uri $u -UseBasicParsing -TimeoutSec 15 -OutFile $o; Write-Output 'IPSet List обновлен.'"]);
    }
    case 'hosts_update':
      return {ok:false,error:'Обновление Hosts требует интерактивного подтверждения и пока запускается из service.bat.'};
    case 'check_updates':
      return run('cmd.exe',['/d','/c','service.bat','check_updates','soft']);
    case 'diagnostics': {
      const child = spawn(process.env.ComSpec || 'cmd.exe',['/d','/k','service.bat','admin'],{cwd:ROOT,detached:true,stdio:'ignore'});
      child.unref();
      return {ok:true,stdout:'Диагностика открыта в отдельном окне.'};
    }
    case 'tests': {
      const child = spawn(process.env.ComSpec || 'cmd.exe',['/d','/k','service.bat','admin'],{cwd:ROOT,detached:true,stdio:'ignore'});
      child.unref();
      return {ok:true,stdout:'Меню тестов открыто в отдельном окне.'};
    }
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
