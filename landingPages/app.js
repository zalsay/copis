const commandDialog = document.querySelector('#command-dialog');
const taskInput = document.querySelector('#task-input');
const taskToast = document.querySelector('#task-toast');
const authDialog = document.querySelector('#auth-dialog');
const authForm = document.querySelector('#auth-form');
const authAccount = document.querySelector('#auth-account');
const authPassword = document.querySelector('#auth-password');
const authDialogKicker = document.querySelector('#auth-dialog-kicker');
const authDialogTitle = document.querySelector('#auth-dialog-title');
const authSubmit = document.querySelector('#auth-submit');
const carousel = document.querySelector('[data-workflow-carousel]');

let toastTimer;
let lastCommandTrigger;
let lastAuthTrigger;
let authMode = '登录';

document.querySelectorAll('[data-open-command]').forEach((button) => {
  button.addEventListener('click', () => {
    lastCommandTrigger = button;
    commandDialog.showModal();
    window.setTimeout(() => taskInput.focus(), 0);
  });
});

commandDialog.addEventListener('close', () => lastCommandTrigger?.focus());

document.querySelector('#submit-task').addEventListener('click', (event) => {
  if (!taskInput.value.trim()) {
    event.preventDefault();
    taskInput.setCustomValidity('请先写下一个任务。');
    taskInput.reportValidity();
    return;
  }

  taskInput.setCustomValidity('');
  showToast('任务已准备好。打开 Copis 后即可继续。');
});

taskInput.addEventListener('input', () => taskInput.setCustomValidity(''));

document.querySelectorAll('[data-open-auth]').forEach((button) => {
  button.addEventListener('click', () => {
    lastAuthTrigger = button;
    setAuthMode(button.dataset.openAuth);
    authForm.reset();
    authDialog.showModal();
    window.setTimeout(() => authAccount.focus(), 0);
  });
});

document.querySelectorAll('[data-close-auth]').forEach((button) => {
  button.addEventListener('click', () => authDialog.close());
});

authDialog.addEventListener('close', () => lastAuthTrigger?.focus());

authForm.addEventListener('submit', (event) => {
  event.preventDefault();
  if (!authForm.checkValidity()) {
    authForm.reportValidity();
    return;
  }

  authDialog.close();
  showToast(`${authMode}信息已填写，接入账号服务后即可继续。`);
});

function setAuthMode(mode) {
  authMode = mode === '注册' ? '注册' : '登录';
  const isRegister = authMode === '注册';
  authDialogKicker.textContent = isRegister ? '创建你的工作台' : '欢迎回来';
  authDialogTitle.textContent = `${authMode} Copis`;
  authSubmit.textContent = authMode;
  authPassword.autocomplete = isRegister ? 'new-password' : 'current-password';
}

if (carousel) {
  const track = carousel.querySelector('#workflow-carousel-track');
  const slides = [...carousel.querySelectorAll('.workflow-slide')];
  const dots = [...carousel.querySelectorAll('[data-carousel-dot]')];
  const count = carousel.querySelector('#carousel-count');
  const caption = carousel.querySelector('#carousel-caption');
  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  let activeSlide = 0;
  let autoplayTimer;

  const selectSlide = (index) => {
    activeSlide = (index + slides.length) % slides.length;
    track.style.transform = `translateX(-${activeSlide * 100}%)`;
    count.textContent = `${String(activeSlide + 1).padStart(2, '0')} / ${String(slides.length).padStart(2, '0')}`;
    caption.textContent = slides[activeSlide].dataset.slideTitle;
    slides.forEach((slide, slideIndex) => {
      const selected = slideIndex === activeSlide;
      slide.setAttribute('aria-hidden', String(!selected));
      slide.inert = !selected;
    });
    dots.forEach((dot, dotIndex) => {
      const selected = dotIndex === activeSlide;
      dot.classList.toggle('active', selected);
      dot.setAttribute('aria-pressed', String(selected));
    });
  };

  const pauseAutoplay = () => window.clearInterval(autoplayTimer);
  const startAutoplay = () => {
    if (reduceMotion) return;
    pauseAutoplay();
    autoplayTimer = window.setInterval(() => selectSlide(activeSlide + 1), 6500);
  };

  carousel.querySelectorAll('[data-carousel-step]').forEach((button) => {
    button.addEventListener('click', () => {
      selectSlide(activeSlide + Number(button.dataset.carouselStep));
      startAutoplay();
    });
  });

  dots.forEach((dot) => {
    dot.addEventListener('click', () => {
      selectSlide(Number(dot.dataset.carouselDot));
      startAutoplay();
    });
  });

  carousel.addEventListener('mouseenter', pauseAutoplay);
  carousel.addEventListener('mouseleave', startAutoplay);
  carousel.addEventListener('focusin', pauseAutoplay);
  carousel.addEventListener('focusout', (event) => {
    if (!carousel.contains(event.relatedTarget)) startAutoplay();
  });
  carousel.addEventListener('keydown', (event) => {
    if (event.key === 'ArrowLeft') selectSlide(activeSlide - 1);
    if (event.key === 'ArrowRight') selectSlide(activeSlide + 1);
  });

  startAutoplay();
}

function showToast(message) {
  taskToast.textContent = message;
  taskToast.classList.add('is-visible');
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => taskToast.classList.remove('is-visible'), 3600);
}
