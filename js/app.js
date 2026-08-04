document.querySelectorAll(".tab").forEach((button) => {
  button.addEventListener("click", () => {
    document.querySelectorAll(".tab").forEach((item) => item.classList.remove("active"));
    document.querySelectorAll(".page").forEach((item) => item.classList.remove("show"));

    button.classList.add("active");
    document.getElementById(button.dataset.page).classList.add("show");
  });
});
