const $=id=>document.getElementById(id);
const status=msg=>{$('status').textContent=msg;};
let lastUpdaterCheckId=null;
let manualUpdateTimer=null;
let manualUpdateBaseline=null;
let manualUpdateTries=0;
function updaterSummary(info) {
  const state=info?.state||'unknown';
  if(state==='current') return 'Обновлений нет — установлена актуальная версия.';
  if(state==='updated') return 'Новая версия установлена. Chrome должен её активировать.';
  if(state==='checking') return 'Выполняется проверка обновлений GitHub…';
  if(state==='error') return 'Ошибка проверки: '+(info.error_code||'неизвестная ошибка');
  return 'Ожидание первой проверки обновлений.';
}
function stopUpdateWatch() {
  if(manualUpdateTimer!==null) clearInterval(manualUpdateTimer);
  manualUpdateTimer=null;
}
async function watchManualUpdate() {
  manualUpdateTries++;
  try {
    const result=await chrome.runtime.sendMessage({type:'GET_UPDATE_STATUS'});
    if(result?.error) throw new Error(result.error);
    if(result?.check_id && result.check_id!==manualUpdateBaseline && result.trigger==='manual') {
      status(updaterSummary(result));
      if(['current','updated','error'].includes(result.state)) {
        stopUpdateWatch();
        await showVersion();
        return;
      }
    }
  } catch(err) {
    stopUpdateWatch();
    status('Не удалось прочитать результат обновления: '+err.message);
    return;
  }
  if(manualUpdateTries>=55) {
    stopUpdateWatch();
    status('Нет подтверждения запуска обновлятора. Проверьте запрос Chrome на открытие приложения Windows.');
  }
}
function isValidBase(raw) {
  const u=new URL(raw);
  if(u.username||u.password||u.search||u.hash) throw new Error('URL без параметров и паролей');
  if(u.protocol!=='https:' && !(u.protocol==='http:' && ['127.0.0.1','localhost'].includes(u.hostname))) {
    throw new Error('Укажите HTTPS-адрес');
  }
  return u;
}
async function showVersion() {
  const info=await chrome.runtime.sendMessage({type:'GET_VERSION'});
  if(!info || info.error) throw new Error(info?.error || 'Версия недоступна');
  $('activeRevision').textContent=info.active_revision || 'не подтверждена';
  $('installedRevision').textContent=info.installed_revision || 'не определена';
  $('manifestVersion').textContent=info.manifest_version || '—';
  $('integrity').textContent=info.runtime_integrity==='ok' ? 'проверена' :
    info.runtime_integrity==='mismatch' ? 'несовпадение файлов' : 'не проверена';
  const updater=info.updater||{};
  lastUpdaterCheckId=updater.check_id||null;
  $('updateStatus').textContent=(updater.trigger==='manual' ? 'Ручная проверка. ' : updater.trigger==='scheduled' ? 'Автоматическая проверка. ' : '')+updaterSummary(updater)+
    (updater.checked_at ? ' Проверено: '+updater.checked_at : '');
  $('heartbeatStatus').textContent=info.last_connection_error ?
    'Ошибка: '+info.last_connection_error : (info.last_heartbeat_at || 'нет подтверждения');
}
async function init() {
  const {config,lastResult,lastError,pendingReport}=await chrome.storage.local.get(['config','lastResult','lastError','pendingReport']);
  if(config) {
    $('url').value=config.url||'';$('device').value=config.deviceId||'desktop';
    $('token').value=config.token||'';$('enabled').checked=!!config.enabled;
  }
  if(pendingReport) status('Команда ожидает подтверждения: '+pendingReport.job_id+' ('+pendingReport.status+')');
  else if(lastResult) status(`${lastResult.status}: ${lastResult.message||''}\n${lastResult.chat_url||''}`);
  else if(lastError) status('Ошибка связи: '+lastError.message);
  try {await showVersion();} catch(err) {status('Ошибка сведений о версии: '+err.message);}
}
$('save').addEventListener('click',async()=>{
  $('save').disabled=true;
  try {
    const u=isValidBase($('url').value.trim());
    // Chrome permission match patterns must not include port numbers.
    // The configured fetch URL below retains its exact port (e.g. :8177).
    const origin=u.protocol+'//'+u.hostname+'/*';
    // Must be called directly from user gesture to request Chrome permission.
    const granted=await chrome.permissions.request({origins:[origin]});
    if(!granted) throw new Error('Разрешение Chrome на доступ к серверу не получено');
    const config={url:u.origin+u.pathname.replace(/\/+$/,''),deviceId:$('device').value.trim(),
      token:$('token').value.trim(),enabled:$('enabled').checked};
    const result=await chrome.runtime.sendMessage({type:'CONFIGURE',config});
    if(result.error) throw new Error(result.error);
    status(config.enabled ? 'Настройки сохранены. Приём команд включён.' : 'Настройки сохранены. Приём команд выключен; отчёты о версии включены.');
    await showVersion();
  } catch(err) {status('Ошибка: '+err.message);}
  finally {$('save').disabled=false;}
});
$('poll').addEventListener('click',async()=>{
  $('poll').disabled=true;status('Проверяю очередь…');
  try {
    const result=await chrome.runtime.sendMessage({type:'POLL_NOW'});
    if(result.error) throw new Error(result.error);
    status(result.commands_disabled ? 'Сервер получил версию. Приём команд выключен.' :
      result.commands_blocked ? 'Сервер получил версию, но отправка заблокирована до проверки обновления.' :
      result.idle ? 'Связь установлена, очередь пуста.' : JSON.stringify(result,null,2));
    await showVersion();
  } catch(err) {status('Ошибка: '+err.message);}
  finally {$('poll').disabled=false;}
});
$('updateNow').addEventListener('click',()=>{
  // Native click to a registered OS protocol; leave default navigation intact.
  // The OS may request the user's approval to launch the registered app.
  stopUpdateWatch();
  manualUpdateBaseline=lastUpdaterCheckId;
  manualUpdateTries=0;
  status('Запрашиваю проверку обновлений. Если Chrome спросит разрешение открыть приложение Windows, подтвердите.');
  // Only poll one tiny local JSON status file while THIS popup stays open.
  // Reopening the popup later also shows the latest terminal result.
  manualUpdateTimer=setInterval(()=>watchManualUpdate(),1200);
});
$('refresh').addEventListener('click',async()=>{
  try {await showVersion();} catch(err) {status('Ошибка: '+err.message);}
});
init();
