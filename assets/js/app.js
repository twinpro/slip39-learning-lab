
(function(){
  const root=document.documentElement;
  const saved=localStorage.getItem("theme");
  if(saved) root.dataset.theme=saved;

  document.querySelectorAll("[data-theme-toggle]").forEach(btn=>{
    btn.addEventListener("click",()=>{
      const next=root.dataset.theme==="light"?"dark":"light";
      root.dataset.theme=next;
      localStorage.setItem("theme",next);
    });
  });

  document.querySelectorAll("[data-menu-toggle]").forEach(btn=>{
    btn.addEventListener("click",()=>document.querySelector(".sidebar")?.classList.toggle("open"));
  });

  const input=document.querySelector("[data-search]");
  const box=document.querySelector("[data-search-results]");
  if(input&&box&&window.SEARCH_INDEX){
    input.addEventListener("input",()=>{
      const q=input.value.trim().toLowerCase();
      if(!q){box.classList.remove("show");box.innerHTML="";return;}
      const base=document.body.dataset.base||"";
      const results=window.SEARCH_INDEX.filter(x=>(x.title+" "+x.text).toLowerCase().includes(q)).slice(0,10);
      box.innerHTML=results.length?results.map(x=>`<a class="search-item" href="${base}${x.url}"><strong>${x.title}</strong><small>${x.text}</small></a>`).join(""):`<div class="search-item">No matches</div>`;
      box.classList.add("show");
    });
    document.addEventListener("click",e=>{if(!e.target.closest(".search-wrap"))box.classList.remove("show")});
  }
})();
