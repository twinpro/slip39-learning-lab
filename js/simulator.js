let simpleShares = Array(5).fill(true);
let investors = Array(21).fill(true);

function renderSimple() {
  const need = Number(document.getElementById("simpleNeed").value);
  const available = simpleShares.filter(Boolean).length;
  const possible = available >= need;

  const status = document.getElementById("simpleStatus");
  status.className = "status " + (possible ? "ok" : "bad");
  status.textContent = possible
    ? `RECOVERY POSSIBLE — ${available} available, ${need} needed`
    : `RECOVERY FAILS — ${available} available, ${need} needed`;

  const grid = document.getElementById("simpleGrid");
  grid.innerHTML = "";

  simpleShares.forEach((isAvailable, index) => {
    const item = document.createElement("div");
    item.className = "member " + (isAvailable ? "on" : "off");
    item.innerHTML = `
      <span>Share ${index + 1}</span>
      <span class="pill">${isAvailable ? "available" : "missing"}</span>
    `;
    item.addEventListener("click", () => {
      simpleShares[index] = !simpleShares[index];
      renderSimple();
    });
    grid.appendChild(item);
  });
}

function renderInvestors() {
  const groupsNeeded = Number(document.getElementById("groupNeed").value);
  const membersNeeded = Number(document.getElementById("memberNeed").value);

  let qualifyingGroups = 0;
  const grid = document.getElementById("groupsGrid");
  grid.innerHTML = "";

  for (let groupIndex = 0; groupIndex < 7; groupIndex += 1) {
    const start = groupIndex * 3;
    const availableCount = investors.slice(start, start + 3).filter(Boolean).length;
    const qualifies = availableCount >= membersNeeded;

    if (qualifies) qualifyingGroups += 1;

    const group = document.createElement("article");
    group.className = "group " + (qualifies ? "ok" : "bad");
    group.innerHTML = `
      <h3>Group ${String.fromCharCode(65 + groupIndex)}</h3>
      <p class="muted">${availableCount}/3 available · ${qualifies ? "qualifies" : "does not qualify"}</p>
    `;

    for (let investorIndex = start; investorIndex < start + 3; investorIndex += 1) {
      const person = document.createElement("div");
      person.className = "member " + (investors[investorIndex] ? "on" : "off");
      person.innerHTML = `
        <span>Investor ${investorIndex + 1}</span>
        <span class="pill">${investors[investorIndex] ? "available" : "unavailable"}</span>
      `;
      person.addEventListener("click", () => {
        investors[investorIndex] = !investors[investorIndex];
        renderInvestors();
      });
      group.appendChild(person);
    }

    grid.appendChild(group);
  }

  const possible = qualifyingGroups >= groupsNeeded;
  const status = document.getElementById("llcStatus");
  status.className = "status " + (possible ? "ok" : "bad");
  status.textContent = possible ? "RECOVERY POSSIBLE" : "RECOVERY NOT POSSIBLE";

  document.getElementById("llcDetail").textContent =
    `${qualifyingGroups} of 7 groups qualify. Need ${groupsNeeded}. Each qualifying group needs ${membersNeeded} of 3 people.`;

  document.getElementById("groupProgress").style.width =
    `${(qualifyingGroups / 7) * 100}%`;
}

function activateAllInvestors() {
  investors = Array(21).fill(true);
  renderInvestors();
}

function loseOnePerGroup() {
  investors = Array(21).fill(true);
  for (let groupIndex = 0; groupIndex < 7; groupIndex += 1) {
    investors[groupIndex * 3] = false;
  }
  renderInvestors();
}

function loseTwoGroups() {
  investors = Array(21).fill(true);
  for (let index = 0; index < 6; index += 1) {
    investors[index] = false;
  }
  renderInvestors();
}

function loseThreeGroups() {
  investors = Array(21).fill(true);
  for (let index = 0; index < 9; index += 1) {
    investors[index] = false;
  }
  renderInvestors();
}

function randomizeInvestors() {
  investors = investors.map(() => Math.random() > 0.35);
  renderInvestors();
}

function openScenario(type) {
  document.querySelector('[data-page="llc"]').click();

  if (type === "one") loseOnePerGroup();
  if (type === "two") loseTwoGroups();
  if (type === "three") loseThreeGroups();
}

document.getElementById("activateSimple").addEventListener("click", () => {
  simpleShares = Array(5).fill(true);
  renderSimple();
});

document.getElementById("removeSimple").addEventListener("click", () => {
  simpleShares = Array(5).fill(false);
  renderSimple();
});

document.getElementById("simpleNeed").addEventListener("change", renderSimple);
document.getElementById("groupNeed").addEventListener("change", renderInvestors);
document.getElementById("memberNeed").addEventListener("change", renderInvestors);

document.getElementById("activateAll").addEventListener("click", activateAllInvestors);
document.getElementById("loseOne").addEventListener("click", loseOnePerGroup);
document.getElementById("loseTwo").addEventListener("click", loseTwoGroups);
document.getElementById("loseThree").addEventListener("click", loseThreeGroups);
document.getElementById("randomize").addEventListener("click", randomizeInvestors);

document.querySelectorAll(".scenario").forEach((button) => {
  button.addEventListener("click", () => openScenario(button.dataset.scenario));
});

renderSimple();
renderInvestors();
