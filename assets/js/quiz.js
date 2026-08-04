
document.addEventListener("DOMContentLoaded",()=>{
 const btn=document.getElementById("gradeQuiz");if(!btn)return;
 btn.onclick=()=>{
   let score=0,total=6;
   for(let i=1;i<=total;i++){const x=document.querySelector(`input[name="q${i}"]:checked`);if(x&&x.value==="1")score++}
   const r=document.getElementById("quizResult");r.textContent=`Score: ${score}/${total}`+(score===total?" — Excellent.":" — Review the missed topics and try again.");r.style.color=score===total?"var(--ok)":"var(--warn)";
 };
});
