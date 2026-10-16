// Offline, diagnostic-only inspection. Never returns a production ETF series.
const FUNDS = ['IBIT','FBTC','BITB','ARKB','BTCO','EZBC','BRRR','HODL','BTCW','MSBT','GBTC','BTC'];
function cells(row) {
  return [...row.matchAll(/<t[dh]\b[^>]*>([\s\S]*?)<\/t[dh]>/gi)].map(m => m[1]
    .replace(/<[^>]+>/g,' ').replace(/&nbsp;|&#160;/g,' ').replace(/&amp;/g,'&').trim());
}
function numeric(value) {
  if (!/^(?:\(\d[\d,]*\.\d\)|-?\d[\d,]*\.\d)$/.test(value)) return null;
  return Number(value.replace(/,/g,'').replace(/^\((.*)\)$/,'-$1'));
}
export function inspectFarsideHtml(html) {
  const tables = [...html.matchAll(/<table\b[^>]*>[\s\S]*?<\/table>/gi)];
  for (const match of tables) {
    const rows = [...match[0].matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)].map(r=>cells(r[1]));
    const header = rows.find(r=>r.includes('IBIT') && r.includes('FBTC'));
    if (!header) continue;
    const tickers = header.filter(v=>v && v!=='Date' && v!=='Total');
    if (tickers.join(',')!==FUNDS.join(',')) return {status:'unrecognized_fund_schema',tickers};
    const recent = rows.filter(r=>/^\d{2} Oct 2026$/.test(r[0]||''));
    if (!recent.length) return {status:'no_research_window_rows',tickers};
    const observations = recent.map(r=>{
      if(r.length!==14) return {date:r[0],complete:false,reason:'unexpected_cell_count',cell_count:r.length};
      const flows = r.slice(1,-1).map(numeric), total = numeric(r.at(-1));
      const missing = FUNDS.filter((_,i)=>flows[i]===null);
      const complete = !missing.length && total!==null;
      const sum = complete ? flows.reduce((a,b)=>a+b,0) : null;
      return {date:r[0],complete,missing_funds:missing,total_present:total!==null,
        total_is_zero:total===0,total_matches_rounded_components:complete ? Math.abs(sum-total)<=0.65 : null,
        ...(r[0]==='07 Oct 2026'?{fund_flows_usd_millions:Object.fromEntries(FUNDS.map((f,i)=>[f,flows[i]])),total_usd_millions:total}: {})};
    });
    return {status:'diagnostic_only',tickers,observations,
      note:'Numeric completeness is not proof of final reporting, permission, freshness or issuer accuracy. Dashes remain missing.'};
  }
  return {status:'no_recognized_table'};
}
