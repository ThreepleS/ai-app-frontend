if (window.eruda) {
  try {
    eruda.init();
    eruda.show();
  } catch (e) {
    console.error("[eruda] init failed", e);
  }
}
