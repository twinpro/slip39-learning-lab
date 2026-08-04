
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
  const defaultNames=Array.from({length:21},(_,i)=>`Investor ${i+1}`);
  let investorNames=loadInvestorNames();
  function loadInvestorNames(){
    try{const saved=JSON.parse(localStorage.getItem("slip39InvestorNames"));if(Array.isArray(saved)&&saved.length===21)return saved.map((x,i)=>String(x||defaultNames[i]));}catch(e){}
    return [...defaultNames];
  }
  const gneed=document.getElementById("groupNeed"),mneed=document.getElementById("memberNeed"),status=document.getElementById("llcStatus"),detail=document.getElementById("llcDetail");
  function render(){
    let valid=0;grid.innerHTML="";
    for(let g=0;g<7;g++){
      const start=g*3,count=active.slice(start,start+3).filter(Boolean).length,ok=count>=Number(mneed.value);if(ok)valid++;
      const box=document.createElement("div");box.className="group "+(ok?"ok":"bad");
      box.innerHTML=`<h3>Group ${String.fromCharCode(65+g)}</h3><p class="muted">${count}/3 available · ${ok?"qualifies":"does not qualify"}</p>`;
      for(let i=start;i<start+3;i++){const d=document.createElement("div");d.className="member "+(active[i]?"on":"off");d.innerHTML=`<span>${escapeHtml(investorNames[i])}</span><span class="pill">${active[i]?"available":"unavailable"}</span>`;d.onclick=()=>{active[i]=!active[i];render()};box.appendChild(d)}
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

function escapeHtml(value){
  return String(value).replace(/[&<>"']/g,(ch)=>({"&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#039;"}[ch]));
}

function setupAdminMode(){
  const modal=document.getElementById("adminModal");
  if(!modal)return;

  const openBtn=document.getElementById("openAdmin");
  const closeBtn=document.getElementById("closeAdmin");
  const grid=document.getElementById("adminNames");
  const message=document.getElementById("adminMessage");

  const defaults=Array.from({length:21},(_,i)=>`Investor ${i+1}`);

  function getNames(){
    try{
      const saved=JSON.parse(localStorage.getItem("slip39InvestorNames"));
      if(Array.isArray(saved)&&saved.length===21)return saved.map((x,i)=>String(x||defaults[i]));
    }catch(e){}
    return [...defaults];
  }

  function renderFields(){
    const names=getNames();
    grid.innerHTML="";
    names.forEach((name,index)=>{
      const wrap=document.createElement("div");
      wrap.className="admin-field";
      wrap.innerHTML=`<label>Investor ${index+1}</label><input maxlength="60" data-name-index="${index}" value="${escapeHtml(name)}">`;
      grid.appendChild(wrap);
    });
  }

  function open(){
    renderFields();
    message.textContent="";
    modal.classList.add("open");
    modal.setAttribute("aria-hidden","false");
  }

  function close(){
    modal.classList.remove("open");
    modal.setAttribute("aria-hidden","true");
  }

  openBtn?.addEventListener("click",open);
  closeBtn?.addEventListener("click",close);
  modal.addEventListener("click",(e)=>{if(e.target===modal)close()});

  document.getElementById("saveAdminNames")?.addEventListener("click",()=>{
    const names=[...grid.querySelectorAll("input[data-name-index]")].map((input,i)=>input.value.trim()||defaults[i]);
    localStorage.setItem("slip39InvestorNames",JSON.stringify(names));
    message.textContent="Saved locally in this browser.";
    location.reload();
  });

  document.getElementById("resetAdminNames")?.addEventListener("click",()=>{
    localStorage.removeItem("slip39InvestorNames");
    renderFields();
    message.textContent="Names reset to Investor 1–21.";
  });

  document.getElementById("exportAdminNames")?.addEventListener("click",()=>{
    const names=[...grid.querySelectorAll("input[data-name-index]")].map((input,i)=>input.value.trim()||defaults[i]);
    const blob=new Blob([JSON.stringify({version:1,names},null,2)],{type:"application/json"});
    const url=URL.createObjectURL(blob);
    const a=document.createElement("a");
    a.href=url;a.download="slip39-investor-labels.json";a.click();
    URL.revokeObjectURL(url);
    message.textContent="JSON exported. It contains only the labels shown here.";
  });

  document.getElementById("importAdminNames")?.addEventListener("change",(event)=>{
    const file=event.target.files?.[0];
    if(!file)return;
    const reader=new FileReader();
    reader.onload=()=>{
      try{
        const data=JSON.parse(reader.result);
        const names=Array.isArray(data)?data:data.names;
        if(!Array.isArray(names)||names.length!==21)throw new Error("Expected exactly 21 names.");
        localStorage.setItem("slip39InvestorNames",JSON.stringify(names.map((x,i)=>String(x||defaults[i]))));
        renderFields();
        message.textContent="Imported and saved locally.";
      }catch(error){
        message.textContent="Import failed: "+error.message;
      }
    };
    reader.readAsText(file);
    event.target.value="";
  });
}

document.addEventListener("DOMContentLoaded",()=>{setupSimple();setupLLC();setupAdminMode()});

