export const API_URL='https://community-api.coinmetrics.io/v4/timeseries/asset-metrics?assets=btc&metrics=PriceUSD&frequency=1d&start_time=2012-12-01&page_size=10000';
export const START_YEAR=2013;

export const monthKey=date=>date.slice(0,7);

export function parseObservation(row){
  const date=typeof row?.time==='string'?row.time.slice(0,10):'';
  const priceUSD=typeof row?.PriceUSD==='number'?row.PriceUSD:Number(row?.PriceUSD);
  if(!/^\d{4}-\d{2}-\d{2}$/.test(date)||!Number.isFinite(priceUSD)||priceUSD<=0) return null;
  return {date,priceUSD};
}

export function lastDailyPrices(rows){
  const prices=new Map();
  for(const row of rows){
    const point='priceUSD' in (row||{})?parseObservation({time:row.date,PriceUSD:row.priceUSD}):parseObservation(row);
    if(!point) continue;
    const key=monthKey(point.date),prior=prices.get(key);
    if(!prior||point.date>prior.date) prices.set(key,point);
  }
  return prices;
}

export function previousMonthKey(key){
  const [year,month]=key.split('-').map(Number);
  const date=new Date(Date.UTC(year,month-2,1));
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth()+1).padStart(2,'0')}`;
}

export function calculateReturns(rows,latestObservationDate){
  const prices=lastDailyPrices(rows),latestKey=monthKey(latestObservationDate),returns=[];
  const lastYear=Number(latestKey.slice(0,4));
  for(let year=START_YEAR;year<=lastYear;year++){
    for(let month=1;month<=12;month++){
      const key=`${year}-${String(month).padStart(2,'0')}`;
      if(key>latestKey) continue;
      const current=prices.get(key),previous=prices.get(previousMonthKey(key));
      if(!current||!previous){
        returns.push({month:key,status:'unknown',isCurrent:key===latestKey,value:null});
        continue;
      }
      const value=((current.priceUSD/previous.priceUSD)-1)*100;
      if(!Number.isFinite(value)){
        returns.push({month:key,status:'unknown',isCurrent:key===latestKey,value:null});
        continue;
      }
      returns.push({
        month:key,status:'ok',isCurrent:key===latestKey,
        value:Number(value.toFixed(8)),
        currentPriceUSD:current.priceUSD,previousPriceUSD:previous.priceUSD,
        currentPriceDate:current.date,previousPriceDate:previous.date
      });
    }
  }
  return returns;
}

export function completedAggregates(returns){
  return Array.from({length:12},(_,index)=>{
    const suffix=`-${String(index+1).padStart(2,'0')}`;
    const values=returns.filter(item=>item.month.endsWith(suffix)&&item.status==='ok'&&!item.isCurrent&&Number.isFinite(item.value)).map(item=>item.value);
    if(!values.length) return {average:null,median:null};
    const sorted=[...values].sort((a,b)=>a-b),middle=Math.floor(sorted.length/2);
    return {
      average:Number((values.reduce((sum,value)=>sum+value,0)/values.length).toFixed(8)),
      median:Number((sorted.length%2?sorted[middle]:(sorted[middle-1]+sorted[middle])/2).toFixed(8))
    };
  });
}

export function buildDataset(apiRows,generatedAt=new Date().toISOString()){
  const observations=apiRows.map(parseObservation).filter(Boolean).sort((a,b)=>a.date.localeCompare(b.date));
  if(!observations.length) throw new Error('Coin Metrics response contains no valid positive PriceUSD observations');
  const latestObservationDate=observations.at(-1).date;
  const returns=calculateReturns(observations,latestObservationDate);
  if(returns[0]?.month!=='2013-01'||returns[0]?.status!=='ok') throw new Error('January 2013 return could not be calculated from December 2012');
  return {
    schemaVersion:1,mode:'live',asset:'btc',metric:'PriceUSD',frequency:'1d',startYear:START_YEAR,
    generatedAt,latestObservationDate,sourceUrl:API_URL,returns,aggregates:completedAggregates(returns)
  };
}
