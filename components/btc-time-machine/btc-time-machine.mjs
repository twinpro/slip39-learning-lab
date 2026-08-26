export const TIME_ZONE='America/New_York';
export const MONTH_DAY_RE=/^(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;

const pad=value=>String(value).padStart(2,'0');
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

export function buildDateRows(dataset,monthDay,todayDate){
  if(!isValidMonthDay(monthDay)||!/\d{4}-\d{2}-\d{2}/.test(todayDate)) throw new Error('Invalid selected or current date');
  validateClientDataset(dataset);
  const byDate=new Map(dataset.observations.map(row=>[datePart(row.time),row]));
  const earliestYear=Number(dataset.earliestObservationDate.slice(0,4));
  const currentYear=Number(todayDate.slice(0,4));
  const todayMonthDay=todayDate.slice(5);
  const newestYear=monthDay===todayMonthDay?currentYear-1:currentYear;
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
  return {label:'UNAVAILABLE',className:'unavailable',price:null,usable:false};
}

const usd=value=>value==null?'N/A':`$${value.toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2})}`;
const percent=value=>value==null?'N/A':`${value>=0?'+':''}${value.toFixed(1)}%`;
const multiple=value=>value==null?'N/A':`${value.toFixed(2)}×`;

export function renderRows(rows,currentPrice){
  return rows.map(row=>{
    const comparison=calculateComparison(currentPrice,row.priceUSD);
    const unavailable=row.status!=='available';
    return `<tr class="${unavailable?'unavailable-row':''}"><th scope="row">${row.year}</th><td>${row.date}</td><td>${unavailable?'N/A':usd(row.priceUSD)}</td><td>${unavailable?'N/A':percent(comparison.percentageChange)}</td><td>${unavailable?'N/A':multiple(comparison.growthMultiple)}</td></tr>`;
  }).join('');
}

function drawChart(canvas,rows){
  const points=rows.filter(row=>row.status==='available'&&Number.isFinite(row.priceUSD)).reverse();
  const ctx=canvas.getContext('2d'),dpr=devicePixelRatio||1,w=canvas.clientWidth||800,h=canvas.clientHeight||180;
  canvas.width=Math.round(w*dpr);canvas.height=Math.round(h*dpr);ctx.setTransform(dpr,0,0,dpr,0,0);ctx.clearRect(0,0,w,h);
  ctx.strokeStyle='#1e2c30';ctx.strokeRect(.5,.5,w-1,h-1);
  if(points.length<2) return;
  const values=points.map(p=>p.priceUSD),min=Math.min(...values),max=Math.max(...values),span=max-min||1,pad=18;
  ctx.strokeStyle='#3fcf6b';ctx.lineWidth=1.5;let drawing=false,priorYear=null;
  ctx.beginPath();points.forEach((point,index)=>{const x=pad+(index/(points.length-1))*(w-pad*2),y=h-pad-((point.priceUSD-min)/span)*(h-pad*2);if(!drawing||point.year!==priorYear+1){ctx.moveTo(x,y);drawing=true;}else ctx.lineTo(x,y);priorYear=point.year;});ctx.stroke();
}

function init(){
  const state={dataset:null,rows:[],today:newYorkCalendarDate(),live:{status:'connecting',price:null,lastMessageAt:null},socket:null,retry:0};
  const $=id=>document.getElementById(id),input=$('selected-date');
  input.value=state.today;input.max=state.today;
  const paint=()=>{
    if(!state.dataset)return;
    const monthDay=input.value.slice(5),live=liveDisplayState(state.live),currentPrice=live.usable?live.price:null;
    state.rows=buildDateRows(state.dataset,monthDay,state.today);
    $('selected-label').textContent=new Intl.DateTimeFormat('en-US',{timeZone:'UTC',month:'long',day:'numeric'}).format(new Date(`2000-${monthDay}T00:00:00Z`));
    $('live-status').textContent=live.label;$('live-status').className=`status ${live.className}`;$('current-price').textContent=usd(live.price);
    $('history-body').innerHTML=renderRows(state.rows,currentPrice);
    $('data-through').textContent=state.dataset.latestObservationDate;$('updated-at').textContent=new Intl.DateTimeFormat('en-US',{timeZone:TIME_ZONE,year:'numeric',month:'short',day:'numeric',hour:'numeric',minute:'2-digit',second:'2-digit',timeZoneName:'short'}).format(new Date(state.dataset.generatedAt));
    drawChart($('history-chart'),state.rows);
  };
  input.addEventListener('change',()=>{if(input.value&&input.value<=state.today)paint();});
  addEventListener('resize',()=>paint());
  fetch('../../data/btc-daily-history.json').then(response=>{if(!response.ok)throw new Error(`Daily history request failed (${response.status})`);return response.json();}).then(dataset=>{validateClientDataset(dataset);state.dataset=dataset;paint();}).catch(error=>{$('data-error').hidden=false;$('data-error').textContent=`HISTORICAL DATA UNAVAILABLE · ${error.message}`;});
  const connect=()=>{
    state.live.status='connecting';paint();
    try{state.socket=new WebSocket('wss://ws-feed.exchange.coinbase.com');}catch{state.live.status='unavailable';paint();return;}
    state.socket.onopen=()=>{state.retry=0;state.socket.send(JSON.stringify({type:'subscribe',product_ids:['BTC-USD'],channels:['ticker']}));};
    state.socket.onmessage=event=>{let message;try{message=JSON.parse(event.data);}catch{return;}const price=Number(message.price);if(message.type==='ticker'&&Number.isFinite(price)&&price>0){state.live={status:'live',price,lastMessageAt:Date.now()};paint();}};
    state.socket.onerror=()=>{state.live.status='unavailable';paint();};
    state.socket.onclose=()=>{state.live.status=state.live.price?'delayed':'unavailable';paint();setTimeout(connect,Math.min(30000,1000*2**state.retry++));};
  };
  connect();setInterval(()=>paint(),10000);
}

if(typeof document!=='undefined')init();
