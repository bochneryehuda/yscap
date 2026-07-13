/* ===========================================================
   YS CAPITAL GROUP — interactions
   =========================================================== */
(function () {
  "use strict";

  const $  = (s, c = document) => c.querySelector(s);
  const $$ = (s, c = document) => Array.from(c.querySelectorAll(s));
  const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  document.addEventListener("DOMContentLoaded", () => {
    nav();
    revealOnScroll();
    countUp();
    marquee("offer-track", 0.4);
    marquee("review-track", 0.5);
    cardGlow();
    dscrCalc();
    floatApply();
  });

  /* ---- nav: scrolled state + mobile toggle ---- */
  function nav() {
    const bar = $("#nav");
    const toggle = $("#navToggle");
    const onScroll = () => bar.classList.toggle("scrolled", window.scrollY > 24);
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });

    if (toggle) toggle.addEventListener("click", () => bar.classList.toggle("open"));
    $$("#navMobile a").forEach(a =>
      a.addEventListener("click", () => bar.classList.remove("open"))
    );
  }

  /* ---- scroll reveal ---- */
  function revealOnScroll() {
    const els = $$(".reveal-up");
    if (reduce || !("IntersectionObserver" in window)) {
      els.forEach(e => e.classList.add("in"));
      return;
    }
    const io = new IntersectionObserver((entries) => {
      entries.forEach(en => {
        if (en.isIntersecting) { en.target.classList.add("in"); io.unobserve(en.target); }
      });
    }, { threshold: 0.12, rootMargin: "0px 0px -8% 0px" });
    els.forEach(e => io.observe(e));
  }

  /* ---- hero stat count-up ---- */
  function countUp() {
    const nums = $$(".stat-num[data-count]");
    if (!nums.length) return;
    const run = (el) => {
      const raw = String(el.dataset.count);
      const target = parseFloat(raw);
      const decimals = (raw.split(".")[1] || "").length;
      const fmt = (v) => decimals ? v.toFixed(decimals) : String(Math.round(v));
      const pre = el.dataset.prefix || "";
      const suf = el.dataset.suffix || "";
      if (reduce) { el.textContent = pre + fmt(target) + suf; return; }
      const dur = 1400, t0 = performance.now();
      const tick = (t) => {
        const p = Math.min((t - t0) / dur, 1);
        const eased = 1 - Math.pow(1 - p, 3);
        el.textContent = pre + fmt(target * eased) + suf;
        if (p < 1) requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    };
    const io = new IntersectionObserver((entries) => {
      entries.forEach(en => { if (en.isIntersecting) { run(en.target); io.unobserve(en.target); } });
    }, { threshold: 0.5 });
    nums.forEach(n => io.observe(n));
  }

  /* ---- seamless marquee (rAF, pause on hover/touch) ---- */
  function marquee(id, speed) {
    const track = document.getElementById(id);
    if (!track) return;

    // duplicate until track is at least 2x viewport, for a seamless loop
    const original = track.innerHTML;
    track.innerHTML = original + original + original;
    let half = track.scrollWidth / 3;

    let offset = 0, paused = false, resumeT;
    const pause = () => { paused = true; clearTimeout(resumeT); };
    const resume = () => { resumeT = setTimeout(() => (paused = false), 900); };

    ["mouseenter", "touchstart"].forEach(e => track.addEventListener(e, pause, { passive: true }));
    ["mouseleave", "touchend"].forEach(e => track.addEventListener(e, resume, { passive: true }));
    window.addEventListener("resize", () => { half = track.scrollWidth / 3; });

    function loop() {
      if (!paused && !reduce) {
        offset += speed;
        if (offset >= half) offset -= half;
        track.style.transform = `translate3d(${-offset}px,0,0)`;
      }
      requestAnimationFrame(loop);
    }
    loop();
  }

  /* ---- pointer-follow glow on program cards ---- */
  function cardGlow() {
    if (reduce) return;
    $$(".prog-card, .value-card, .hl-card, .contact-card, .member").forEach(card => {
      card.addEventListener("pointermove", (e) => {
        const r = card.getBoundingClientRect();
        card.style.setProperty("--mx", `${e.clientX - r.left}px`);
        card.style.setProperty("--my", `${e.clientY - r.top}px`);
      });
    });
  }

  /* ---- DSCR quick calculator ---- */
  function dscrCalc() {
    const rent = $("#rent");
    const piti = $("#piti");
    if (!rent || !piti) return;
    const valEl = $("#dscrValue");
    const verdictEl = $("#calcVerdict");
    const fillEl = $("#calcFill");

    const fmt = (n) => n.toLocaleString("en-US", { maximumFractionDigits: 2, minimumFractionDigits: 2 });

    function update() {
      const r = parseFloat(rent.value) || 0;
      const p = parseFloat(piti.value) || 0;

      if (p <= 0) {
        valEl.textContent = "—";
        verdictEl.textContent = "Enter your monthly debt to calculate";
        verdictEl.style.color = "var(--muted)";
        valEl.style.color = "var(--muted)";
        fillEl.style.width = "0%";
        return;
      }

      const dscr = r / p;
      valEl.textContent = fmt(dscr);

      // meter: map 0.6x–1.6x to 0–100%
      const pct = Math.max(0, Math.min(100, ((dscr - 0.6) / (1.6 - 0.6)) * 100));
      fillEl.style.width = pct + "%";

      let label, color, grad;
      if (dscr >= 1.25)      { label = "Strong — at or above 1.25×";        color = "var(--teal-br)"; grad = "linear-gradient(90deg,var(--teal-dp),var(--teal-br))"; }
      else if (dscr >= 1.0)  { label = "Qualifying range — 1.0× and above";  color = "var(--teal)";    grad = "linear-gradient(90deg,var(--teal-dp),var(--teal))"; }
      else if (dscr >= 0.75) { label = "Below 1.0× — ask about No-Ratio DSCR"; color = "var(--gold)";  grad = "linear-gradient(90deg,#8a7740,var(--gold))"; }
      else                   { label = "Low ratio — let's structure it together"; color = "var(--gold)"; grad = "linear-gradient(90deg,#8a7740,var(--gold))"; }

      verdictEl.textContent = label;
      verdictEl.style.color = color;
      valEl.style.color = color;
      fillEl.style.background = grad;
    }

    rent.addEventListener("input", update);
    piti.addEventListener("input", update);
    update();
  }

  /* ---- floating apply button appears after hero ---- */
  function floatApply() {
    const grp = $(".float-actions") || $(".float-apply");
    if (grp) {
      const onScroll = () => grp.classList.toggle("show", window.scrollY > 700);
      window.addEventListener("scroll", onScroll, { passive: true });
      onScroll();
    }
    // Floating contact popup (WhatsApp / Call / Email)
    const cbtn = $("#floatContact"), pop = $("#contactPop");
    if (cbtn && pop) {
      const openPop = () => { pop.classList.add("open"); pop.setAttribute("aria-hidden", "false"); cbtn.setAttribute("aria-expanded", "true"); };
      const closePop = () => { pop.classList.remove("open"); pop.setAttribute("aria-hidden", "true"); cbtn.setAttribute("aria-expanded", "false"); };
      cbtn.addEventListener("click", (e) => { e.preventDefault(); e.stopPropagation(); pop.classList.contains("open") ? closePop() : openPop(); });
      const xb = $("#contactPopClose"); if (xb) xb.addEventListener("click", (e) => { e.preventDefault(); closePop(); });
      pop.addEventListener("click", (e) => { if (e.target.closest(".cpop-item")) closePop(); });
      document.addEventListener("click", (e) => { if (pop.classList.contains("open") && !pop.contains(e.target) && !cbtn.contains(e.target)) closePop(); });
      document.addEventListener("keydown", (e) => { if (e.key === "Escape") closePop(); });
    }
  }
})();
