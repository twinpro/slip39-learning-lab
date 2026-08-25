import {mkdir,writeFile} from 'node:fs/promises';
import {dirname,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {API_URL,buildDataset} from './btc-monthly-returns-lib.mjs';

const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const output=resolve(root,'data/btc-monthly-returns.json');

async function fetchAll(){
  let url=API_URL;
  const rows=[];
  while(url){
    const response=await fetch(url,{headers:{accept:'application/json','user-agent':'slip39-learning-lab-monthly-returns/1.0'}});
    if(!response.ok) throw new Error(`Coin Metrics request failed: ${response.status} ${response.statusText}`);
    const payload=await response.json();
    if(!Array.isArray(payload.data)) throw new Error('Coin Metrics response is missing its data array');
    rows.push(...payload.data);
    url=payload.next_page_url||null;
  }
  return rows;
}

const dataset=buildDataset(await fetchAll());
await mkdir(dirname(output),{recursive:true});
await writeFile(output,`${JSON.stringify(dataset,null,2)}\n`,'utf8');
const current=dataset.returns.find(item=>item.isCurrent);
console.log(`Wrote ${output}`);
console.log(`Latest observation: ${dataset.latestObservationDate}`);
console.log(`Current MTD: ${current.month} ${current.value.toFixed(4)}%`);
