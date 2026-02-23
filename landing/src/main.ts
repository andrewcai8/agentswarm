/**
 * Longshot Landing — scroll-triggered fade-in animations.
 */

function initFadeObserver(): void {
  const targets = document.querySelectorAll<HTMLElement>(".fade-up");

  if (!targets.length) return;

  const observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (entry.isIntersecting) {
          entry.target.classList.add("is-visible");
          observer.unobserve(entry.target);
        }
      }
    },
    {
      threshold: 0.15,
      rootMargin: "0px 0px -40px 0px",
    }
  );

  for (const el of targets) {
    observer.observe(el);
  }
}

// Run on DOM ready
if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", initFadeObserver);
} else {
  initFadeObserver();
}
