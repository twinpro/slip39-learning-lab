export const TIME_ZONE='America/New_York';
export const MONTH_DAY_RE=/^(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;
const FRAME_ID='time-machine';
const frameHeightCleanup=[];

export const datePart=time=>String(time||'').slice(0,10);

export function newYorkCalendarDate(now=new Date()){
  const parts=Object.fromEntries(new Intl.DateTimeFormat('en-US',{timeZone:TIME_ZONE,year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(now).filter(p=>p.type!=='literal').map(p=>[p.type,p.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}

export function isValidMonthDay(monthDay){
  if(!MONTH_DAY_RE.test(monthDay)) return false;
  const [month,day]=monthDay.split('-').map(Number);
  const probe=new Date(Date.UTC(2000,month-1,day));
  return probe.getUTCMonth()===month-1&&probe.getUTCDate()===day;
}

export function validateClientDataset(dataset){
  if(dataset?.schemaVersion!==1||dataset.asset!=='btc'||dataset.metric!=='PriceUSD'||!Array.isArray(dataset.observations)) throw new Error('Unsupported daily-history dataset');
  let previous='';const seen=new Set();
  for(const row of dataset.observations){
    const date=datePart(row?.time),price=Number(row?.PriceUSD);
    if(!/^\d{4}-\d{2}-\d{2}$/.test(date)||!Number.isFinite(price)||price<=0) throw new Error(`Invalid daily observation: ${date||'unknown'}`);
    if(seen.has(date)) throw new Error(`Duplicate daily observation: ${date}`);
    if(date<previous) throw new Error('Daily observations are not ordered');
    seen.add(date);previous=date;
  }
  if(!dataset.observations.length||datePart(dataset.observations[0].time)!==dataset.earliestObservationDate||datePart(dataset.observations.at(-1).time)!==dataset.latestObservationDate) throw new Error('Daily-history coverage metadata mismatch');
  return true;
}

export function buildDateRows(dataset,monthDay,todayDate,selectedYear=Number(todayDate.slice(0,4))){
  if(!isValidMonthDay(monthDay)||!/\d{4}-\d{2}-\d{2}/.test(todayDate)) throw new Error('Invalid selected or current date');
  validateClientDataset(dataset);
  const byDate=new Map(dataset.observations.map(row=>[datePart(row.time),row]));
  const earliestYear=Number(dataset.earliestObservationDate.slice(0,4));
  const newestYear=Math.min(Number(selectedYear)-1,Number(todayDate.slice(0,4)));
  const rows=[];
  for(let year=newestYear;year>=earliestYear;year--){
    const date=`${year}-${monthDay}`;
    const calendarProbe=new Date(`${date}T00:00:00Z`);
    const realDate=!Number.isNaN(calendarProbe.valueOf())&&calendarProbe.toISOString().slice(0,10)===date;
    const future=date>todayDate;
    const observation=!future&&realDate?byDate.get(date):null;
    rows.push({year,date,status:future?'future':observation?'available':'missing',priceUSD:observation?Number(observation.PriceUSD):null,exactPriceUSD:observation?.PriceUSD??null,time:observation?.time??null});
  }
  return rows;
}

export function calculateComparison(currentPrice,historicalPrice){
  if(!Number.isFinite(currentPrice)||currentPrice<=0||!Number.isFinite(historicalPrice)||historicalPrice<=0) return {percentageChange:null,growthMultiple:null};
  return {percentageChange:((currentPrice/historicalPrice)-1)*100,growthMultiple:currentPrice/historicalPrice};
}

export function liveDisplayState({status='connecting',price=null,lastMessageAt=null},now=Date.now()){
  const validPrice=Number.isFinite(price)&&price>0;
  const age=lastMessageAt==null?Infinity:now-lastMessageAt;
  if(status==='live'&&validPrice&&age<=20000) return {label:'LIVE',className:'live',price,usable:true};
  if(validPrice&&age<=120000) return {label:'DELAYED',className:'delayed',price,usable:false};
  if(status==='connecting') return {label:'CONNECTING',className:'delayed',price:null,usable:false};
  return {label:'DELAYED',className:'delayed',price:null,usable:false};
}

const usd=value=>value==null?'N/A':`$${value.toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2})}`;
export const formatHistoricalPrice=value=>value==null?'N/A':`$${value.toLocaleString('en-US',value>=1?{minimumFractionDigits:2,maximumFractionDigits:2}:{minimumFractionDigits:4,maximumFractionDigits:8})}`;
export const formatPercent=value=>value==null?'N/A':`${value>=0?'+':''}${value.toLocaleString('en-US',{minimumFractionDigits:1,maximumFractionDigits:1})}%`;
export const formatMultiple=value=>value==null?'N/A':`${value.toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2})}x`;
const monthDayLabel=monthDay=>new Intl.DateTimeFormat('en-US',{timeZone:'UTC',month:'long',day:'numeric'}).format(new Date(`2000-${monthDay}T00:00:00Z`));
const compactUsd=value=>value==null?'—':value>=100000?`$${Math.round(value/1000)}K`:value>=1000?`$${Math.round(value).toLocaleString('en-US')}`:value>=1?`$${Math.round(value).toLocaleString('en-US')}`:`$${value.toFixed(4)}`;

function documentHeight(){
  const root=document.documentElement,body=document.body;
  return Math.ceil(Math.max(root.scrollHeight,body.scrollHeight,root.offsetHeight,body.offsetHeight));
}
function frameMessagingTarget(){
  if(typeof window==='undefined'||typeof document==='undefined'||typeof location==='undefined') return null;
  if(!window.parent||window.parent===window||typeof window.parent.postMessage!=='function') return null;
  return window.parent;
}
function postFrameHeight(){
  const target=frameMessagingTarget();
  if(!target) return;
  target.postMessage({type:'btc-preview-frame-height',frameId:FRAME_ID,height:documentHeight()},location.origin);
}
function setupFrameHeightPosting(){
  if(typeof window==='undefined'||typeof document==='undefined'||!document.body) return;
  if(!frameMessagingTarget()) return;
  const onMessage=event=>{
    if(event.origin===location.origin&&event.data?.type==='btc-preview-request-height'&&event.data.frameId===FRAME_ID)postFrameHeight();
  };
  const onResize=()=>{
    const timerId=setTimeout(postFrameHeight,80);
    frameHeightCleanup.push(()=>clearTimeout(timerId));
  };
  const onToggle=()=>{
    const timerId=setTimeout(postFrameHeight,80);
    frameHeightCleanup.push(()=>clearTimeout(timerId));
  };
  window.addEventListener('message',onMessage);
  frameHeightCleanup.push(()=>window.removeEventListener('message',onMessage));
  if('ResizeObserver' in window&&typeof window.ResizeObserver==='function'){
    const observer=new window.ResizeObserver(()=>postFrameHeight());
    observer.observe(document.body);
    frameHeightCleanup.push(()=>observer.disconnect());
  }else{
    const intervalId=setInterval(postFrameHeight,700);
    frameHeightCleanup.push(()=>clearInterval(intervalId));
  }
  window.addEventListener('load',postFrameHeight);
  window.addEventListener('resize',onResize);
  document.addEventListener('toggle',onToggle,true);
  frameHeightCleanup.push(()=>window.removeEventListener('load',postFrameHeight));
  frameHeightCleanup.push(()=>window.removeEventListener('resize',onResize));
  frameHeightCleanup.push(()=>document.removeEventListener('toggle',onToggle,true));
}

export function teardownFrameHeightPosting(){
  while(frameHeightCleanup.length) frameHeightCleanup.pop()();
}

export function renderRows(rows,currentPrice){
  return rows.map(row=>{
    const comparison=calculateComparison(currentPrice,row.priceUSD);
    const unavailable=row.status!=='available';
    return `<tr class="${unavailable?'unavailable-row':''}"><th scope="row">${row.year}</th><td>${row.date}</td><td>${unavailable?'N/A':formatHistoricalPrice(row.priceUSD)}</td><td>${unavailable?'N/A':formatPercent(comparison.percentageChange)}</td><td>${unavailable?'N/A':formatMultiple(comparison.growthMultiple)}</td></tr>`;
  }).join('');
}

function renderMobileList(rows){
  const valid=rows.filter(row=>row.status==='available'&&Number.isFinite(row.priceUSD));
  if(!valid.length)return '<div class="mobile-year-row"><span class="year">No data</span><span class="price">—</span></div>';
  const high=valid.reduce((best,row)=>row.priceUSD>best.priceUSD?row:best,valid[0]);
  const low=valid.reduce((best,row)=>row.priceUSD<best.priceUSD?row:best,valid[0]);
  return valid.map(row=>{
    const tag=row===high?'<span class="tag">HIGHEST</span>':row===low?'<span class="tag">LOWEST</span>':'';
    return `<div class="mobile-year-row"><span class="year">${row.year}${tag}</span><span class="price">${formatHistoricalPrice(row.priceUSD)}</span></div>`;
  }).join('');
}

function renderMobileCurrent({dataset,inputValue,today,live}){
  const byDate=new Map(dataset.observations.map(row=>[datePart(row.time),row]));
  const selectedYear=Number(inputValue.slice(0,4));
  const monthDay=inputValue.slice(5);
  const selectedDate=`${selectedYear}-${monthDay}`;
  const observation=selectedDate<=today?byDate.get(selectedDate):null;
  const isToday=selectedDate===today;
  const title=document.getElementById('mobile-current-title'),price=document.getElementById('mobile-current-price'),note=document.getElementById('mobile-current-note'),liveBox=document.getElementById('mobile-live-box'),livePrice=document.getElementById('mobile-live-price');
  title.textContent=`${selectedYear} daily close`;
  if(observation){
    price.textContent=formatHistoricalPrice(Number(observation.PriceUSD));
    note.textContent='Daily close';
  }else if(isToday){
    price.textContent='Pending';
    note.textContent='Today’s daily candle has not closed yet.';
  }else{
    price.textContent='Price unavailable';
    note.textContent='No Coin Metrics daily close was returned for this date.';
  }
  const liveState=liveDisplayState(live);
  if(liveState.label==='LIVE'&&Number.isFinite(liveState.price)){
    liveBox.hidden=false;
    livePrice.textContent=usd(liveState.price);
  }else{
    liveBox.hidden=true;
  }
  return observation?Number(observation.PriceUSD):null;
}

function drawChart(canvas,rows){
  const points=rows.filter(row=>row.status==='available'&&Number.isFinite(row.priceUSD)).reverse();
  const ctx=canvas.getContext('2d'),dpr=devicePixelRatio||1,w=canvas.clientWidth||800,h=canvas.clientHeight||180;
  canvas.width=Math.round(w*dpr);canvas.height=Math.round(h*dpr);ctx.setTransform(dpr,0,0,dpr,0,0);ctx.clearRect(0,0,w,h);
  ctx.strokeStyle='#1e2c30';ctx.strokeRect(.5,.5,w-1,h-1);
  if(points.length<2){canvas._points=[];return;}
  const values=points.map(p=>p.priceUSD),min=Math.max(.01,Math.min(...values)),max=Math.max(...values);
  const logMin=Math.floor(Math.log10(min)),logMax=Math.ceil(Math.log10(max)),span=logMax-logMin||1;
  const m={l:w<520?48:58,r:12,t:12,b:30},pw=w-m.l-m.r,ph=h-m.t-m.b;
  const xFor=(index)=>m.l+(index/(points.length-1))*pw;
  const yFor=(value)=>m.t+(1-(Math.log10(value)-logMin)/span)*ph;
  ctx.font='10px "IBM Plex Mono",monospace';ctx.lineWidth=1;
  for(let p=logMin;p<=logMax;p++){
    const value=10**p,y=yFor(value);
    ctx.strokeStyle='#1e2c30';ctx.beginPath();ctx.moveTo(m.l,y+.5);ctx.lineTo(w-m.r,y+.5);ctx.stroke();
    ctx.fillStyle='#9aa9ab';const label=value>=1000?'$'+(value/1000)+'K':'$'+value;ctx.fillText(label,4,y+3);
  }
  const tickIndexes=[0,Math.floor((points.length-1)/2),points.length-1];
  tickIndexes.forEach(index=>{const x=xFor(index),label=String(points[index].year),tw=ctx.measureText(label).width;ctx.fillStyle='#9aa9ab';ctx.fillText(label,Math.max(0,Math.min(w-tw,x-tw/2)),h-8);});
  ctx.strokeStyle='#3fcf6b';ctx.lineWidth=1.6;ctx.beginPath();let priorYear=null,started=false;
  points.forEach((point,index)=>{const x=xFor(index),y=yFor(point.priceUSD);if(!started||point.year!==priorYear+1){ctx.moveTo(x,y);started=true;}else ctx.lineTo(x,y);priorYear=point.year;});
  ctx.stroke();
  ctx.fillStyle='#e4e0d4';
  canvas._points=points.map((point,index)=>({x:xFor(index),y:yFor(point.priceUSD),point}));
  canvas._points.forEach(p=>{ctx.beginPath();ctx.arc(p.x,p.y,2.4,0,Math.PI*2);ctx.fill();});
}

function init(){
  const state={dataset:null,rows:[],today:newYorkCalendarDate(),live:{status:'connecting',price:null,lastMessageAt:null},socket:null,retry:0,timer:null};
  const $=id=>document.getElementById(id),input=$('selected-date');
  input.value=state.today;input.max=state.today;
  const paint=()=>{
    if(!state.dataset)return;
    const monthDay=input.value.slice(5),selectedYear=Number(input.value.slice(0,4)),live=liveDisplayState(state.live),currentPrice=live.usable?live.price:null;
    state.rows=buildDateRows(state.dataset,monthDay,state.today,selectedYear);
    const valid=state.rows.filter(row=>row.status==='available'&&Number.isFinite(row.priceUSD));
    renderMobileCurrent({dataset:state.dataset,inputValue:input.value,today:state.today,live:state.live});
    $('selected-label').textContent=monthDayLabel(monthDay);
    $('mobile-selected-label').textContent=monthDayLabel(monthDay);
    $('mobile-list-date').textContent=monthDayLabel(monthDay);
    $('live-status').textContent=live.label;$('live-status').className=`status ${live.className}`;$('current-price').textContent=usd(live.price);
    $('history-body').innerHTML=renderRows(state.rows,currentPrice);
    if(valid.length){
      const high=valid.reduce((best,row)=>row.priceUSD>best.priceUSD?row:best,valid[0]);
      const low=valid.reduce((best,row)=>row.priceUSD<best.priceUSD?row:best,valid[0]);
      $('summary-high').innerHTML=`<b>${high.year}</b><strong>${formatHistoricalPrice(high.priceUSD)}</strong>`;
      $('summary-low').innerHTML=`<b>${low.year}</b><strong>${formatHistoricalPrice(low.priceUSD)}</strong>`;
      $('summary-count').textContent=`${valid.length} years`;
    }else{
      $('summary-high').textContent='—';$('summary-low').textContent='—';$('summary-count').textContent='0 years';
    }
    $('mobile-history-list').innerHTML=renderMobileList(state.rows);
    $('data-through').textContent=state.dataset.latestObservationDate;$('updated-at').textContent=new Intl.DateTimeFormat('en-US',{timeZone:TIME_ZONE,year:'numeric',month:'short',day:'numeric',hour:'numeric',minute:'2-digit',second:'2-digit',timeZoneName:'short'}).format(new Date(state.dataset.generatedAt));
    drawChart($('history-chart'),state.rows);
    if(frameMessagingTarget()) setTimeout(postFrameHeight,0);
  };
  input.addEventListener('change',()=>{if(input.value&&input.value<=state.today){paint();if(frameMessagingTarget())setTimeout(postFrameHeight,80);}});
  addEventListener('resize',()=>paint());
  const tooltip=$('chart-tooltip'),canvas=$('history-chart');
  const showTip=event=>{
    const points=canvas._points||[];if(!points.length)return;
    const rect=canvas.getBoundingClientRect(),x=(event.touches?.[0]?.clientX??event.clientX)-rect.left,y=(event.touches?.[0]?.clientY??event.clientY)-rect.top;
    const nearest=points.reduce((best,p)=>{const d=Math.hypot(p.x-x,p.y-y);return d<best.d?{p,d}:best},{p:null,d:Infinity}).p;
    if(!nearest)return;
    tooltip.hidden=false;tooltip.style.left=Math.min(rect.width-176,Math.max(8,nearest.x+10))+'px';tooltip.style.top=Math.max(8,nearest.y-38)+'px';
    tooltip.textContent=`${nearest.point.year} · ${nearest.point.date} · ${formatHistoricalPrice(nearest.point.priceUSD)}`;
  };
  canvas.addEventListener('mousemove',showTip);canvas.addEventListener('touchstart',showTip,{passive:true});canvas.addEventListener('mouseleave',()=>{tooltip.hidden=true});
  fetch('../../data/btc-daily-history.json').then(response=>{if(!response.ok)throw new Error(`Daily history request failed (${response.status})`);return response.json();}).then(dataset=>{validateClientDataset(dataset);state.dataset=dataset;paint();}).catch(error=>{$('data-error').hidden=false;$('data-error').textContent=`HISTORICAL DATA UNAVAILABLE · ${error.message}`;});
  const connect=()=>{
    state.live.status='connecting';paint();
    if(state.timer)clearTimeout(state.timer);
    state.timer=setTimeout(()=>{if(!state.live.price){state.live.status='delayed';paint();}},20000);
    try{state.socket=new WebSocket('wss://ws-feed.exchange.coinbase.com');}catch{state.live.status='delayed';paint();return;}
    state.socket.onopen=()=>{state.retry=0;state.socket.send(JSON.stringify({type:'subscribe',product_ids:['BTC-USD'],channels:['ticker']}));};
    state.socket.onmessage=event=>{let message;try{message=JSON.parse(event.data);}catch{return;}const price=Number(message.price);if(message.type==='ticker'&&Number.isFinite(price)&&price>0){if(state.timer)clearTimeout(state.timer);state.live={status:'live',price,lastMessageAt:Date.now()};paint();}};
    state.socket.onerror=()=>{state.live.status='delayed';paint();};
    state.socket.onclose=()=>{state.live.status=state.live.price?'delayed':'delayed';paint();setTimeout(connect,Math.min(30000,1000*2**state.retry++));};
  };
  connect();setInterval(()=>paint(),10000);
}

if(typeof document!=='undefined'){setupFrameHeightPosting();init();}
