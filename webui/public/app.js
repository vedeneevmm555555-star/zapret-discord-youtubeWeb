const $=s=>document.querySelector(s);
function stateText(v){return v==='RUNNING'?'Работает':v==='STOPPED'?'Остановлен':v==='NOT_INSTALLED'?'Не установлен':v?'Да':'Нет'}
function paint(el,good){el.textContent=stateText(el.dataset.raw);el.className=good?'ok':'bad'}
async function load(){
  try{
    const r=await fetch('/api/status',{cache:'no-store'});const d=await r.json();
    const svc=$('#service');svc.dataset.raw=d.service.state;svc.textContent=stateText(d.service.state);svc.className=d.service.state==='RUNNING'?'ok':'bad';
    const w=$('#winws');w.dataset.raw=d.winws;w.textContent=d.winws?'Работает':'Не запущен';w.className=d.winws?'ok':'bad';
    const wd=$('#windivert');wd.dataset.raw=d.windivert;wd.textContent=d.windivert?'Установлен':'Не найден';wd.className=d.windivert?'ok':'bad';
    $('#strategy').textContent=d.strategy||'Не выбрана';$('#admin').textContent=d.admin?'Права администратора: OK':'Нужны права администратора';
    const sel=$('#strategies');const old=sel.value;sel.innerHTML='';
    d.strategies.forEach(x=>{const o=document.createElement('option');o.value=x;o.textContent=x;sel.appendChild(o)});
    if(d.strategies.includes(old))sel.value=old;
    $('#serviceHint').textContent=d.service.installed?'Windows Service: zapret':'Windows Service не установлен';
  }catch(e){$('#log').textContent='Ошибка подключения: '+e.message}
}
async function act(action,value){
  $('#log').textContent='Выполняется: '+action+'…';
  try{const r=await fetch('/api/action',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action,value})});const d=await r.json();$('#log').textContent=d.stdout||d.stderr||d.error||'Готово';setTimeout(load,900)}catch(e){$('#log').textContent='Ошибка: '+e.message}
}
document.querySelectorAll('[data-action]').forEach(b=>b.onclick=()=>act(b.dataset.action));
$('#installStrategy').onclick=()=>act('install',$('#strategies').value);
$('#refresh').onclick=load;load();setInterval(load,5000);
