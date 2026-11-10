import {download,isDownloaded,removeDownload,downloadedBytes,cachedKeys,clearOffline} from './offline.js';
import {createAudioLoader} from './player-audio.js';
const SKIP_SECONDS=15;
const nodes=new Map();
const $=s=>{if(!/^#[\w-]+$/.test(s))return document.querySelector(s);if(!nodes.has(s))nodes.set(s,document.querySelector(s));return nodes.get(s);},$$=s=>[...document.querySelectorAll(s)];
const text=(s,value)=>{const el=$(s);if(el.textContent!==String(value))el.textContent=value;};
const html=(s,value)=>{const el=$(s);if(el._html!==value){el.innerHTML=value;el._html=value;}};
const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const icon=(name)=>`<svg aria-hidden="true"><use href="#i-${name}"/></svg>`;
const clock=s=>{s=Math.max(0,Math.floor(s||0));return s>=3600?`${Math.floor(s/3600)}:${String(Math.floor(s/60)%60).padStart(2,'0')}:${String(s%60).padStart(2,'0')}`:`${Math.floor(s/60)}:${String(s%60).padStart(2,'0')}`;};
const duration=s=>{const m=Math.floor((s||0)/60);return m>=60?`${Math.floor(m/60)} ч ${m%60} мин`:`${m} мин`;};
const bytes=n=>n>=1024**3?`${(n/1024**3).toFixed(1)} ГБ`:`${Math.round((n||0)/1024**2)} МБ`;
const read=(k,def)=>{try{return JSON.parse(localStorage.getItem(k))??def;}catch{return def;}};
let storageWarning=false,loggingOut=false,localStateCleared=false;
const save=(k,v)=>{if(localStateCleared)return false;try{localStorage.setItem(k,JSON.stringify(v));return true;}catch{if(!storageWarning){storageWarning=true;toast('Не удалось сохранить данные на устройстве. Освободи место.');}return false;}};
let books=read('books',[]),positions=read('positions',{}),current=null,track=0,filter='all',view='library',downloaded=new Set(),downloading=null,uploadController=null,files=[],timer=null,timerEnd=0,sleepChapter=false,setup=false,syncing=false,toastTimeout,activeLoad=0;
const audio=$('#audio');
const audioLoader=createAudioLoader(audio);
let audioLoading=false,audioFailed=false,pendingTime=0,scrubbing=false,scanVersion=0;
const markSyncs=new Map();
function updateDownloadButton(){
 if(!current)return;
 const button=$('#player-download'),busy=downloading?.id===current.id,done=downloaded.has(current.id);
 const state=busy?'downloading':done?'downloaded':'idle';
 const label=busy?(downloading.preparing?'Готовлю':Math.floor(downloading.progress*100)+'%'):done?'Скачано':'Скачать';
 button.dataset.state=state;
 html('#player-download',icon(busy?'pause':done?'check':'download')+'<span>'+label+'</span>');
 button.ariaLabel=busy?'Приостановить скачивание: '+label:done?'Книга скачана для офлайн прослушивания':'Скачать книгу для офлайн прослушивания';
 button.title=button.ariaLabel;
}
function playbackControls(){
 for(const id of ['play','rewind','forward','seek','bookmark'])$('#'+id).disabled=audioLoading;
 $('#player-dialog').setAttribute('aria-busy',String(audioLoading));
}
function toast(s){const el=$('#toast');const dialog=$$('dialog[open]').at(-1);(dialog||document.body).append(el);el.textContent=s;el.hidden=false;clearTimeout(toastTimeout);toastTimeout=setTimeout(()=>el.hidden=true,6000);}
async function api(url,options={}){const res=await fetch(url,{...options,headers:{'Content-Type':'application/json',...options.headers}});const data=await res.json();if(!res.ok)throw Object.assign(Error(data.error||'Ошибка запроса'),{status:res.status});return data;}
const post=(url,data)=>api(url,{method:'POST',body:JSON.stringify(data)});
function cover(b){return `<div class="cover ${b.title==='Азазель'?'variant':''}">${b.cover?`<img src="${esc(b.cover)}" alt="Обложка ${esc(b.title)}" loading="lazy">`:''}<span class="cover-author">${esc(b.author||'Аудиокнига')}</span><span class="cover-name">${esc(b.title)}</span><span class="cover-flower">❧</span></div>`;}
function pct(b){return Math.min(100,Math.round((positions[b.id]?.time||0)/b.duration*100));}
function pick(){return books.find(b=>b.id===read('lastBook',null))||books[0];}
function theme(){const value=read('theme','system');$('#theme').value=value;document.documentElement.dataset.theme=value==='system'?(matchMedia('(prefers-color-scheme:dark)').matches?'dark':'light'):value;}
theme();matchMedia('(prefers-color-scheme:dark)').addEventListener('change',theme);
$('#theme').onchange=e=>{save('theme',e.target.value);theme();};
function render(){
 $('#nav-count').textContent=books.length;$('#book-count').textContent=books.length;$('#library-total').textContent=`${duration(books.reduce((n,b)=>n+b.duration,0))} историй`;
 const b=pick();$('#continue').innerHTML=b?`<div class="continue-card">${cover(b)}<div class="continue-info"><p class="eyebrow">${pct(b)>0?'ПРОДОЛЖИТЬ СЛУШАТЬ':'ТВОЯ СЛЕДУЮЩАЯ ИСТОРИЯ'}</p><h2>${esc(b.title)}</h2><p class="muted">${esc(b.author)}</p><div class="progress-line"><span style="width:${pct(b)}%"></span></div><div class="progress-caption"><span>Осталось ${duration((b.duration-(positions[b.id]?.time||0))/(positions[b.id]?.speed||1))}</span><span>${pct(b)}%</span></div><button class="primary" data-open="${b.id}" data-autoplay="1">${icon('play')}${pct(b)>0?'Продолжить':'Начать слушать'}</button></div></div>`:'';
 const search=$('#search').value.trim().toLocaleLowerCase('ru');const shown=books.filter(b=>(b.title+' '+b.author).toLocaleLowerCase('ru').includes(search)).filter(b=>filter==='all'||filter==='downloaded'&&downloaded.has(b.id)||filter==='listening'&&pct(b)>0&&pct(b)<100||filter==='finished'&&pct(b)>=100);
 $('#books').innerHTML=shown.length?shown.map(b=>`<article class="book-card"><button class="book-open" data-open="${b.id}"><div class="book-art">${cover(b)}${downloaded.has(b.id)?`<span class="download-badge">${icon('check')}</span>`:''}</div><h3>${esc(b.title)}</h3><p class="book-author">${esc(b.author||'Автор не указан')}</p></button><div class="book-meta"><span>${duration(b.duration)} · ${b.tracks.length===1?'1 файл':b.tracks.length+' файлов'}</span><button class="icon-button" data-download="${b.id}" aria-label="${downloaded.has(b.id)?'Скачано':'Скачать '+esc(b.title)}">${icon(downloaded.has(b.id)?'check':'download')}</button></div>${pct(b)>0?`<div class="progress-line"><span style="width:${pct(b)}%"></span></div>`:''}</article>`).join(''):`<div class="empty"><h2>${books.length?'Здесь пока тихо':'Твоя полка ждёт первую книгу'}</h2><p>${books.length?'Попробуй другой фильтр или название.':'Добавь один файл или сразу все главы.'}</p>${books.length?'':'<button class="secondary" data-add>Добавить книгу</button>'}</div>`;
 const side=current||b;$('#now-content').innerHTML=side?`${cover(side)}<h2>${esc(side.title)}</h2><p class="muted">${esc(side.author)}</p><button class="primary" data-open="${side.id}">${icon('play')}Открыть плеер</button><div class="side-info"><span>Длительность</span><b>${duration(side.duration)}</b></div><div class="side-info"><span>Файлы</span><b>${side.tracks.length}</b></div><div class="side-info"><span>Размер</span><b>${bytes(side.size)}</b></div>`:'<p class="muted">Добавь книгу, и она появится здесь.</p>';
 renderDownloads();updateDownloadButton();document.querySelectorAll('img').forEach(img=>img.onerror=()=>img.hidden=true);
}
function renderDownloads(){const list=books.filter(b=>downloaded.has(b.id)||downloading?.id===b.id);$('#download-list').innerHTML=list.length?list.map(b=>`<div class="download-row" ${downloading?.id===b.id?'data-active-download':''}>${cover(b)}<div><h3>${esc(b.title)}</h3><p>${downloading?.id===b.id?`Скачивание · ${Math.round(downloading.progress*100)}%`:`Скачано · ${bytes(b.size)}`}</p>${downloading?.id===b.id?`<progress value="${downloading.progress}" max="1"></progress>`:''}</div><button class="secondary" ${downloading?.id===b.id?'data-stop-download':`data-remove="${b.id}"`}>${downloading?.id===b.id?'Пауза':'Удалить'}</button></div>`).join(''):'<div class="empty"><h2>Возьми историю с собой</h2><p>Нажми значок скачивания у книги в библиотеке.</p></div>';}
async function scanDownloads(){
 const version=++scanVersion,found=new Set();
 if('caches'in window){const keys=await cachedKeys().catch(()=>new Set());for(const b of books)if(await isDownloaded(b,keys).catch(()=>false))found.add(b.id);}
 if(version!==scanVersion)return;
 downloaded=found;render();tick();
}
function showView(v){view=v;$$('.view').forEach(x=>x.hidden=x.id!==v+'-view');$$('[data-view]').forEach(x=>x.classList.toggle('active',x.dataset.view===v));$('#page-label').textContent={library:'Книги',downloads:'Загрузки',settings:'Настройки'}[v];if(v==='settings')settings();window.scrollTo(0,0);}
async function settings(){const s=await navigator.storage?.estimate().catch(()=>null);$('#device-storage').textContent=s?`Занято приложением: ${bytes(s.usage)}. Оценка квоты браузера: ${bytes(s.quota)}.`:'Браузер не сообщает объём хранилища.';try{const d=await api('/api/storage');$('#server-storage').textContent=`Книги: ${bytes(d.used)} из ${bytes(d.limit)}. Свободно на диске: ${bytes(d.free)}.`;}catch{$('#server-storage').textContent='Сервер сейчас недоступен.';}}
$('#persist').onclick=async()=>toast(await navigator.storage?.persist()?'Постоянное хранение разрешено':'Браузер не предоставил постоянное хранение. Книги остаются на сервере.');
function globalTime(){if(audioLoading)return pendingTime;return current?Math.min(current.duration,(current.tracks[track]?.start||0)+(audio.currentTime||0)):0;}
function currentChapter(){const time=globalTime();return current.chapters.findLast(c=>c.start<=time)||{title:current.title,start:0,end:current.duration};}
function remember(){if(localStateCleared)return;if(!current||audioLoading||audio.readyState===0)return;const old=positions[current.id]||{};if(old.time===globalTime()&&old.speed===audio.playbackRate)return;positions[current.id]={...old,bookId:current.id,time:globalTime(),speed:audio.playbackRate,updatedAt:Date.now(),revision:old.revision||0,dirty:true};save('positions',positions);}
async function sync(keepalive=false){
 if(syncing||!navigator.onLine)return;syncing=true;
 try{for(const [id,p]of Object.entries(positions)){if(!p.dirty||p.conflict)continue;const sent={...p};try{const r=await api(`/api/books/${id}/progress`,{method:'PUT',keepalive,body:JSON.stringify({...sent,baseRevision:sent.revision||0})});if(positions[id].updatedAt===sent.updatedAt)positions[id]={...r,dirty:false};else positions[id].revision=r.revision;save('positions',positions);}catch(e){if(e.status===409){positions[id].conflict=true;save('positions',positions);toast('Позиции на устройствах различаются. Выбери нужную в плеере.');}else break;}}
 }finally{syncing=false;}
}
async function loadLibrary(){if(loggingOut||localStateCleared)return;try{const data=await api('/api/books');books=data.books;for(const p of data.progress){const local=positions[p.bookId];if(!local?.dirty||(local.time===p.time&&local.speed===p.speed))positions[p.bookId]={...p,dirty:false};}save('positions',positions);save('books',books);render();await sync();}catch(e){if(e.status===401){showAuth(false);return;}if(!books.length)toast('Не удалось получить библиотеку. Проверь соединение.');}await scanDownloads();}
function updatePlaying(){const playing=!audio.paused;$('#play').innerHTML=icon(playing?'pause':'play');$('#play').ariaLabel=playing?'Пауза':'Воспроизвести';$('#mini-play').innerHTML=icon(playing?'pause':'play');$('#mini-play').ariaLabel=playing?'Пауза':'Воспроизвести';if('mediaSession'in navigator)navigator.mediaSession.playbackState=playing?'playing':'paused';}
function tick(){
 if(!current)return;
 const time=globalTime(),c=currentChapter();
 if(sleepChapter&&time>=sleepChapter){audio.pause();clearTimer();toast('Таймер: глава закончилась');}
 if(timerEnd&&Date.now()>=timerEnd){audio.pause();clearTimer();toast('Таймер сна завершён');}
 if(document.hidden)return;
 text('#chapter-label',current.chapters.length===1?'Вся книга':c.title);
 $('#seek').max=Math.max(.1,c.end-c.start);
 if(!scrubbing)$('#seek').value=Math.max(0,time-c.start);
 text('#elapsed',clock(time-c.start));text('#remaining','−'+clock(c.end-time));
 text('#total-progress',`${Math.round(time/current.duration*100)}% книги · осталось ${duration((current.duration-time)/audio.playbackRate)}`);
 html('#mini-open',`${esc(current.title)}<small>${esc(c.title)} · ${clock(time)}</small>`);
 text('#player-state',audioLoading?'Загружаю аудио…':audioFailed?'Не удалось загрузить · нажми воспроизведение':positions[current.id]?.conflict?'Позиции различаются · выбрать':downloaded.has(current.id)?'Скачано · доступно без интернета':navigator.onLine?'Воспроизведение с сервера':'Нет сети · скачай книгу для офлайн прослушивания');
 if(timerEnd)text('#sleep-label',clock((timerEnd-Date.now())/1000));
 if('mediaSession'in navigator&&navigator.mediaSession.setPositionState&&Number.isFinite(audio.duration)&&audio.duration>0){
  try{navigator.mediaSession.setPositionState({duration:audio.duration,playbackRate:audio.playbackRate,position:Math.min(audio.currentTime,audio.duration)});}catch{}
 }
}

async function seekTo(time,play=!audio.paused){
 if(!current)return;
 time=Math.max(0,Math.min(current.duration-.05,time));
 const i=Math.max(0,current.tracks.findLastIndex(t=>t.start<=time)),local=time-current.tracks[i].start;
 if(i===track&&!audioLoading&&!audioFailed&&audio.readyState>0){
  audio.currentTime=local;tick();remember();
  if(play)await audio.play().catch(playError);
  return;
 }
 const nonce=++activeLoad,rate=positions[current.id]?.speed||1;
 track=i;pendingTime=time;audioLoading=true;audioFailed=false;playbackControls();tick();
 try{await audioLoader.load({src:`/api/books/${current.id}/audio/${i}`,time:local,rate,play,onPlayError:e=>{if(nonce===activeLoad)playError(e);}});}
 catch(e){if(nonce===activeLoad&&e.name!=='AbortError'){audioFailed=audio.readyState===0;playError(e);}}
 finally{if(nonce===activeLoad){audioLoading=false;playbackControls();html('#speed',`${audio.playbackRate||rate}×<small>Скорость</small>`);tick();remember();}}
}
function playError(e){if(e.name!=='AbortError')toast(e.name==='NotAllowedError'?'Нажми воспроизведение, чтобы начать слушать.':e.message||'Проверь соединение и нажми воспроизведение.');}
async function openBook(id,play=false){
 const b=books.find(x=>x.id===id);if(!b)return;
 const changed=current?.id!==id;
 if(changed){remember();sync();audio.pause();clearTimer();current=b;track=-1;save('lastBook',id);html('#player-cover',cover(b));text('#player-title',b.title);text('#player-author',b.author);render();}
 $('#mini').hidden=false;
 if(!$('#player-dialog').open)$('#player-dialog').showModal();
 updateDownloadButton();media();
 if(changed||audioFailed)await seekTo(positions[id]?.time||0,play);
 else if(play)await audio.play().catch(playError);
 tick();
}

function media(){if(!('mediaSession'in navigator)||!current)return;navigator.mediaSession.metadata=new MediaMetadata({title:current.title,artist:current.author,album:'Полка',artwork:current.cover?[{src:new URL(current.cover,location.origin).href}]:[]});for(const [name,handler]of Object.entries({play:()=>audio.play().catch(playError),pause:()=>audio.pause(),seekbackward:d=>seekTo(globalTime()-(d.seekOffset||SKIP_SECONDS)),seekforward:d=>seekTo(globalTime()+(d.seekOffset||SKIP_SECONDS)),seekto:d=>seekTo(current.tracks[track].start+d.seekTime),nexttrack:()=>seekTo(current.chapters.find(c=>c.start>globalTime()+.1)?.start??current.duration-.05),previoustrack:()=>seekTo(current.chapters.findLast(c=>c.start<currentChapter().start-.1)?.start||0)})){try{navigator.mediaSession.setActionHandler(name,handler);}catch{}}}
function toggle(){if(!current||audioLoading)return;if(audioFailed||audio.readyState===0){seekTo(positions[current.id]?.time||0,true);return;}if(audio.paused)audio.play().catch(playError);else audio.pause();}
$('#play').onclick=toggle;$('#mini-play').onclick=toggle;$('#mini-open').onclick=()=>current&&openBook(current.id);$('#rewind').onclick=()=>seekTo(globalTime()-SKIP_SECONDS);$('#forward').onclick=()=>seekTo(globalTime()+SKIP_SECONDS);$('#seek').oninput=()=>{scrubbing=true;};$('#seek').onchange=e=>{scrubbing=false;seekTo(currentChapter().start+Number(e.target.value));};$('#seek').onblur=()=>{scrubbing=false;};
audio.addEventListener('timeupdate',tick);audio.addEventListener('play',updatePlaying);audio.addEventListener('pause',()=>{updatePlaying();remember();sync();});audio.addEventListener('ended',async()=>{remember();if(sleepChapter){clearTimer();return;}if(current&&track<current.tracks.length-1){try{await seekTo(current.tracks[track+1].start,true);}catch(e){if(e.name!=='AbortError')toast('Не удалось открыть следующую главу. Нажми воспроизведение.');}}else{sync();render();}});audio.addEventListener('error',()=>{if(current)toast('Аудио недоступно. Проверь сеть или скачивание книги.');});
setInterval(()=>{if(!audio.paused)remember();},5000);
setInterval(()=>{if(!audio.paused)sync();},15000);
document.addEventListener('visibilitychange',()=>{if(document.hidden){remember();sync(true);}else{tick();updateDownloadButton();}});
window.addEventListener('pagehide',()=>{remember();sync(true);});
function sheet(title,html){$('#sheet-title').textContent=title;$('#sheet-content').innerHTML=html;$('#sheet').showModal();}
$('#speed').onclick=()=>{sheet('Скорость',[.75,1,1.1,1.25,1.5,1.75,2,2.5].map(s=>`<button class="sheet-row ${audio.playbackRate===s?'active':''}" data-speed="${s}">${s}× ${audio.playbackRate===s?icon('check'):''}</button>`).join(''));};
function clearTimer(){clearInterval(timer);timer=null;timerEnd=0;sleepChapter=false;$('#sleep-label').textContent='Таймер сна';}
$('#sleep').onclick=()=>sheet('Таймер сна',[15,30,45,60].map(n=>`<button class="sheet-row" data-timer="${n}">${n} минут</button>`).join('')+'<button class="sheet-row" data-timer="chapter">До конца главы</button><button class="sheet-row" data-timer="off">Выключить таймер</button><p class="small muted">Веб-таймер может задержаться, если iOS приостановит приложение.</p>');
function showChapters(){if(!current)return;const marks=read('marks:'+current.id,[]);sheet('Главы и закладки',`<p class="sheet-group">ОГЛАВЛЕНИЕ · ${current.chapters.length}</p>`+current.chapters.map((c,i)=>`<button class="sheet-row ${currentChapter().start===c.start?'active':''}" data-seek="${c.start}"><span>${esc(c.title)}</span><small>${clock(c.start)}</small></button>`).join('')+'<p class="sheet-group">ЗАКЛАДКИ</p>'+ (marks.length?marks.map(m=>`<button class="sheet-row" data-seek="${m.time}"><span>${esc(m.title)}</span><small>${clock(m.time)}</small></button>`).join(''):'<p class="small muted">Нажми «Закладка» в плеере, чтобы сохранить момент.</p>'));}
$('#chapters').onclick=showChapters;$('#chapter-label').onclick=showChapters;
$('#bookmark').onclick=async()=>{if(!current)return;const id=current.id,key='marks:'+id,marks=read(key,[]),time=globalTime(),chapter=currentChapter().title;if(audioLoading)return;if(marks.length>=500){toast('Достигнут лимит: 500 закладок на книгу');return;}marks.push({time,title:chapter});save(key,marks);save(key+':dirty',true);toast(`Закладка: ${chapter} · ${clock(time)}`);try{await syncBookMarks(id);}catch{toast(`Закладка ${clock(time)} сохранена на устройстве; синхронизация позже`);}};
$('#player-state').onclick=async()=>{if(!current||!positions[current.id]?.conflict)return;try{const d=await api('/api/books'),p=d.progress.find(p=>p.bookId===current.id)||{revision:0,time:0};sheet('Где продолжить?',`<button class="sheet-row" data-resolve="local" data-revision="${p.revision}">На этом устройстве <small>${clock(positions[current.id].time)}</small></button><button class="sheet-row" data-resolve="server" data-revision="${p.revision}" data-time="${p.time}">Позиция с сервера <small>${clock(p.time)}</small></button>`);}catch{toast('Для сравнения позиций нужен интернет');}};
function downloadProgress(){
 updateDownloadButton();
 const row=$('#download-list').querySelector('[data-active-download]');
 if(row&&downloading){row.querySelector('p').textContent='Скачивание · '+Math.floor(downloading.progress*100)+'%';row.querySelector('progress').value=downloading.progress;}
}
async function startDownload(id){
 if(loggingOut||localStateCleared)return;
 const b=books.find(b=>b.id===id);if(!b)return;
 if(downloaded.has(id)){toast('Книга уже доступна без интернета');return;}
 if(downloading){if(downloading.id===id){downloading.controller.abort();toast('Приостанавливаю скачивание…');}else toast('Уже скачивается другая книга. Можно приостановить её в «Загрузках».');return;}
 if(!('serviceWorker'in navigator)||!('caches'in window)){toast('Для скачивания нужен HTTPS и поддержка офлайн-хранилища');return;}
 const controller=new AbortController();
 let resolveDone;const done=new Promise(r=>resolveDone=r);
 downloading={id,progress:0,controller,preparing:true,done};updateDownloadButton();renderDownloads();
 try{
  const [estimate,received]=await Promise.all([navigator.storage?.estimate().catch(()=>null),downloadedBytes(b)]);
  if(controller.signal.aborted)throw new DOMException('Пауза','AbortError');
  if(estimate&&estimate.quota-estimate.usage<(b.size-received)*1.05)throw Error('Недостаточно места в хранилище браузера');
  downloading.preparing=false;toast('Скачивание началось. Кнопка с процентами ставит его на паузу.');
  await download(b,controller.signal,p=>{downloading.progress=p;downloadProgress();});
  downloaded.add(id);++scanVersion;toast('Книга скачана и доступна без интернета');
 }catch(e){toast(e.name==='AbortError'?'Скачивание приостановлено. Нажми «Скачать», чтобы продолжить.':e.name==='QuotaExceededError'?'В хранилище браузера закончилось место':e.message);}
 finally{downloading=null;resolveDone();render();tick();}
}
$('#player-download').onclick=()=>current&&startDownload(current.id);

function showUpload(){if(!$('#upload-dialog').open)$('#upload-dialog').showModal();}
$('#add-top').onclick=showUpload;
$('#upload-files').onchange=e=>{files=[...e.target.files].sort((a,b)=>a.name.localeCompare(b.name,'ru',{numeric:true}));if(!$('#upload-title').value&&files.length)$('#upload-title').value=files.length===1?files[0].name.replace(/\.[^.]+$/,''):'';renderFileOrder();};
function renderFileOrder(){$('#file-summary').textContent=`${files.length} файлов · ${bytes(files.reduce((n,f)=>n+f.size,0))}. Проверь порядок глав.`;$('#file-order').innerHTML=files.map((f,i)=>`<div class="file-row"><span>${i+1}. ${esc(f.name)}</span><button type="button" data-move="${i}" data-direction="-1" aria-label="Переместить выше" ${i===0?'disabled':''}>↑</button><button type="button" data-move="${i}" data-direction="1" aria-label="Переместить ниже" ${i===files.length-1?'disabled':''}>↓</button></div>`).join('');}
$('#upload-pause').onclick=()=>uploadController?.abort();
$('#upload-form').onsubmit=async e=>{
 e.preventDefault();if(loggingOut||localStateCleared||!files.length)return;const title=$('#upload-title').value.trim(),author=$('#upload-author').value.trim();const fingerprint=JSON.stringify({title,author,files:files.map(f=>[f.name,f.size,f.lastModified])});uploadController=new AbortController();let resolveUpload;uploadController.done=new Promise(r=>resolveUpload=r);const signal=uploadController.signal;$('#upload-submit').disabled=true;$('#upload-pause').hidden=false;$('#upload-progress').hidden=false;$('#upload-files').disabled=true;$$('#file-order button').forEach(b=>b.disabled=true);
 try{let pending=read('pendingUpload',null),job;if(pending?.fingerprint===fingerprint){job=await api('/api/imports/'+pending.id);}else{job=await post('/api/imports',{title,author,files:files.map(f=>({name:f.name,size:f.size}))});save('pendingUpload',{id:job.id,fingerprint});}if(job.status==='complete'){toast('Книга уже добавлена');$('#upload-dialog').close();await loadLibrary();return;}
 let uploaded=(job.offsets||[]).reduce((a,b)=>a+b,0),total=files.reduce((n,f)=>n+f.size,0);
 for(let i=0;i<files.length;i++){let offset=job.offsets?.[i]||0;while(offset<files[i].size){if(signal.aborted)throw new DOMException('Пауза','AbortError');const chunk=files[i].slice(offset,offset+4*1024**2);await api(`/api/imports/${job.id}/${i}`,{method:'PUT',headers:{'Content-Type':'application/octet-stream','X-Upload-Offset':String(offset)},body:chunk,signal});offset+=chunk.size;uploaded+=chunk.size;$('#upload-progress').value=uploaded/total*100;$('#upload-status').textContent=`${Math.round(uploaded/total*100)}% · файл ${i+1} из ${files.length}`;}}
 $('#upload-status').textContent='Проверяем аудио и собираем оглавление…';$('#upload-pause').hidden=true;await post(`/api/imports/${job.id}/finish`,{});localStorage.removeItem('pendingUpload');$('#upload-dialog').close();$('#upload-form').reset();files=[];renderFileOrder();toast('Книга добавлена на полку');await loadLibrary();
 }catch(e){$('#upload-status').textContent=e.name==='AbortError'?'Пауза. Нажми «Добавить», чтобы продолжить.':e.message+' Можно повторить с теми же файлами.';}finally{$('#upload-submit').disabled=false;$('#upload-files').disabled=false;$('#upload-pause').hidden=true;renderFileOrder();uploadController=null;resolveUpload();}
};
document.addEventListener('click',async e=>{const b=e.target.closest('button');if(!b||(localStateCleared&&b.id!=='logout'))return;try{
 if(b.dataset.view)showView(b.dataset.view);if(b.dataset.close)$('#'+b.dataset.close).close();if(b.dataset.open)await openBook(b.dataset.open,!!b.dataset.autoplay);if(b.dataset.download)await startDownload(b.dataset.download);if(b.hasAttribute('data-stop-download'))downloading?.controller.abort();if(b.hasAttribute('data-add'))showUpload();
 if(b.dataset.remove){const book=books.find(x=>x.id===b.dataset.remove);if(confirm(`Удалить скачанную копию «${book.title}» с этого устройства? Книга останется на сервере.`)){await removeDownload(book);downloaded.delete(book.id);render();tick();}}
 if(b.dataset.filter){filter=b.dataset.filter;$$('[data-filter]').forEach(x=>x.classList.toggle('selected',x===b));render();}
 if(b.dataset.speed){audio.playbackRate=Number(b.dataset.speed);html('#speed',`${b.dataset.speed}×<small>Скорость</small>`);remember();sync();$('#sheet').close();}
 if(b.dataset.timer){clearTimer();if(b.dataset.timer==='chapter'){sleepChapter=currentChapter().end;$('#sleep-label').textContent='До конца главы';}else if(b.dataset.timer!=='off'){timerEnd=Date.now()+Number(b.dataset.timer)*60000;timer=setInterval(tick,500);}$('#sheet').close();tick();}
 if(b.dataset.seek!==undefined){await seekTo(Number(b.dataset.seek));$('#sheet').close();}
 if(b.dataset.move!==undefined){const i=Number(b.dataset.move),j=i+Number(b.dataset.direction);[files[i],files[j]]=[files[j],files[i]];renderFileOrder();}
 if(b.dataset.resolve){positions[current.id].revision=Number(b.dataset.revision);positions[current.id].conflict=false;if(b.dataset.resolve==='server')await seekTo(Number(b.dataset.time),false);remember();await sync();$('#sheet').close();tick();}
 }catch(err){toast(err.message);}});
$('#search').oninput=render;
function showAuth(isSetup){setup=isSetup;$('#auth').hidden=false;$('#app').hidden=true;$('#setup-label').hidden=!setup;$('#setup-key').required=setup;$('#password').minLength=setup?12:1;$('#auth-title').textContent=setup?'Твоя личная полка.':'С возвращением.';$('#auth-description').textContent=setup?'Введи ключ настройки и придумай пароль от 12 символов.':'Войди, чтобы продолжить свою историю.';}
$('#auth-form').onsubmit=async e=>{e.preventDefault();const button=e.submitter;button.disabled=true;$('#auth-error').textContent='';try{await post(setup?'/api/setup':'/api/login',{key:$('#setup-key').value,password:$('#password').value});$('#password').value='';save('unlocked',true);await start();}catch(e){$('#auth-error').textContent=e.message;}finally{button.disabled=false;}};
$('#logout').onclick=async()=>{
 if(loggingOut||!confirm('Выйти и удалить скачанные книги и сохранённый прогресс с этого устройства? Серверная библиотека останется.'))return;
 loggingOut=true;$('#logout').disabled=true;audio.pause();remember();
 try{
  const pendingDownload=downloading,pendingUpload=uploadController;
  pendingDownload?.controller.abort();pendingUpload?.abort();
  await Promise.all([pendingDownload?.done,pendingUpload?.done]);
  // A running progress sync must settle before deciding whether logout is safe.
  while(syncing)await new Promise(r=>setTimeout(r,50));
  await sync();await syncMarks();
  const dirtyMarks=Object.keys(localStorage).some(k=>k.startsWith('marks:')&&k.endsWith(':dirty')&&read(k,false));
  if(Object.values(positions).some(p=>p.dirty)||dirtyMarks)throw Error('Есть несинхронизированные позиции или закладки. Подключись к серверу и разреши конфликты перед выходом.');
  localStateCleared=true;audioLoader.cancel?.();audio.removeAttribute('src');audio.load();clearTimer();
  if('mediaSession'in navigator)navigator.mediaSession.metadata=null;
  await clearOffline();localStorage.clear();
  if(localStorage.length)throw Error('Не удалось очистить данные устройства');
  await post('/api/logout',{});location.reload();
 }catch(e){toast('Выход не завершён: '+e.message+' Повтори выход.');}
 finally{loggingOut=false;$('#logout').disabled=false;}
};
function connection(){$('#connection').textContent=navigator.onLine?'На своём сервере':'Без интернета';}
window.addEventListener('online',()=>{if(loggingOut||localStateCleared)return;connection();loadLibrary();syncMarks();});window.addEventListener('offline',()=>{connection();tick();});
function syncBookMarks(id){
 if(markSyncs.has(id))return markSyncs.get(id);
 const key='marks:'+id;
 const work=(async()=>{
  while(read(key+':dirty',false)){
   const sent=JSON.stringify(read(key,[]));
   await api(`/api/books/${id}/bookmarks`,{method:'PUT',body:sent});
   if(JSON.stringify(read(key,[]))===sent){save(key+':dirty',false);break;}
  }
 })().finally(()=>markSyncs.delete(id));
 markSyncs.set(id,work);return work;
}
async function syncMarks(){
 if(localStateCleared)return;
 for(const b of books){
  const key='marks:'+b.id;
  try{if(read(key+':dirty',false))await syncBookMarks(b.id);
  else{const before=JSON.stringify(read(key,[])),marks=await api(`/api/books/${b.id}/bookmarks`);if(!read(key+':dirty',false)&&!markSyncs.has(b.id)&&JSON.stringify(read(key,[]))===before)save(key,marks);}}catch{}
 }
}

async function start(){
 $('#auth').hidden=true;$('#app').hidden=false;connection();render();await loadLibrary();syncMarks();
}
if('serviceWorker'in navigator)navigator.serviceWorker.register('/sw.js',{type:'module'}).catch(()=>toast('Офлайн-режим пока недоступен. Онлайн-плеер продолжит работать.'));
try{const status=await api('/api/auth');if(status.authenticated){save('unlocked',true);await start();}else showAuth(status.setup);}catch{if(read('unlocked',false)&&books.length)await start();else showAuth(false);}
