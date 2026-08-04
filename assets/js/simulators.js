
function setupSimple(){
  const grid=document.getElementById("simpleGrid"); if(!grid) return;
  let shares=Array(5).fill(true);
  const need=document.getElementById("simpleNeed"), status=document.getElementById("simpleStatus");
  function render(){
    const n=Number(need.value), have=shares.filter(Boolean).length, ok=have>=n;
    status.className="status "+(ok?"ok":"bad");
    status.textContent=ok?`RECOVERY POSSIBLE — ${have} available, ${n} needed`:`RECOVERY FAILS — ${have} available, ${n} needed`;
    grid.innerHTML="";
    shares.forEach((v,i)=>{
      const d=document.createElement("div"); d.className="member "+(v?"on":"off");
      d.innerHTML=`<span>Share ${i+1}</span><span class="pill">${v?"available":"missing"}</span>`;
      d.onclick=()=>{shares[i]=!shares[i];render()}; grid.appendChild(d);
    });
  }
  document.getElementById("simpleAll").onclick=()=>{shares=Array(5).fill(true);render()};
  document.getElementById("simpleNone").onclick=()=>{shares=Array(5).fill(false);render()};
  need.onchange=render; render();
}

function setupLLC(){
  const grid=document.getElementById("groupsGrid"); if(!grid) return;
  let active=Array(21).fill(true);
  const gneed=document.getElementById("groupNeed"),mneed=document.getElementById("memberNeed"),status=document.getElementById("llcStatus"),detail=document.getElementById("llcDetail");
  function render(){
    let valid=0;grid.innerHTML="";
    for(let g=0;g<7;g++){
      const start=g*3,count=active.slice(start,start+3).filter(Boolean).length,ok=count>=Number(mneed.value);if(ok)valid++;
      const box=document.createElement("div");box.className="group "+(ok?"ok":"bad");
      box.innerHTML=`<h3>Group ${String.fromCharCode(65+g)}</h3><p class="muted">${count}/3 available · ${ok?"qualifies":"does not qualify"}</p>`;
      for(let i=start;i<start+3;i++){const d=document.createElement("div");d.className="member "+(active[i]?"on":"off");d.innerHTML=`<span>Investor ${i+1}</span><span class="pill">${active[i]?"available":"unavailable"}</span>`;d.onclick=()=>{active[i]=!active[i];render()};box.appendChild(d)}
      grid.appendChild(box);
    }
    const ok=valid>=Number(gneed.value);status.className="status "+(ok?"ok":"bad");status.textContent=ok?"RECOVERY POSSIBLE":"RECOVERY NOT POSSIBLE";
    detail.textContent=`${valid} of 7 groups qualify. Need ${gneed.value}. Each qualifying group needs ${mneed.value} of 3 people.`;
  }
  document.getElementById("all21").onclick=()=>{active=Array(21).fill(true);render()};
  document.getElementById("oneEach").onclick=()=>{active=Array(21).fill(true);for(let g=0;g<7;g++)active[g*3]=false;render()};
  document.getElementById("twoGroups").onclick=()=>{active=Array(21).fill(true);for(let i=0;i<6;i++)active[i]=false;render()};
  document.getElementById("threeGroups").onclick=()=>{active=Array(21).fill(true);for(let i=0;i<9;i++)active[i]=false;render()};
  document.getElementById("random21").onclick=()=>{active=active.map(()=>Math.random()>.35);render()};
  gneed.onchange=render;mneed.onchange=render;render();
}
document.addEventListener("DOMContentLoaded",()=>{setupSimple();setupLLC()});
