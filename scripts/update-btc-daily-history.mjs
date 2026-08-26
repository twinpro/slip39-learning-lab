import {readFile,writeFile} from 'node:fs/promises';
import {dirname,resolve} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';

export const API_URL='https://community-api.coinmetrics.io/v4/timeseries/asset-metrics?assets=btc&metrics=PriceUSD&frequency=1d&start_time=2009-01-01&page_size=10000';

const DATE_RE=/^\d{4}-\d{2}-\d{2}$/;

export function normalizeObservations(rows){
  if(!Array.isArray(rows)) throw new Error('Coin Metrics response data must be an array');
  const seen=new Set();
  const observations=rows.map((row,index)=>{
    const time=typeof row?.time==='string'?row.time:'';
    const date=time.slice(0,10);
    const exactPrice=row?.PriceUSD;
    const numeric=typeof exactPrice==='number'?exactPrice:Number(exactPrice);
    if(!DATE_RE.test(date)||!time.includes('T')) throw new Error(`Invalid observation time at row ${index}`);
    if((typeof exactPrice!=='string'&&typeof exactPrice!=='number')||!Number.isFinite(numeric)||numeric<=0) throw new Error(`Invalid PriceUSD at ${date}`);
    if(seen.has(date)) throw new Error(`Duplicate observation date: ${date}`);
    seen.add(date);
    return {time,PriceUSD:exactPrice};
  }).sort((a,b)=>a.time.localeCompare(b.time));
  if(!observations.length) throw new Error('Coin Metrics returned no valid PriceUSD observations');
  return observations;
}

export async function fetchAllPages(fetchImpl=fetch,startUrl=API_URL){
  const rows=[];
  const visited=new Set();
  let url=startUrl;
  while(url){
    if(visited.has(url)) throw new Error('Coin Metrics pagination loop detected');
    visited.add(url);
    const response=await fetchImpl(url,{headers:{accept:'application/json','user-agent':'slip39-learning-lab-bitcoin-time-machine/1.0'}});
    if(!response?.ok) throw new Error(`Coin Metrics request failed: ${response?.status??'unknown'} ${response?.statusText??''}`.trim());
    const payload=await response.json();
    if(!payload||!Array.isArray(payload.data)) throw new Error('Coin Metrics response is missing its data array');
    rows.push(...payload.data);
    if(payload.next_page_url!=null&&typeof payload.next_page_url!=='string') throw new Error('Coin Metrics next_page_url is invalid');
    url=payload.next_page_url||null;
  }
  return rows;
}

export function validateDataset(dataset){
  if(dataset?.schemaVersion!==1||dataset.asset!=='btc'||dataset.metric!=='PriceUSD'||dataset.frequency!=='1d') throw new Error('Invalid daily-history schema metadata');
  if(typeof dataset.generatedAt!=='string'||!Number.isFinite(Date.parse(dataset.generatedAt))) throw new Error('Invalid generatedAt timestamp');
  const observations=normalizeObservations(dataset.observations);
  const earliest=observations[0].time.slice(0,10),latest=observations.at(-1).time.slice(0,10);
  if(dataset.earliestObservationDate!==earliest||dataset.latestObservationDate!==latest) throw new Error('Observation coverage metadata does not match data');
  return true;
}

export function buildDataset(rows,generatedAt=new Date().toISOString()){
  const observations=normalizeObservations(rows);
  const dataset={
    schemaVersion:1,mode:'live',asset:'btc',metric:'PriceUSD',frequency:'1d',timeBasis:'UTC',
    generatedAt,sourceUrl:API_URL,
    earliestObservationDate:observations[0].time.slice(0,10),
    latestObservationDate:observations.at(-1).time.slice(0,10),
    observations
  };
  validateDataset(dataset);
  return dataset;
}

export function stableData(dataset){
  const {generatedAt,...stable}=dataset;
  return stable;
}

export async function main(){
  const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
  const output=resolve(root,'data/btc-daily-history.json');
  const dataset=buildDataset(await fetchAllPages());
  let prior=null;
  try{prior=JSON.parse(await readFile(output,'utf8'));}catch{}
  if(prior&&JSON.stringify(stableData(prior))===JSON.stringify(stableData(dataset))){
    console.log(`No observation changes; kept ${output}`);
    console.log(`Coverage: ${prior.earliestObservationDate} through ${prior.latestObservationDate}`);
    return {changed:false,dataset:prior};
  }
  await writeFile(output,`${JSON.stringify(dataset,null,2)}\n`,'utf8');
  console.log(`Wrote ${output}`);
  console.log(`Coverage: ${dataset.earliestObservationDate} through ${dataset.latestObservationDate}`);
  console.log(`Observations: ${dataset.observations.length}`);
  return {changed:true,dataset};
}

if(process.argv[1]&&pathToFileURL(resolve(process.argv[1])).href===import.meta.url){
  main().catch(error=>{console.error(error);process.exitCode=1;});
}
