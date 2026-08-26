if (window.eruda) {
  try {
    eruda.init({ theme: "Dark" });
    // НЕ показываем автоматически — управляется переключателем «Эрудит» в настройках.
    if (localStorage.getItem("erudite_enabled") === "1") {
      eruda.show();
    }
  } catch (e) {
    console.error("[eruda] init failed", e);
  }
}
