/**
 * @file ScreenSnap — Welcome / Onboarding Page v0.5.0
 * @description Shown once on first install via chrome.runtime.onInstalled.
 * Provides a multi-slide onboarding experience with keyboard navigation.
 * @version 0.5.0
 */

(() => {
  'use strict';

  /** @type {number} Total number of onboarding slides */
  const TOTAL_SLIDES = 4;

  /** @type {number} Currently visible slide index */
  let currentSlide = 0;

  // ── DOM Refs ──
  const slides = document.querySelectorAll('.slide');
  const dots = document.querySelectorAll('.dot');
  const btnPrev = document.getElementById('btn-prev');
  const btnNext = document.getElementById('btn-next');

  /**
   * Navigate to a specific slide by index.
   * @param {number} index - Target slide index (0-based)
   */
  function goToSlide(index) {
    if (index < 0 || index >= TOTAL_SLIDES) return;
    currentSlide = index;

    slides.forEach(s => s.classList.remove('active'));
    dots.forEach(d => {
      d.classList.remove('active');
      d.setAttribute('aria-current', 'false');
    });

    slides[index].classList.add('active');
    dots[index].classList.add('active');
    dots[index].setAttribute('aria-current', 'true');

    // Show/hide nav buttons
    btnPrev.style.visibility = index === 0 ? 'hidden' : 'visible';

    if (index === TOTAL_SLIDES - 1) {
      btnNext.textContent = '\uD83D\uDE80 Get Started';
      btnNext.className = 'btn btn-success';
      btnNext.setAttribute('aria-label', 'Complete setup and get started');
    } else {
      btnNext.textContent = 'Next \u2192';
      btnNext.className = 'btn btn-primary';
      btnNext.setAttribute('aria-label', 'Go to next slide');
    }
  }

  // ── Navigation ──────────────────────────────────

  btnNext.addEventListener('click', () => {
    if (currentSlide === TOTAL_SLIDES - 1) {
      chrome.storage.local.set({ onboardingComplete: true }, () => {
        window.close();
      });
    } else {
      goToSlide(currentSlide + 1);
    }
  });

  btnPrev.addEventListener('click', () => {
    goToSlide(currentSlide - 1);
  });

  // Dot navigation
  dots.forEach(dot => {
    dot.setAttribute('role', 'tab');
    dot.setAttribute('aria-label', `Go to slide ${parseInt(dot.dataset.slide, 10) + 1}`);
    dot.addEventListener('click', () => {
      goToSlide(parseInt(dot.dataset.slide, 10));
    });
  });

  // Keyboard navigation
  document.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowRight' || e.key === ' ') {
      e.preventDefault();
      if (currentSlide < TOTAL_SLIDES - 1) goToSlide(currentSlide + 1);
    } else if (e.key === 'ArrowLeft') {
      e.preventDefault();
      goToSlide(currentSlide - 1);
    } else if (e.key === 'Enter') {
      btnNext.click();
    }
  });
})();
