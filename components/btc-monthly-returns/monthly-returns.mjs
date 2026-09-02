export const MONTHS=['JAN','FEB','MAR','APR','MAY','JUN','JUL','AUG','SEP','OCT','NOV','DEC'];

const monthKey=date=>date.slice(0,7);

export function lastDailyPrices(observations){
  const prices=new Map();
  for(const point of observations){
    if(!point||!/^\d{4}-\d{2}-\d{2}$/.test(point.date)||!Number.isFinite(point.priceUSD)) continue;
    const key=monthKey(point.date), prior=prices.get(key);
    if(!prior||point.date>prior.date) prices.set(key,point);
  }
  return prices;
}

export function calculateMonthlyReturns(observations,asOf){
  const prices=lastDailyPrices(observations), result=new Map();
  const asOfKey=monthKey(asOf);
  for(const [key,point] of prices){
    const [year,month]=key.split('-').map(Number);
    const previous=new Date(Date.UTC(year,month-2,1));
    const previousKey=`${previous.getUTCFullYear()}-${String(previous.getUTCMonth()+1).padStart(2,'0')}`;
    const previousPoint=prices.get(previousKey);
    if(previousPoint) result.set(key,{value:((point.priceUSD/previousPoint.priceUSD)-1)*100,isCurrent:key===asOfKey});
  }
  return result;
}

export function classifyCell({value,isCurrent=false,isFuture=false}={}){
  if(isFuture) return 'future';
  if(value==null||!Number.isFinite(value)) return 'missing';
  return `${value>0?'positive':value<0?'negative':'zero'}${isCurrent?' mtd':''}`;
}

export function completedAggregates(returns,startYear,endYear){
  return MONTHS.map((_,index)=>{
    const month=String(index+1).padStart(2,'0'), values=[];
    for(let year=startYear;year<=endYear;year++){
      const item=returns.get(`${year}-${month}`);
      if(item&&!item.isCurrent&&Number.isFinite(item.value)) values.push(item.value);
    }
    if(!values.length) return {average:null,median:null};
    const sorted=[...values].sort((a,b)=>a-b), middle=Math.floor(sorted.length/2);
    return {average:values.reduce((sum,value)=>sum+value,0)/values.length,median:sorted.length%2?sorted[middle]:(sorted[middle-1]+sorted[middle])/2};
  });
}

export function annualReturn(returns,year,currentKey){
  let compound=1, hasValue=false, hasCurrent=false;
  for(let index=0;index<MONTHS.length;index++){
    const key=`${year}-${String(index+1).padStart(2,'0')}`;
    if(key>currentKey) continue;
    const item=returns.get(key);
    if(!item||item.status==='unknown'||!Number.isFinite(item.value)) continue;
    compound*=1+(item.value/100);
    hasValue=true;
    if(item.isCurrent) hasCurrent=true;
  }
  return hasValue?{value:(compound-1)*100,isCurrent:hasCurrent}:null;
}

const format=value=>`${value>=0?'+':''}${value.toFixed(1)}%`;
const FRAME_ID='monthly';
// Safari can round the iframe content box a hair short; keep this allowance tiny.
const SAFARI_HEIGHT_ALLOWANCE=2;
const frameHeightCleanup=[];
let lastPostedFrameHeight=null;
let pendingHeightPost=0;

function contentHeight(){
  const body=document.body,content=document.querySelector('.returns-panel');
  if(!body||!content) return null;
  const rect=content.getBoundingClientRect();
  const styles=getComputedStyle(body);
  const paddingBottom=parseFloat(styles.paddingBottom)||0;
  const height=Math.ceil(rect.bottom+paddingBottom+SAFARI_HEIGHT_ALLOWANCE);
  return Number.isFinite(height)&&height>0?height:null;
}
function frameMessagingTarget(){
  if(typeof window==='undefined'||typeof document==='undefined'||typeof location==='undefined') return null;
  if(!window.parent||window.parent===window||typeof window.parent.postMessage!=='function') return null;
  return window.parent;
}
function postFrameHeight(){
  const target=frameMessagingTarget();
  if(!target) return;
  const height=contentHeight();
  if(!height||height===lastPostedFrameHeight) return;
  lastPostedFrameHeight=height;
  target.postMessage({type:'btc-dashboard-frame-height',frameId:FRAME_ID,height},location.origin);
}
function scheduleFrameHeightPost(){
  if(pendingHeightPost) return;
  pendingHeightPost=setTimeout(()=>{
    pendingHeightPost=0;
    postFrameHeight();
  },80);
}
function setupFrameHeightPosting(){
  if(typeof window==='undefined'||typeof document==='undefined'||!document.body) return;
  if(!frameMessagingTarget()) return;
  const onMessage=event=>{
    if(event.origin===location.origin&&event.data?.type==='btc-dashboard-request-height'&&event.data.frameId===FRAME_ID)scheduleFrameHeightPost();
  };
  const onResize=()=>scheduleFrameHeightPost();
  window.addEventListener('message',onMessage);
  frameHeightCleanup.push(()=>window.removeEventListener('message',onMessage));
  if('ResizeObserver' in window&&typeof window.ResizeObserver==='function'){
    const target=document.querySelector('.returns-panel');
    if(target){
      const observer=new window.ResizeObserver(()=>scheduleFrameHeightPost());
      observer.observe(target);
      frameHeightCleanup.push(()=>observer.disconnect());
    }
  }else{
    const intervalId=setInterval(scheduleFrameHeightPost,700);
    frameHeightCleanup.push(()=>clearInterval(intervalId));
  }
  window.addEventListener('load',scheduleFrameHeightPost);
  window.addEventListener('resize',onResize);
  frameHeightCleanup.push(()=>window.removeEventListener('load',scheduleFrameHeightPost));
  frameHeightCleanup.push(()=>window.removeEventListener('resize',onResize));
  frameHeightCleanup.push(()=>clearTimeout(pendingHeightPost));
}

export function teardownFrameHeightPosting(){
  while(frameHeightCleanup.length) frameHeightCleanup.pop()();
}

function cellMarkup(item,isFuture=false,extraClass=''){
  const className=classifyCell({value:item?.value,isCurrent:item?.isCurrent,isFuture});
  const classes=`${className}${extraClass?` ${extraClass}`:''}`;
  if(isFuture) return `<td class="${classes}" aria-label="Future month"></td>`;
  if(!item) return `<td class="${classes}" aria-label="Unknown return">UNKNOWN</td>`;
  return `<td class="${classes}">${item.isCurrent&&extraClass?'YTD ':''}${format(item.value)}${item.isCurrent&&!extraClass?'<small>MTD</small>':''}</td>`;
}

export function renderTable(documentRef,fixture){
  const isPreview=fixture.mode!=='live';
  const asOf=fixture.latestObservationDate||fixture.asOf;
  const sourceReturns=fixture.returns
    ?new Map(fixture.returns.map(item=>[item.month,{value:item.value,isCurrent:item.isCurrent,status:item.status}]))
    :calculateMonthlyReturns(fixture.dailyPrices,asOf);
  const returns=sourceReturns;
  const startYear=fixture.startYear, endYear=Number(asOf.slice(0,4));
  const currentKey=asOf.slice(0,7);
  const header=documentRef.querySelector('thead tr');
  header.insertAdjacentHTML('beforeend',`${MONTHS.map(month=>`<th scope="col">${month}</th>`).join('')}<th class="year-return-head" scope="col">YEAR RETURN</th>`);
  const rows=[];
  for(let year=endYear;year>=startYear;year--){
    const cells=MONTHS.map((_,index)=>{
      const key=`${year}-${String(index+1).padStart(2,'0')}`;
      const item=returns.get(key);
      return cellMarkup(item?.status==='unknown'?null:item,key>currentKey);
    }).join('');
    rows.push(`<tr><td>${year}</td>${cells}${cellMarkup(annualReturn(returns,year,currentKey),false,'year-return-cell')}</tr>`);
  }
  const stats=fixture.aggregates||completedAggregates(returns,startYear,endYear);
  for(const [label,property] of [['MONTHLY AVERAGE','average'],['MONTHLY MEDIAN','median']]){
    rows.push(`<tr class="${label==='MONTHLY AVERAGE'?'summary-start':''}"><td class="summary-label">${label}</td>${stats.map(item=>cellMarkup(item[property]==null?null:{value:item[property]})).join('')}<td class="year-return-cell summary-year-return" aria-label="No yearly summary"></td></tr>`);
  }
  documentRef.querySelector('tbody').innerHTML=rows.join('');
  documentRef.querySelector('#data-mode').textContent=isPreview?'PREVIEW DATA · NOT LIVE':'LIVE DATA';
  documentRef.querySelector('#data-mode').classList.toggle('preview-warning',isPreview);
  documentRef.querySelector('#as-of').textContent=`Data through ${asOf} · Current month is provisional (MTD).`;
  if(frameMessagingTarget()) scheduleFrameHeightPost();
}

async function init(){
  try{
    const live=await fetch('../../data/btc-monthly-returns.json');
    if(!live.ok) throw new Error(`Live data request failed (${live.status})`);
    renderTable(document,await live.json());
  }catch(liveError){
    try{
      const preview=await fetch('../../data/btc-monthly-returns-preview.json');
      if(!preview.ok) throw new Error(`Preview request failed (${preview.status})`);
      renderTable(document,await preview.json());
      const node=document.querySelector('#error'); node.hidden=false;
      node.textContent=`Live data unavailable: ${liveError.message}. Showing preview data, not live values.`;
    }catch(previewError){
      const node=document.querySelector('#error'); node.hidden=false;
      node.textContent=`Unable to load monthly-return data: ${previewError.message}. Serve the repository with a local static server.`;
    }
  }
}

if(typeof document!=='undefined'){setupFrameHeightPosting();init();}
