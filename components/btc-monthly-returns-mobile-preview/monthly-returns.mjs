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

const format=value=>`${value>=0?'+':''}${value.toFixed(1)}%`;
const FRAME_ID='monthly';

function documentHeight(){
  const root=document.documentElement,body=document.body;
  return Math.ceil(Math.max(root.scrollHeight,body.scrollHeight,root.offsetHeight,body.offsetHeight));
}
function postFrameHeight(){
  if(!parent||parent===window)return;
  parent.postMessage({type:'btc-preview-frame-height',frameId:FRAME_ID,height:documentHeight()},location.origin);
}
function setupFrameHeightPosting(){
  addEventListener('message',event=>{
    if(event.origin===location.origin&&event.data?.type==='btc-preview-request-height'&&event.data.frameId===FRAME_ID)postFrameHeight();
  });
  if('ResizeObserver' in window)new ResizeObserver(()=>postFrameHeight()).observe(document.body);
  else setInterval(postFrameHeight,700);
  addEventListener('load',postFrameHeight);
  addEventListener('resize',()=>setTimeout(postFrameHeight,80));
}

function cellMarkup(item,isFuture=false){
  const className=classifyCell({value:item?.value,isCurrent:item?.isCurrent,isFuture});
  if(isFuture) return `<td class="${className}" aria-label="Future month"></td>`;
  if(!item) return `<td class="${className}" aria-label="Unknown return">UNKNOWN</td>`;
  return `<td class="${className}">${format(item.value)}${item.isCurrent?'<small>MTD</small>':''}</td>`;
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
  header.insertAdjacentHTML('beforeend',MONTHS.map(month=>`<th scope="col">${month}</th>`).join(''));
  const rows=[];
  for(let year=endYear;year>=startYear;year--){
    const cells=MONTHS.map((_,index)=>{
      const key=`${year}-${String(index+1).padStart(2,'0')}`;
      const item=returns.get(key);
      return cellMarkup(item?.status==='unknown'?null:item,key>currentKey);
    }).join('');
    rows.push(`<tr><td>${year}</td>${cells}</tr>`);
  }
  const stats=fixture.aggregates||completedAggregates(returns,startYear,endYear);
  for(const [label,property] of [['AVERAGE','average'],['MEDIAN','median']]){
    rows.push(`<tr class="${label==='AVERAGE'?'summary-start':''}"><td class="summary-label">${label}</td>${stats.map(item=>cellMarkup(item[property]==null?null:{value:item[property]})).join('')}</tr>`);
  }
  documentRef.querySelector('tbody').innerHTML=rows.join('');
  documentRef.querySelector('#data-mode').textContent=isPreview?'PREVIEW DATA · NOT LIVE':'LIVE DATA';
  documentRef.querySelector('#data-mode').classList.toggle('preview-warning',isPreview);
  documentRef.querySelector('#as-of').textContent=`Data through ${asOf} · Current month is provisional (MTD).`;
  setTimeout(postFrameHeight,0);
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
