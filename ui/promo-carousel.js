// PromoCarousel — home hero promo banner carousel (UNIMPLEMENTED_OPTIONS #15).
// Static slides come from promo-content.js; no backend. Auto-advance plus
// manual dot navigation, and prefers-reduced-motion aware: while the user
// asks for reduced motion there is no auto-advance and no slide motion
// (the CSS half lives in promo-carousel.css).
import { icon } from './icons.js';
import { promoSlides } from './promo-content.js';

const AUTO_ADVANCE_MS = 6000;

export function mountPromoCarousel(container, options = {}) {
  const host = typeof container === 'string'
    ? document.querySelector(container)
    : (container || document.getElementById('promoCarousel'));
  if (!host || host.dataset.promoCarouselMounted === 'true') return null;
  const slides = (options.slides?.length ? options.slides : promoSlides)
    .filter(slide => slide && slide.href && slide.title);
  if (!slides.length) return null;
  const reduced = typeof matchMedia === 'function'
    ? matchMedia('(prefers-reduced-motion: reduce)')
    : null;
  let index = 0;
  let timer = 0;
  let hovered = false;
  let focused = false;

  host.dataset.promoCarouselMounted = 'true';
  host.classList.add('promo-carousel');
  const slidesBox = document.createElement('div');
  slidesBox.className = 'promo-carousel-slides';
  slidesBox.innerHTML = slides.map((slide, i) => `
    <a class="promo-slide${i === 0 ? ' is-active' : ''}" data-slide="${i}" href="${slide.href}">
      <span class="promo-slide-ic" aria-hidden="true">${icon(slide.icon || 'brand')}</span>
      <span class="promo-slide-copy">
        <span class="promo-slide-line">${slide.badge ? `<span class="promo-slide-badge" dir="ltr">${slide.badge}</span>` : ''}<b class="promo-slide-title">${slide.title}</b></span>
        ${slide.subtitle ? `<small class="promo-slide-sub">${slide.subtitle}</small>` : ''}
      </span>
    </a>`).join('');
  const dots = document.createElement('nav');
  dots.className = 'promo-carousel-dots';
  dots.setAttribute('aria-label', 'شرائح ترويج Loam');
  if (slides.length < 2) dots.hidden = true;
  dots.innerHTML = slides.map((slide, i) =>
    `<button type="button" class="promo-dot" data-go="${i}" aria-current="${i === 0}" aria-label="${slide.title}"></button>`).join('');
  host.replaceChildren(slidesBox, dots);
  const slideEls = [...slidesBox.children];
  const dotEls = [...dots.children];

  function render() {
    slideEls.forEach((el, i) => el.classList.toggle('is-active', i === index));
    dotEls.forEach((el, i) => el.setAttribute('aria-current', String(i === index)));
  }
  function select(next) {
    index = ((next % slides.length) + slides.length) % slides.length;
    render();
  }
  function stopAuto() {
    if (timer) { clearInterval(timer); timer = 0; }
  }
  function startAuto() {
    stopAuto();
    if (slides.length < 2 || reduced?.matches || hovered || focused) return;
    timer = setInterval(() => select(index + 1), AUTO_ADVANCE_MS);
  }

  dots.addEventListener('click', event => {
    const button = event.target.closest('[data-go]');
    if (!button) return;
    select(Number(button.dataset.go));
    startAuto(); // a manual pick restarts the auto-advance window
  });
  // Reading or focusing the banner pauses auto-advance (carousel best practice).
  host.addEventListener('mouseenter', () => { hovered = true; stopAuto(); });
  host.addEventListener('mouseleave', () => { hovered = false; startAuto(); });
  host.addEventListener('focusin', () => { focused = true; stopAuto(); });
  host.addEventListener('focusout', event => {
    if (event.relatedTarget && host.contains(event.relatedTarget)) return;
    focused = false;
    startAuto();
  });
  if (reduced) reduced.addEventListener('change', () => (reduced.matches ? stopAuto() : startAuto()));
  startAuto();
  return {
    select,
    start: startAuto,
    stop: stopAuto,
    get index() { return index; },
    unmount() {
      stopAuto();
      host.replaceChildren();
      host.classList.remove('promo-carousel');
      delete host.dataset.promoCarouselMounted;
    },
  };
}

if (typeof document !== 'undefined') {
  const host = document.getElementById('promoCarousel');
  if (host) mountPromoCarousel(host);
}
