document.getElementById("gradeQuiz").addEventListener("click", () => {
  let score = 0;

  ["q1", "q2", "q3"].forEach((question) => {
    const selected = document.querySelector(`input[name="${question}"]:checked`);
    if (selected && selected.value === "1") score += 1;
  });

  const result = document.getElementById("quizResult");
  result.textContent =
    `Score: ${score}/3` +
    (score === 3
      ? " — You understand the core concepts."
      : " — Review the lessons and try again.");

  result.style.color = score === 3 ? "#86efac" : "#fde68a";
});
